// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ILmnsStaking} from "./interfaces/ILmnsStaking.sol";
import {IPriceReference} from "./interfaces/IPriceReference.sol";
import {IHedgeAdapter} from "./interfaces/IHedgeAdapter.sol";

/// @title LmnsStaking
/// @notice Staked $LMNS: the Writer Pool's second loss layer (spec 2.6), fee tiers for traders, and the recipient of
/// the FeeRouter's stakers bucket (spec 2.8). Phase 2: deployed once the launchpad token exists; until the pool and
/// the engine are pointed at it, nothing reads it.
/// @dev Rules (todo 20):
///  - The $LMNS token is NOT issued here (R1). Its address is a constructor parameter; this contract never mints.
///  - Stakes are shares of one LMNS balance (`totalAssets`, tracked, not read from balanceOf, so a donation cannot move
///    the share price). A slash lowers `totalAssets`, so every share loses the same fraction: active stakes and
///    stakes waiting out the unstake delay alike (R2, R3).
///  - Unstake: request, wait `UNSTAKE_DELAY` (deploy-time, hard minimum MIN_UNSTAKE_DELAY; 14 days on mainnet and
///    fork), complete; or cancel back to active (R2).
///  - `slash` is callable by the pool only (no guardian, no admin path). It sells staked LMNS for USDG through the
///    configured route with the output floored at the TWAP less the slippage allowance, capped by the stake, and
///    sends the USDG to the pool. A missing or failing route returns 0 and never reverts (R3).
///  - USDG that reaches this contract (the FeeRouter's stakers bucket) is streamed over `REWARD_DURATION` to ACTIVE
///    shares with the standard per-share accumulator, so it accrues per second staked: a stake made after a transfer
///    only earns from that second on, and claiming needs `MIN_CLAIM_AGE` since the account's last stake (R5).
///  - Fee tiers: the highest tier whose `minStake` the account's active stake reaches; discounts are bounded
///    (MAX_FEE_DISCOUNT_BPS of the fee, MAX_SPREAD_DISCOUNT_BPS of the spread) (R4).
contract LmnsStaking is AccessControl, ReentrancyGuardTransient, ILmnsStaking {
    using SafeERC20 for IERC20;

    uint256 private constant BPS = 10_000;
    /// @dev Reward per share scale (USDG 6 dp per 18 dp share) and reward rate scale.
    uint256 private constant ACC = 1e36;
    uint256 private constant RATE = 1e18;
    /// @dev WAD USD per whole 18-dp token -> USDG 6 dp: value = amount x price / 1e30.
    uint256 private constant PRICE_TO_USDG = 1e30;

    uint256 public constant MIN_UNSTAKE_DELAY = 5 minutes;
    uint256 public constant MAX_UNSTAKE_DELAY = 60 days;
    uint256 public constant MIN_REWARD_DURATION = 5 minutes;
    uint256 public constant MAX_REWARD_DURATION = 30 days;
    uint256 public constant MIN_CLAIM_AGE_FLOOR = 1 minutes;
    uint256 public constant MAX_CLAIM_AGE = 30 days;
    uint16 public constant MAX_FEE_DISCOUNT_BPS = 5_000;
    uint16 public constant MAX_SPREAD_DISCOUNT_BPS = 2_000;
    uint16 public constant MAX_SLIPPAGE_BPS = 2_000;
    uint256 public constant MAX_TIERS = 4;
    /// @notice A slash always leaves at least totalShares / this LMNS wei, so the share price can never reach zero and
    /// repeated wipe-outs cannot inflate share counts without bound (at most 1e12 shares per LMNS wei).
    uint256 public constant MAX_SHARES_PER_ASSET = 1e12;
    /// @notice Smallest new USDG amount that (re)starts the reward stream (stops dust from stretching it).
    uint256 public constant MIN_REWARD_SYNC = 1e6;
    /// @notice F37: a slash runs only while the LMNS pool's spot price is within this band of its TWAP.
    uint256 public constant SPOT_BAND_BPS = 50;

    event CoverCapSet(uint256 capUsdg);
    event LossSynced(uint256 stakeLossUsdg, uint256 lockedLmns);

    IERC20 public immutable token;
    IERC20 public immutable usdg;
    address public immutable override pool;
    /// @notice Delay between an unstake request and its completion (14 days on mainnet and fork, minutes on testnet).
    uint256 public immutable UNSTAKE_DELAY;
    /// @notice Each USDG arrival is streamed over this period (the FeeRouter period).
    uint256 public immutable REWARD_DURATION;
    /// @notice Time since an account's last stake before it may claim rewards.
    uint256 public immutable MIN_CLAIM_AGE;

    IPriceReference public priceSource;
    IHedgeAdapter public swapAdapter;
    uint24 public poolFee;
    uint16 public slippageBps = 300;
    /// @notice F18: the most cover (USDG 6 dp) the pool may count, set by the admin from the measured depth of the
    /// LMNS/USDG pool (what one slash can sell inside the slippage floor). 0 = no cover counted (the default).
    uint256 public coverCapUsdg;
    /// @notice F19: LMNS set aside for a loss the pool already counts against the stake (its reserve share beyond the
    /// Reserve). Out of `totalAssets`, so stakers who leave, and stakers who join, do so at the post-loss share price;
    /// slashes sell it first; it returns to the stakers when the loss recovers.
    uint256 public lockedForPool;

    uint256 public totalShares;
    /// @notice LMNS backing all shares (active and requested).
    uint256 public totalAssets;
    /// @notice Shares not in an unstake request: the reward weight.
    uint256 public activeShares;
    mapping(address account => uint256 shares) public sharesOf;

    struct Request {
        uint256 shares;
        uint64 readyAt;
    }

    mapping(address account => Request) public requests;
    mapping(address account => uint64 timestamp) public lastStakeAt;

    uint256 public rewardPerShare;
    uint256 public rewardRate;
    uint64 public periodFinish;
    uint64 public lastUpdate;
    /// @notice USDG promised: the rest of the stream plus what accounts are owed. Balance above this is new.
    uint256 public committed;
    mapping(address account => uint256) public rewardPerSharePaid;
    mapping(address account => uint256) public owed;

    Tier[] private _tiers;

    constructor(
        address admin,
        IERC20 token_,
        IERC20 usdg_,
        address pool_,
        uint256 unstakeDelay_,
        uint256 rewardDuration_,
        uint256 minClaimAge_
    ) {
        if (
            admin == address(0) || address(token_) == address(0) || address(usdg_) == address(0) || pool_ == address(0)
                || address(token_) == address(usdg_)
        ) revert InvalidParams();
        if (unstakeDelay_ < MIN_UNSTAKE_DELAY || unstakeDelay_ > MAX_UNSTAKE_DELAY) revert InvalidParams();
        if (rewardDuration_ < MIN_REWARD_DURATION || rewardDuration_ > MAX_REWARD_DURATION) revert InvalidParams();
        if (minClaimAge_ < MIN_CLAIM_AGE_FLOOR || minClaimAge_ > MAX_CLAIM_AGE) revert InvalidParams();
        // The TWAP reference values 18-decimal tokens; the launchpad standard is 18.
        if (IERC20Metadata(address(token_)).decimals() != 18) revert InvalidParams();
        token = token_;
        usdg = usdg_;
        pool = pool_;
        UNSTAKE_DELAY = unstakeDelay_;
        REWARD_DURATION = rewardDuration_;
        MIN_CLAIM_AGE = minClaimAge_;
        lastUpdate = uint64(block.timestamp);
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    // ------------------------------------------------------------------------------------------------ staking

    function stake(uint256 assets) external nonReentrant returns (uint256 shares) {
        return _stake(assets);
    }

    /// @notice `stake` after an EIP-2612 permit to this contract (a failed permit is ignored; the allowance decides).
    function stakeWithPermit(uint256 assets, uint256 deadline, uint8 v, bytes32 r, bytes32 s)
        external
        nonReentrant
        returns (uint256 shares)
    {
        try IERC20Permit(address(token)).permit(msg.sender, address(this), assets, deadline, v, r, s) {} catch {}
        return _stake(assets);
    }

    /// @notice Moves `shares` of the caller's active stake into an unstake request; the delay restarts.
    function requestUnstake(uint256 shares) external nonReentrant {
        if (shares == 0 || shares > sharesOf[msg.sender]) revert NothingToUnstake();
        _touch(msg.sender);
        sharesOf[msg.sender] -= shares;
        activeShares -= shares;
        Request storage q = requests[msg.sender];
        q.shares += shares;
        q.readyAt = uint64(block.timestamp + UNSTAKE_DELAY);
        emit UnstakeRequested(msg.sender, shares, q.readyAt);
    }

    /// @notice Returns the caller's whole request to the active stake.
    function cancelUnstake() external nonReentrant {
        Request memory q = requests[msg.sender];
        if (q.shares == 0) revert NothingToUnstake();
        _touch(msg.sender);
        delete requests[msg.sender];
        sharesOf[msg.sender] += q.shares;
        activeShares += q.shares;
        emit UnstakeCancelled(msg.sender, q.shares);
    }

    /// @notice Pays out a matured request at the current (post-slash) share value.
    /// F19: the pool's current loss is set aside first, so a staker cannot leave with the stake's part of it.
    function completeUnstake() external nonReentrant returns (uint256 assets) {
        Request memory q = requests[msg.sender];
        if (q.shares == 0) revert NothingToUnstake();
        if (block.timestamp < q.readyAt) revert NotReady(q.readyAt);
        _syncLoss();
        assets = assetsOf(q.shares);
        delete requests[msg.sender];
        totalShares -= q.shares;
        totalAssets -= assets;
        token.safeTransfer(msg.sender, assets);
        emit Unstaked(msg.sender, q.shares, assets);
    }

    function claimRewards() external nonReentrant returns (uint256 paid) {
        uint64 at = uint64(uint256(lastStakeAt[msg.sender]) + MIN_CLAIM_AGE);
        if (block.timestamp < at) revert ClaimTooEarly(at);
        _touch(msg.sender);
        paid = owed[msg.sender];
        if (paid == 0) return 0;
        owed[msg.sender] = 0;
        committed -= paid;
        usdg.safeTransfer(msg.sender, paid);
        emit RewardsClaimed(msg.sender, paid);
    }

    /// @notice F19: sets aside (or releases) the LMNS that covers the loss the pool currently counts against the stake.
    /// Anyone may call it (the keeper does, hourly); `stake` and `completeUnstake` call it first.
    function syncLoss() external nonReentrant {
        _syncLoss();
    }

    /// @notice Starts streaming USDG that arrived since the last sync (the keeper calls it after a distribution).
    function syncRewards() external nonReentrant {
        _accrue();
        _sync();
    }

    // ------------------------------------------------------------------------------------------------ loss layer

    /// @inheritdoc ILmnsStaking
    function slash(uint256 usdgNeeded) external override nonReentrant returns (uint256 usdgSent) {
        if (msg.sender != pool) revert NotPool();
        uint256 price = _price();
        IHedgeAdapter adapter = swapAdapter;
        uint256 locked = lockedForPool;
        uint256 slashable = _slashable() + locked;
        if (usdgNeeded == 0 || slashable == 0 || price == 0 || address(adapter) == address(0)) return 0;
        uint256 floorBps = BPS - slippageBps;
        uint256 amount = Math.mulDiv(usdgNeeded, PRICE_TO_USDG * BPS, price * floorBps, Math.Rounding.Ceil);
        if (amount > slashable) amount = slashable;
        uint256 minOut = Math.mulDiv(amount, price * floorBps, PRICE_TO_USDG * BPS);
        if (minOut == 0) return 0;
        // F37: anyone can trigger a slash (any claim); refuse to sell while spot has been pushed off the TWAP.
        if (!_spotNearTwap(priceSource, price)) {
            emit SlashFailed(usdgNeeded, amount);
            return 0;
        }

        uint256 lmnsBefore = token.balanceOf(address(this));
        uint256 poolBefore = usdg.balanceOf(pool);
        token.forceApprove(address(adapter), amount);
        try adapter.swapExactIn(address(token), address(usdg), poolFee, amount, minOut, pool) {
            uint256 sold = lmnsBefore - token.balanceOf(address(this));
            if (sold > slashable) sold = slashable;
            // The set-aside loss goes first (F19); only the rest lowers the share price.
            uint256 fromLocked = sold < locked ? sold : locked;
            lockedForPool = locked - fromLocked;
            totalAssets -= sold - fromLocked;
            usdgSent = usdg.balanceOf(pool) - poolBefore;
            emit Slashed(usdgNeeded, sold, usdgSent);
        } catch {
            emit SlashFailed(usdgNeeded, amount);
        }
        token.forceApprove(address(adapter), 0);
    }

    /// @inheritdoc ILmnsStaking
    /// @dev F18: never above `coverCapUsdg`, the depth-measured amount one slash can actually sell; 0 until the admin
    /// sets it.
    function coverValueUsdg() external view override returns (uint256 cover) {
        if (address(swapAdapter) == address(0)) return 0;
        uint256 price = _price();
        if (price == 0) return 0;
        cover = Math.mulDiv(_slashable() + lockedForPool, price * (BPS - slippageBps), PRICE_TO_USDG * BPS);
        if (cover > coverCapUsdg) cover = coverCapUsdg;
    }

    // ------------------------------------------------------------------------------------------------ tiers

    /// @inheritdoc ILmnsStaking
    function feeDiscountOf(address account)
        external
        view
        override
        returns (uint16 feeDiscountBps, uint16 spreadDiscountBps)
    {
        uint256 n = _tiers.length;
        if (n == 0) return (0, 0);
        uint256 held = assetsOf(sharesOf[account]);
        for (uint256 i = n; i > 0; --i) {
            Tier memory t = _tiers[i - 1];
            if (held >= t.minStake) return (t.feeDiscountBps, t.spreadDiscountBps);
        }
    }

    function tiers() external view returns (Tier[] memory) {
        return _tiers;
    }

    // ------------------------------------------------------------------------------------------------ views

    /// @notice LMNS value of `shares` at the current share price (rounded down).
    function assetsOf(uint256 shares) public view returns (uint256) {
        return Math.mulDiv(shares, totalAssets + 1, totalShares + 1);
    }

    /// @notice Active stake of `account` in LMNS.
    function stakeOf(address account) external view returns (uint256) {
        return assetsOf(sharesOf[account]);
    }

    /// @notice Rewards `account` could claim now (before the claim-age check), in USDG.
    function earned(address account) external view returns (uint256) {
        uint256 rps = rewardPerShare;
        uint256 t = block.timestamp < periodFinish ? block.timestamp : periodFinish;
        if (t > lastUpdate && activeShares != 0) {
            rps += Math.mulDiv(rewardRate * (t - lastUpdate), ACC / RATE, activeShares);
        }
        return owed[account] + Math.mulDiv(sharesOf[account], rps - rewardPerSharePaid[account], ACC);
    }

    // ------------------------------------------------------------------------------------------------ admin

    /// @notice Admin (timelock): the slash route. A zero price source or adapter turns the loss layer off (the pool
    /// then counts no cover and `slash` returns 0).
    function setSlashRoute(IPriceReference source, IHedgeAdapter adapter, uint24 fee, uint16 slippage)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        if (slippage > MAX_SLIPPAGE_BPS) revert InvalidParams();
        if (address(source) != address(0) && address(source).code.length == 0) revert InvalidParams();
        if (address(adapter) != address(0) && (address(adapter).code.length == 0 || fee == 0)) revert InvalidParams();
        priceSource = source;
        swapAdapter = adapter;
        poolFee = fee;
        slippageBps = slippage;
        emit SlashRouteSet(address(source), address(adapter), fee, slippage);
    }

    /// @notice Admin (timelock), F18: the cover cap in USDG (6 dp). Set it from the measured depth of the LMNS/USDG pool
    /// (the USDG one swap can raise inside `slippageBps`) and re-measure before raising it. 0 = no cover counted.
    function setCoverCap(uint256 capUsdg) external onlyRole(DEFAULT_ADMIN_ROLE) {
        coverCapUsdg = capUsdg;
        emit CoverCapSet(capUsdg);
    }

    /// @notice Admin (timelock): fee tiers, ascending `minStake`, at most MAX_TIERS, discounts bounded. Empty = none.
    function setTiers(Tier[] calldata t) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (t.length > MAX_TIERS) revert InvalidParams();
        delete _tiers;
        for (uint256 i; i < t.length; ++i) {
            if (t[i].minStake == 0 || (i != 0 && t[i].minStake <= t[i - 1].minStake)) revert InvalidParams();
            if (t[i].feeDiscountBps > MAX_FEE_DISCOUNT_BPS || t[i].spreadDiscountBps > MAX_SPREAD_DISCOUNT_BPS) {
                revert InvalidParams();
            }
            _tiers.push(t[i]);
        }
        emit TiersSet(t.length);
    }

    // ------------------------------------------------------------------------------------------------ internals

    function _stake(uint256 assets) private returns (uint256 shares) {
        if (assets == 0) revert InvalidParams();
        _syncLoss();
        _touch(msg.sender);
        uint256 before = token.balanceOf(address(this));
        token.safeTransferFrom(msg.sender, address(this), assets);
        uint256 received = token.balanceOf(address(this)) - before;
        shares = Math.mulDiv(received, totalShares + 1, totalAssets + 1);
        if (shares == 0) revert InvalidParams();
        totalShares += shares;
        totalAssets += received;
        sharesOf[msg.sender] += shares;
        activeShares += shares;
        lastStakeAt[msg.sender] = uint64(block.timestamp);
        emit Staked(msg.sender, received, shares);
    }

    /// @dev Accrues the stream, starts streaming new USDG, and settles `account`'s rewards to now.
    function _touch(address account) private {
        _accrue();
        _sync();
        uint256 rps = rewardPerShare;
        owed[account] += Math.mulDiv(sharesOf[account], rps - rewardPerSharePaid[account], ACC);
        rewardPerSharePaid[account] = rps;
    }

    function _accrue() private {
        uint256 t = block.timestamp < periodFinish ? block.timestamp : periodFinish;
        uint256 last = lastUpdate;
        if (t > last) {
            uint256 streamed = rewardRate * (t - last);
            if (activeShares == 0) {
                // Nobody earned this part: release it so the next sync streams it again.
                uint256 lost = streamed / RATE;
                committed = committed > lost ? committed - lost : 0;
            } else {
                rewardPerShare += Math.mulDiv(streamed, ACC / RATE, activeShares);
            }
        }
        lastUpdate = uint64(block.timestamp);
    }

    function _sync() private {
        uint256 bal = usdg.balanceOf(address(this));
        uint256 c = committed;
        if (bal < c + MIN_REWARD_SYNC) return;
        uint256 fresh = bal - c;
        uint256 remaining = periodFinish > block.timestamp ? (periodFinish - block.timestamp) * rewardRate : 0;
        rewardRate = (fresh * RATE + remaining) / REWARD_DURATION;
        periodFinish = uint64(block.timestamp + REWARD_DURATION);
        committed = bal;
        emit RewardsSynced(fresh, rewardRate, periodFinish);
    }

    /// @dev LMNS a slash may take: everything above the share-price floor.
    function _slashable() private view returns (uint256) {
        uint256 keep = Math.ceilDiv(totalShares, MAX_SHARES_PER_ASSET);
        return totalAssets > keep ? totalAssets - keep : 0;
    }

    /// @dev The stake's part of the pool's loss: its reserve share beyond the Reserve's USDG, read from the pool. A pool
    /// that cannot answer (no code, or its valuation reverts) or a missing price leaves the set-aside as it is.
    function _syncLoss() private {
        address p = pool;
        uint256 price = _price();
        // No price (TWAP unavailable): the pool counts no cover then, so its loss figure says nothing about the stake;
        // keep the set-aside as it is rather than release it.
        if (p.code.length == 0 || price == 0) return;
        (bool ok, bytes memory ret) = p.staticcall(abi.encodeWithSignature("navParts()"));
        if (!ok || ret.length < 64) return;
        (, uint256 shareWad) = abi.decode(ret, (int256, uint256));
        (ok, ret) = p.staticcall(abi.encodeWithSignature("reserve()"));
        if (!ok || ret.length < 32) return;
        address r = abi.decode(ret, (address));
        uint256 reserveUsdg = r == address(0) ? 0 : usdg.balanceOf(r);
        uint256 lossUsdg = shareWad / 1e12 > reserveUsdg ? shareWad / 1e12 - reserveUsdg : 0;
        uint256 target;
        if (lossUsdg != 0) {
            target = Math.mulDiv(lossUsdg, PRICE_TO_USDG * BPS, price * (BPS - slippageBps), Math.Rounding.Ceil);
        }
        uint256 cur = lockedForPool;
        if (target > cur) {
            uint256 add = target - cur;
            uint256 room = _slashable();
            if (add > room) add = room;
            totalAssets -= add;
            lockedForPool = cur + add;
        } else if (target < cur && totalShares != 0) {
            // With no shares left, released LMNS would make the next stake round to zero shares; keep it set aside.
            totalAssets += cur - target;
            lockedForPool = target;
        }
        if (target != cur) emit LossSynced(lossUsdg, lockedForPool);
    }

    /// @dev F37: true when the price source's spot price is within SPOT_BAND_BPS of `twap`. A source without
    /// `spotPrice`, or no answer, counts as off: the swap is skipped rather than made blind.
    function _spotNearTwap(IPriceReference src, uint256 twap) private view returns (bool) {
        (bool ok, bytes memory ret) =
            address(src).staticcall(abi.encodeWithSignature("spotPrice(address,uint24)", address(token), poolFee));
        if (!ok || ret.length < 32) return false;
        uint256 spot = abi.decode(ret, (uint256));
        if (spot == 0) return false;
        uint256 diff = spot > twap ? spot - twap : twap - spot;
        return diff * BPS <= twap * SPOT_BAND_BPS;
    }

    function _price() private view returns (uint256) {
        IPriceReference src = priceSource;
        if (address(src) == address(0)) return 0;
        try src.referencePrice(address(token), poolFee) returns (uint256 p) {
            return p;
        } catch {
            return 0;
        }
    }
}
