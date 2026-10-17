// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AccessControlUpgradeable} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {ERC20Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import {ERC4626Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC4626Upgradeable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {ReentrancyGuardTransientUpgradeable} from
    "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardTransientUpgradeable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {IPool} from "./interfaces/IPool.sol";
import {IOptionEngine} from "./interfaces/IOptionEngine.sol";
import {IPriceGuard} from "./interfaces/IPriceGuard.sol";
import {IPriceReference} from "./interfaces/IPriceReference.sol";
import {IHedgeAdapter} from "./interfaces/IHedgeAdapter.sol";
import {IReserve} from "./interfaces/IReserve.sol";
import {IFeeRouter} from "./interfaces/IFeeRouter.sol";
import {IVaultRegistry} from "./interfaces/IWriterVault.sol";
import {ILmnsStaking} from "./interfaces/ILmnsStaking.sol";
import {PoolHedging} from "./libs/PoolHedging.sol";
import {PoolLayers} from "./libs/PoolLayers.sol";
import {Roles} from "./libs/Roles.sol";

/// @title WriterPool
/// @notice USDG Writer Pool (spec 2.5): the counterparty of every option the engine sells. LPs deposit USDG at NAV per
/// share plus 10 bps and leave through a 72h queue paid at NAV at claim time. NAV = USDG cash + spot hedges at the
/// PriceGuard price + fresh perp equity - engine.bookValue() + reserve share - fees owed.
/// Liability (decision 26, todo 07b): every path (NAV, deposits, claims, payouts, caps) uses the engine's O(1)
/// `bookValue()`, each series valued at its last touch; the keeper re-marks every live series at least hourly, so NAV
/// lags the exact liability by at most about one hour of price and vol moves. Review F12/F15: LP entries and exits
/// (deposit, claim and their previews, maxDeposit, checkpoint) use `engine.navLiability`, bounds of the liability at
/// today's prices built in O(names) from the same S the hedges are marked at: deposits at the lower bound, claims and
/// the high-water checkpoint at the upper bound, so a print the keeper has not re-marked yet (or a selective re-mark)
/// never moves value between LPs. Payouts and the NAV views keep `bookValue`. The exact `engine.totalLiability()` is
/// never read on chain by the pool (monitoring only).
/// Caps: the engine's parameters are the one source of truth for the 35% / 8% outstanding caps (`engine.capBps()`);
/// `maxOutstandingBps`, `maxPerNameBps` and `capsFor` only mirror them.
/// @dev Kept from the reference vault: ERC-4626 shares with a 6-decimal offset (12-decimal shares), virtual shares,
/// deposit allowlist and self-received 24h deposit lock, NAV guard band (entries at the high edge, exits at the low
/// edge, from the engine's net greeks), pool-held spot hedges on Uniswap v3 routes with TWAP-floored minimum outputs,
/// cash raising from those routes, and exact approvals cleared after every swap.
/// Reserve share: the Reserve tops NAV per share back up to its high-water mark, so a loss reaches LP NAV only once
/// the reserve is used up (spec 2.6). The share is virtual until cash is needed (claims and payouts draw it).
/// Loss order (todo 20 R3): the Reserve first, then staked $LMNS (`staking`, phase 2: its TWAP cover value, capped by
/// the stake, counts in the reserve share once the Reserve is used up, and draws slash it), then LP NAV. Unset staking
/// = no second layer.
contract WriterPool is
    Initializable,
    ERC4626Upgradeable,
    AccessControlUpgradeable,
    ReentrancyGuardTransientUpgradeable,
    UUPSUpgradeable,
    IPool
{
    using Math for uint256;
    using SafeERC20 for IERC20;

    error InvalidParams();
    error InvalidRoute();
    error NotDepositor();
    error DepositsPaused();
    error WithdrawalLocked();
    error UseWithdrawalQueue();
    error UnknownTicket(uint256 ticket);
    error NotClaimable(uint64 claimableAt);
    error NavNotPositive();
    error NothingClaimable();
    error BadAsOf(uint64 asOf);

    event DepositorUpdated(address indexed account, bool allowed);
    event PublicDepositsUpdated(bool enabled);
    event DepositsPausedSet(bool paused);
    event ParamsUpdated(uint32 lockSeconds, uint16 cashBufferBps, uint16 maxHedgeSlippageBps, uint128 maxTotalDeposits);
    event NavGuardUpdated(uint16 openBps, uint16 closedBps);
    event HedgeRouteUpdated(address indexed stock, address indexed adapter, uint24 poolFee);
    event HedgeUnitsSynced(address indexed stock, uint256 units);
    event ModulesSet(address engine, address reserve, address feeRouter, address priceReference);
    event StakingSet(address staking);
    event StakeSlashed(uint256 requested, uint256 received);

    uint256 private constant BPS = 10_000;
    uint256 private constant USDG_TO_WAD = 1e12;
    uint256 private constant SHARE_UNIT = 1e12; // one whole share (12 decimals)
    uint256 private constant DEPOSIT_PREMIUM_BPS = 10;
    uint256 private constant MAX_LOCK_SECONDS = 30 days;
    uint256 private constant MAX_NAV_GUARD_BPS = 2_000;
    uint256 private constant MAX_STOCKS = 16;
    uint256 private constant MIN_FIRST_DEPOSIT = 1e6;
    /// @notice Withdrawal queue delay, fixed per deployment (72h on mainnet and fork, minutes on testnet).
    uint256 public immutable QUEUE_DELAY;
    /// @notice Hard bounds of QUEUE_DELAY and of the deposit lock (`lockSeconds`).
    uint256 public constant MIN_QUEUE_DELAY = 5 minutes;
    uint256 public constant MAX_QUEUE_DELAY = 30 days;
    uint256 public constant MIN_LOCK_SECONDS = 1 minutes;
    /// @dev Perp equity goes stale (out of NAV) this long after its asOf; the hourly move bound lives in PoolHedging.
    uint256 private constant HEDGE_STALE_AFTER = 2 hours;

    bytes32 public constant HEDGER_ROLE = keccak256("HEDGER_ROLE");
    bytes32 public constant GUARDIAN_ROLE = Roles.GUARDIAN_ROLE;

    IERC20 public usdg;
    IOptionEngine public engine;
    IPriceGuard public priceGuard;
    IPriceReference public priceReference;
    IReserve public reserve;
    IFeeRouter public feeRouter;

    bool public override publicDeposits;
    bool public depositsPaused;
    uint32 public lockSeconds;
    uint16 public cashBufferBps;
    uint16 public maxHedgeSlippageBps;
    uint16 public navGuardOpenBps;
    uint16 public navGuardClosedBps;
    uint128 public maxTotalDeposits;

    mapping(address account => bool allowed) public isDepositor;
    mapping(address account => uint256 timestamp) public lastDeposit;

    PoolHedging.Book private _book;

    /// @dev Perp equity and the hedger's bounds (F03/F17); same two slots as the former `_equityUsdg`/`_equityAsOf`.
    PoolHedging.Guard private _guard;

    uint256 public nextTicket;
    uint256 public queuedShares;
    mapping(uint256 ticket => PoolLayers.Ticket) private _tickets;

    /// @notice Protocol fees the pool could not pay for lack of cash; subtracted from NAV, paid on the next inflow.
    uint256 public feeOwed;
    /// @notice NAV per whole share (WAD) the reserve defends.
    uint256 public highWaterNavPerShare;
    /// @notice NAV in USDG at the last checkpoint; caps reserve funding without a valuation on every sale.
    uint256 public lastNavUsdg;

    bool private transient _escrowing;

    /// @inheritdoc IPool
    /// @dev Writer-vault registry (todo 19, phase 2). Unset at launch: every vault path is then a no-op.
    address public override vaultHook;
    /// @notice Second loss layer (phase 2, todo 20); zero = off.
    ILmnsStaking public staking;

    /// @param queueDelay_ withdrawal queue delay in seconds, inside [MIN_QUEUE_DELAY, MAX_QUEUE_DELAY]. Immutable in
    /// the implementation: an upgrade must construct the new implementation with the same value.
    /// @custom:oz-upgrades-unsafe-allow constructor state-variable-immutable
    constructor(uint256 queueDelay_) {
        if (queueDelay_ < MIN_QUEUE_DELAY || queueDelay_ > MAX_QUEUE_DELAY) revert InvalidParams();
        QUEUE_DELAY = queueDelay_;
        _disableInitializers();
    }

    /// @notice `engine_` may be zero and set once later (the engine is initialised with the pool's address).
    function initialize(address admin, IERC20 usdg_, IOptionEngine engine_, IPriceGuard priceGuard_)
        external
        initializer
    {
        if (admin == address(0) || address(usdg_) == address(0) || address(priceGuard_) == address(0)) {
            revert InvalidParams();
        }
        __ERC20_init("Lemniscate Writer Pool", "LWP");
        __ERC4626_init(usdg_);
        __AccessControl_init();
        __ReentrancyGuardTransient_init();
        __UUPSUpgradeable_init();

        usdg = usdg_;
        engine = engine_;
        priceGuard = priceGuard_;
        lockSeconds = 1 days;
        cashBufferBps = 1_000;
        maxHedgeSlippageBps = 100;
        navGuardOpenBps = 50;
        navGuardClosedBps = 300;
        maxTotalDeposits = 2_000_000e6;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    modifier onlyEngine() {
        if (msg.sender != address(engine) || msg.sender == address(0)) revert NotEngine();
        _;
    }

    // ---------------------------------------------------------------- engine callbacks

    /// @inheritdoc IPool
    function onSale(bytes32 seriesId, uint256 usdgIn, uint256 spreadUsdg) external override onlyEngine nonReentrant {
        emit SaleRecorded(seriesId, usdgIn, spreadUsdg);
        _takeIncome(spreadUsdg, true);
        _payVaults(seriesId, spreadUsdg, 0);
    }

    /// @inheritdoc IPool
    function onFunding(bytes32 seriesId, uint256 fundingUsdg) external override onlyEngine nonReentrant {
        emit FundingRecorded(seriesId, fundingUsdg);
        _takeIncome(fundingUsdg, false);
        _payVaults(seriesId, fundingUsdg, 0);
    }

    /// @inheritdoc IPool
    function onBuyback(bytes32 seriesId, uint256 tokens, uint256 supplyBefore, uint256 sWad, uint256 spreadUsdg)
        external
        override
        onlyEngine
        nonReentrant
    {
        PoolLayers.buyback(usdg, vaultHook, feeRouter, seriesId, tokens, supplyBefore, sWad, spreadUsdg);
    }

    /// @inheritdoc IPool
    /// @dev Not behind the reentrancy lock: the hook calls it while settling inside `onBuyback`.
    function creditVaultStock(address stock, uint256 units) external override {
        if (msg.sender != vaultHook || msg.sender == address(0)) revert NotVaultHook();
        uint256 u = _book.units[stock] + units;
        if (address(_book.routes[stock].adapter) == address(0) || IERC20(stock).balanceOf(address(this)) < u) {
            revert InvalidParams();
        }
        _book.units[stock] = u;
        emit VaultStockCredited(stock, units);
    }

    /// @inheritdoc IPool
    /// @dev Order: cash, then hedge sales (slippage is borne by the pool, bounded by maxHedgeSlippageBps), then the
    /// reserve up to its current share. Reverts Insolvent when all three cannot cover `usdgOut`.
    function pay(address to, uint256 usdgOut, uint256 spreadUsdg) external override onlyEngine nonReentrant {
        if (to == address(0)) revert InvalidParams();
        uint256 cash = usdg.balanceOf(address(this));
        if (cash < usdgOut) {
            _ensureCash(usdgOut, true);
            cash = usdg.balanceOf(address(this));
            if (cash < usdgOut && (address(reserve) != address(0) || address(staking) != address(0))) {
                PoolHedging.Valuation memory v = _val(0, false);
                uint256 share = v.reserveShare / USDG_TO_WAD;
                uint256 need = usdgOut - cash;
                _drawReserve(need < share ? need : share);
                cash = usdg.balanceOf(address(this));
            }
            if (cash < usdgOut) revert Insolvent(usdgOut, cash);
        }
        usdg.safeTransfer(to, usdgOut);
        emit PaidOut(to, usdgOut, spreadUsdg);
        _takeIncome(spreadUsdg, true);
    }

    // ---------------------------------------------------------------- LP flow

    /// @notice Deposits USDG for the caller at the NAV guard's high edge plus 10 bps. Starts the caller's 24h lock.
    function deposit(uint256 assets, address receiver)
        public
        override(ERC4626Upgradeable, IPool)
        nonReentrant
        returns (uint256 shares)
    {
        address caller = _msgSender();
        if (caller != receiver) revert InvalidParams();
        if (!_canDeposit(receiver)) revert NotDepositor();
        if (depositsPaused) revert DepositsPaused();
        PoolHedging.Valuation memory v = _val(1, true);
        uint256 maxAssets = _maxDeposit(v);
        if (assets > maxAssets) revert ERC4626ExceededMaxDeposit(receiver, assets, maxAssets);
        if (v.supply == 0 && assets < MIN_FIRST_DEPOSIT) revert InvalidParams();
        shares = _depositShares(assets, v);
        if (shares == 0) revert InvalidParams();
        _deposit(caller, receiver, assets, shares);
        lastDeposit[receiver] = block.timestamp;
        _checkpoint();
    }

    /// @inheritdoc IPool
    function requestWithdraw(uint256 shares) external override nonReentrant returns (uint256 ticket) {
        if (shares == 0) revert InvalidParams();
        address owner = _msgSender();
        _escrowing = true;
        _transfer(owner, address(this), shares);
        _escrowing = false;
        ticket = ++nextTicket;
        uint64 claimableAt = uint64(block.timestamp + QUEUE_DELAY);
        _tickets[ticket] = PoolLayers.Ticket({owner: owner, claimableAt: claimableAt, partialDay: 0, shares: shares});
        queuedShares += shares;
        emit WithdrawalQueued(owner, ticket, shares, claimableAt);
    }

    /// @inheritdoc IPool
    /// @dev Anyone may claim a matured ticket; USDG always goes to the ticket owner. Paid at the NAV guard's low edge.
    /// When liquid assets (cash, reserve share, hedges at their slippage floor) cannot pay every queued share, each
    /// claim gets its part of the day's pro-rata pot and the rest of the ticket stays claimable, at most once per ticket
    /// per UTC day (F16, PoolLayers.settleClaim). A forced hedge sale's execution shortfall is charged to the claim.
    function claim(uint256 ticket) external override nonReentrant returns (uint256 paid) {
        PoolLayers.Ticket storage t = _tickets[ticket];
        uint256 shares = t.shares;
        if (shares == 0) revert UnknownTicket(ticket);
        if (block.timestamp < t.claimableAt) revert NotClaimable(t.claimableAt);

        PoolHedging.Valuation memory v = _val(2, true);
        if (v.navLow <= 0) revert NavNotPositive();
        uint256 value = _assetsFor(shares, v.navLow, v.supply);
        if (value == 0) revert NothingClaimable();
        uint256 queued = queuedShares;
        uint256 burnShares;
        (paid, burnShares) = PoolLayers.settleClaim(
            t,
            _pot,
            _book,
            _ctx(),
            reserve,
            staking,
            PoolLayers.ClaimIn({
                value: value,
                liquid: _liquidAssets(v),
                queuedValue: _assetsFor(queued, v.navLow, v.supply),
                queued: queued,
                reserveShareUsdg: v.reserveShare / USDG_TO_WAD,
                reserveBalUsdg: _reserveWad() / USDG_TO_WAD,
                supply: v.supply
            })
        );

        address owner = t.owner;
        queuedShares = queued - burnShares;
        _burn(address(this), burnShares);
        usdg.safeTransfer(owner, paid);
        emit Withdraw(_msgSender(), owner, owner, paid, burnShares);
        emit WithdrawalClaimed(owner, ticket, paid);
        _checkpoint();
    }

    /// @notice Records the current NAV per share for the reserve's high-water mark and the reserve funding cap.
    function checkpoint() external nonReentrant {
        _checkpoint();
    }

    function mint(uint256, address) public pure override(ERC4626Upgradeable) returns (uint256) {
        revert UseWithdrawalQueue();
    }

    function withdraw(uint256, address, address) public pure override(ERC4626Upgradeable) returns (uint256) {
        revert UseWithdrawalQueue();
    }

    function redeem(uint256, address, address) public pure override(ERC4626Upgradeable) returns (uint256) {
        revert UseWithdrawalQueue();
    }

    // ---------------------------------------------------------------- hedging

    /// @inheritdoc IPool
    /// @dev Perp venues only (decision 19). Spot hedges are valued on chain and never posted. `ref` is only logged: no
    /// value of it lifts the bounds (F03/F17, see PoolHedging.postEquity). Perps are off at launch (cap 0).
    function postHedgeEquity(uint256 equityUsdg, uint64 asOf, bytes32 ref) external override onlyRole(HEDGER_ROLE) {
        PoolHedging.postEquity(_guard, equityUsdg, asOf, ref, lastNavUsdg);
    }

    /// @inheritdoc IPool
    function rebalance(address stock, uint256 targetUnits, uint256 minOutOrMaxIn)
        external
        override
        onlyRole(HEDGER_ROLE)
        nonReentrant
        returns (int256 unitsDelta)
    {
        uint256 cash = usdg.balanceOf(address(this));
        uint256 buffer = Math.mulDiv(lastNavUsdg, cashBufferBps, BPS);
        unitsDelta = PoolHedging.rebalance(
            _book, _guard, _ctx(), stock, targetUnits, minOutOrMaxIn, cash > buffer ? cash - buffer : 0
        );
    }

    // ---------------------------------------------------------------- admin (timelock) and guardian

    /// @notice Sets the engine once (it is initialised with the pool's address), the reserve, router and TWAP source.
    function setModules(IOptionEngine engine_, IReserve reserve_, IFeeRouter feeRouter_, IPriceReference priceReference_)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        if (address(engine) != address(0) && engine_ != engine) revert InvalidParams();
        if (address(reserve_) != address(0) && reserve_.pool() != address(this)) revert InvalidParams();
        if (address(priceReference_) != address(0) && address(priceReference_).code.length == 0) revert InvalidParams();
        engine = engine_;
        reserve = reserve_;
        feeRouter = feeRouter_;
        priceReference = priceReference_;
        emit ModulesSet(address(engine_), address(reserve_), address(feeRouter_), address(priceReference_));
    }

    /// @notice Sets the writer-vault registry (todo 19). address(0) switches the vault paths off.
    function setVaultHook(address hook) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (hook != address(0) && IVaultRegistry(hook).pool() != address(this)) revert InvalidParams();
        vaultHook = hook;
        emit VaultHookSet(hook);
    }

    /// @notice Admin (timelock): the $LMNS staking loss layer, or zero to turn it off.
    function setStaking(ILmnsStaking staking_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (address(staking_) != address(0) && staking_.pool() != address(this)) revert InvalidParams();
        staking = staking_;
        emit StakingSet(address(staking_));
    }

    function setDepositor(address account, bool allowed) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (account == address(0)) revert InvalidParams();
        isDepositor[account] = allowed;
        emit DepositorUpdated(account, allowed);
    }

    function setPublicDeposits(bool enabled) external onlyRole(DEFAULT_ADMIN_ROLE) {
        publicDeposits = enabled;
        emit PublicDepositsUpdated(enabled);
    }

    /// @notice Guardian may pause deposits (only that); unpausing is admin only.
    function setDepositsPaused(bool paused) external {
        _onlyPauser(paused);
        depositsPaused = paused;
        emit DepositsPausedSet(paused);
    }

    function _onlyPauser(bool pausing) private view {
        if (!hasRole(DEFAULT_ADMIN_ROLE, msg.sender) && !(pausing && hasRole(GUARDIAN_ROLE, msg.sender))) {
            revert AccessControlUnauthorizedAccount(msg.sender, GUARDIAN_ROLE);
        }
    }

    function setParams(uint32 lockSeconds_, uint16 cashBufferBps_, uint16 maxHedgeSlippageBps_, uint128 maxTotalDeposits_)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        if (lockSeconds_ < MIN_LOCK_SECONDS || lockSeconds_ > MAX_LOCK_SECONDS || cashBufferBps_ > 5_000 || maxHedgeSlippageBps_ > 500) {
            revert InvalidParams();
        }
        lockSeconds = lockSeconds_;
        cashBufferBps = cashBufferBps_;
        maxHedgeSlippageBps = maxHedgeSlippageBps_;
        maxTotalDeposits = maxTotalDeposits_;
        emit ParamsUpdated(lockSeconds_, cashBufferBps_, maxHedgeSlippageBps_, maxTotalDeposits_);
    }

    function setNavGuard(uint16 openBps, uint16 closedBps) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (openBps > MAX_NAV_GUARD_BPS || closedBps > MAX_NAV_GUARD_BPS) revert InvalidParams();
        navGuardOpenBps = openBps;
        navGuardClosedBps = closedBps;
        emit NavGuardUpdated(openBps, closedBps);
    }

    /// @notice Adds or replaces the Uniswap v3 route of a stock. Every listed stock needs one: the NAV guard and NAV
    /// iterate these stocks.
    function setHedgeRoute(address stock, IHedgeAdapter adapter, uint24 poolFee) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (stock == address(0) || address(adapter).code.length == 0 || poolFee == 0) revert InvalidRoute();
        if (address(_book.routes[stock].adapter) == address(0)) {
            if (_book.stocks.length >= MAX_STOCKS) revert InvalidRoute();
            priceGuard.config(stock); // reverts for a stock PriceGuard does not know
            _book.stocks.push(stock);
        }
        _book.routes[stock] = PoolHedging.Route({adapter: adapter, fee: poolFee});
        emit HedgeRouteUpdated(stock, address(adapter), poolFee);
    }

    /// @notice Hedger bounds (F03/F17/F27). Admin (timelock): the most perp equity NAV may count, in bps of the last NAV
    /// (0 = perps off, the launch value; at most 20%), the hedger's daily realised rebalance-loss budget in bps of NAV
    /// (1..200; 50 by default), and `frozen`. Guardian: may only freeze (`frozen` = true; the bps arguments are ignored),
    /// which stops `rebalance` and `postHedgeEquity` at once; only the admin unfreezes.
    function setHedgerLimits(uint16 maxPerpEquityBps_, uint16 maxHedgeLossBps, bool frozen) external {
        _onlyPauser(frozen);
        PoolHedging.setLimits(_guard, maxPerpEquityBps_, maxHedgeLossBps, frozen, hasRole(DEFAULT_ADMIN_ROLE, msg.sender));
    }

    /// @notice Resets a stock's tracked hedge to the pool's actual balance (after an issuer action, for example).
    function syncHedgeUnits(address stock) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (address(_book.routes[stock].adapter) == address(0)) revert InvalidRoute();
        uint256 units = IERC20(stock).balanceOf(address(this));
        _book.units[stock] = units;
        emit HedgeUnitsSynced(stock, units);
    }

    // ---------------------------------------------------------------- views

    /// @inheritdoc IPool
    function nav() external view override returns (int256) {
        return _val(0, false).nav;
    }

    /// @inheritdoc IPool
    function navFor(uint256 liabilityWad) public view override returns (int256) {
        return _valuation(liabilityWad, false, 0).nav;
    }

    /// @notice Mid NAV and the guard band's low (exit) and high (entry) edges, WAD.
    function navBand() external view returns (int256 navWad, int256 lowWad, int256 highWad) {
        PoolHedging.Valuation memory v = _val(0, true);
        return (v.nav, v.navLow, v.navHigh);
    }

    /// @inheritdoc IPool
    /// @dev WAD USDG per whole (1e12) share. 1e18 while empty.
    function navPerShare() external view override returns (uint256) {
        PoolHedging.Valuation memory v = _val(0, false);
        if (v.supply == 0) return 1e18;
        return v.nav > 0 ? Math.mulDiv(uint256(v.nav), SHARE_UNIT, v.supply) : 0;
    }

    /// @notice NAV before the reserve share and the reserve share itself, WAD.
    function navParts() external view returns (int256 rawWad, uint256 reserveShareWad) {
        PoolHedging.Valuation memory v = _val(0, false);
        return (v.raw, v.reserveShare);
    }

    function totalAssets() public view override(ERC4626Upgradeable) returns (uint256) {
        return _assetsOf(_val(0, false).nav);
    }

    /// @inheritdoc IPool
    /// @dev Mirrors the engine's `capBps()` (the only source; 0 while no engine is set).
    function maxOutstandingBps() public view override returns (uint16 bps) {
        (bps,) = _capBps();
    }

    /// @inheritdoc IPool
    function maxPerNameBps() public view override returns (uint16 bps) {
        (, bps) = _capBps();
    }

    /// @inheritdoc IPool
    function capsFor(uint256 liabilityWad) external view override returns (uint256, uint256) {
        int256 n = navFor(liabilityWad);
        if (n <= 0) return (0, 0);
        (uint16 total, uint16 perName) = _capBps();
        return (uint256(n) * total / BPS, uint256(n) * perName / BPS);
    }

    /// @inheritdoc IPool
    function hedgeEquity() external view override returns (uint256, uint64) {
        return (_guard.equityUsdg, _guard.equityAsOf);
    }

    /// @notice (maxPerpEquityBps (0 = perps off), daily rebalance-loss budget in bps of NAV, hedger frozen, realised
    /// rebalance loss booked today in USDG).
    function hedgerLimits() external view returns (uint16, uint16, bool, uint256) {
        return PoolHedging.limits(_guard);
    }

    /// @inheritdoc IPool
    function hedgeStale() public view override returns (bool) {
        uint64 asOf = _guard.equityAsOf;
        return asOf != 0 && block.timestamp > uint256(asOf) + HEDGE_STALE_AFTER;
    }

    /// @inheritdoc IPool
    function hedgeUnits(address stock) external view override returns (uint256) {
        return _book.units[stock];
    }

    function hedgeStocks() external view returns (address[] memory) {
        return _book.stocks;
    }

    function routeOf(address stock) external view returns (IHedgeAdapter adapter, uint24 poolFee) {
        PoolHedging.Route memory r = _book.routes[stock];
        return (r.adapter, r.fee);
    }

    function ticketOf(uint256 ticket) external view returns (address owner, uint256 shares, uint64 claimableAt) {
        PoolLayers.Ticket memory t = _tickets[ticket];
        return (t.owner, t.shares, t.claimableAt);
    }

    function unlockTime(address account) public view returns (uint256) {
        uint256 at = lastDeposit[account];
        return at == 0 ? 0 : at + lockSeconds;
    }

    function maxDeposit(address receiver) public view override(ERC4626Upgradeable) returns (uint256) {
        if (!_canDeposit(receiver) || depositsPaused) return 0;
        return _maxDeposit(_val(1, false));
    }

    function maxMint(address) public pure override(ERC4626Upgradeable) returns (uint256) {
        return 0;
    }

    function maxWithdraw(address) public pure override(ERC4626Upgradeable) returns (uint256) {
        return 0;
    }

    function maxRedeem(address) public pure override(ERC4626Upgradeable) returns (uint256) {
        return 0;
    }

    /// @notice Shares a deposit of `assets` would mint now (guard high edge plus 10 bps).
    function previewDeposit(uint256 assets) public view override(ERC4626Upgradeable) returns (uint256) {
        return _depositShares(assets, _val(1, true));
    }

    /// @notice Indicative USDG for `shares` at today's guard low edge (a ticket is paid at claim-time NAV).
    function previewRedeem(uint256 shares) public view override(ERC4626Upgradeable) returns (uint256) {
        PoolHedging.Valuation memory v = _val(2, true);
        return v.navLow > 0 ? _assetsFor(shares, v.navLow, v.supply) : 0;
    }

    // ---------------------------------------------------------------- internals: valuation

    /// @dev The engine's O(1) book value (decision 26), never the O(series) `totalLiability()`.
    function _liability() private view returns (uint256) {
        IOptionEngine e = engine;
        return address(e) == address(0) ? 0 : e.bookValue();
    }

    /// @dev Review F12/F15: `engine.navLiability(high)`, the liability bound for LP entries (false) and exits (true);
    /// an engine without it (older engines, mocks) gives `bookValue()`.
    function _navLiability(bool high) private view returns (uint256) {
        IOptionEngine e = engine;
        if (address(e) == address(0)) return 0;
        (bool ok, bytes memory data) = address(e).staticcall(abi.encodeWithSignature("navLiability(bool)", high));
        if (ok && data.length >= 32) return abi.decode(data, (uint256));
        return e.bookValue();
    }

    function _capBps() private view returns (uint16, uint16) {
        IOptionEngine e = engine;
        if (address(e) == address(0)) return (0, 0);
        return e.capBps();
    }

    /// @dev One valuation entry point: mode 0 = book value (trading paths and views), 1 = LP entry bound
    /// (deposit, maxDeposit, previewDeposit), 2 = LP exit bound (claim, previewRedeem); review F12/F15.
    function _val(uint8 mode, bool guard) private view returns (PoolHedging.Valuation memory) {
        return _valuation(mode == 0 ? _liability() : _navLiability(mode == 2), guard, mode);
    }

    /// @dev NAV at `liability`, computed in PoolHedging.valuation (one copy of the valuation code).
    function _valuation(uint256 liability, bool guard, uint8 side) private view returns (PoolHedging.Valuation memory) {
        return PoolHedging.valuation(
            _book,
            _guard,
            PoolHedging.ValIn({
                usdg: usdg,
                priceGuard: priceGuard,
                engine: engine,
                reserve: reserve,
                staking: staking,
                liability: liability,
                supply: totalSupply(),
                feeOwed: feeOwed,
                highWaterNavPerShare: highWaterNavPerShare,
                lastNavUsdg: lastNavUsdg,
                openBps: navGuardOpenBps,
                closedBps: navGuardClosedBps,
                guard: guard,
                side: side
            })
        );
    }

    function _reserveWad() private view returns (uint256) {
        return address(reserve) == address(0) ? 0 : usdg.balanceOf(address(reserve)) * USDG_TO_WAD;
    }

    function _stakeCoverWad() private view returns (uint256) {
        return address(staking) == address(0) ? 0 : staking.coverValueUsdg() * USDG_TO_WAD;
    }

    /// @dev Always at the LP-exit side (upper liability bound, hedge at the lower of S and the trade TWAP), so neither
    /// the high-water mark nor the reserve's cap ratchets up on a mark the keeper has not confirmed.
    function _checkpoint() private {
        PoolHedging.Valuation memory v = _val(2, false);
        lastNavUsdg = _assetsOf(v.nav);
        if (v.supply == 0) {
            highWaterNavPerShare = 0;
            return;
        }
        uint256 rawPerShare = v.raw > 0 ? Math.mulDiv(uint256(v.raw), SHARE_UNIT, v.supply) : 0;
        if (rawPerShare >= highWaterNavPerShare) {
            highWaterNavPerShare = rawPerShare;
        } else if (
            (address(reserve) != address(0) || address(staking) != address(0))
                && v.reserveShare >= _reserveWad() + _stakeCoverWad()
        ) {
            // Reserve and stake exhausted: the loss beyond them is LP loss; defend the new level from here on.
            highWaterNavPerShare = v.nav > 0 ? Math.mulDiv(uint256(v.nav), SHARE_UNIT, v.supply) : 0;
        }
    }

    /// @dev USDG the pool can reach without a fresh deposit: cash, the reserve share and hedges at their slippage floor.
    function _liquidAssets(PoolHedging.Valuation memory v) private view returns (uint256 liquid) {
        liquid = v.cash + v.reserveShare / USDG_TO_WAD
            + PoolHedging.liquidHedges(_book, v.prices, maxHedgeSlippageBps);
    }

    function _maxDeposit(PoolHedging.Valuation memory v) private view returns (uint256) {
        if (v.nav <= 0 && !(v.supply == 0 && v.liability == 0)) return 0;
        uint256 assets = _assetsOf(v.nav);
        return assets >= maxTotalDeposits ? 0 : uint256(maxTotalDeposits) - assets;
    }

    /// @dev shares = assets x (supply + virtual) / (NAV_high + 1) / 1.001, rounded down.
    function _depositShares(uint256 assets, PoolHedging.Valuation memory v) private pure returns (uint256) {
        int256 high = v.navHigh;
        uint256 navAssets = high > 0 ? Math.ceilDiv(uint256(high), USDG_TO_WAD) : 0;
        uint256 gross = assets.mulDiv(v.supply + 10 ** _decimalsOffset(), navAssets + 1);
        return gross.mulDiv(BPS, BPS + DEPOSIT_PREMIUM_BPS);
    }

    /// @dev assets = shares x (NAV + 1) / (supply + virtual), rounded down.
    function _assetsFor(uint256 shares, int256 navWad, uint256 supply) private pure returns (uint256) {
        uint256 navAssets = navWad > 0 ? uint256(navWad) / USDG_TO_WAD : 0;
        return shares.mulDiv(navAssets + 1, supply + 10 ** _decimalsOffset());
    }

    function _assetsOf(int256 navWad) private pure returns (uint256) {
        return navWad > 0 ? uint256(navWad) / USDG_TO_WAD : 0;
    }

    // ---------------------------------------------------------------- internals: cash, income, swaps

    function _takeIncome(uint256 income, bool isSpread) private {
        feeOwed = PoolLayers.takeIncome(usdg, feeRouter, reserve, feeOwed, lastNavUsdg, income, isSpread);
    }

    function _payVaults(bytes32 id, uint256 income, uint256 supply) private {
        PoolLayers.payVaults(usdg, vaultHook, feeRouter, id, income, supply);
    }

    /// @dev Realises `amount` of the reserve share: the Reserve first, then a slash of the staked $LMNS for the rest.
    function _drawReserve(uint256 amount) private {
        PoolLayers.drawReserve(reserve, staking, amount);
    }

    function _ensureCash(uint256 amount, bool fullCash) private returns (uint256) {
        return PoolHedging.ensureCash(_book, _ctx(), amount, fullCash);
    }

    function _ctx() private view returns (PoolHedging.Ctx memory) {
        return PoolHedging.Ctx({
            usdg: usdg,
            priceGuard: priceGuard,
            priceReference: priceReference,
            maxSlippageBps: maxHedgeSlippageBps,
            navUsdg: lastNavUsdg
        });
    }

    function _canDeposit(address receiver) private view returns (bool) {
        return receiver != address(0) && receiver != address(this) && (publicDeposits || isDepositor[receiver]);
    }

    // ---------------------------------------------------------------- ERC20 / ERC4626 plumbing

    /// @dev USDG 6 dp, shares 12 dp (reference vault offset; the deployment file records poolShareDecimals = 12).
    function _decimalsOffset() internal pure override returns (uint8) {
        return 6;
    }

    /// @dev Shares inside their owner's deposit lock never move, and shares reach the pool only through the queue.
    function _update(address from, address to, uint256 value) internal override(ERC20Upgradeable) {
        if (from != address(0) && to != address(0)) {
            if (unlockTime(from) > block.timestamp) revert WithdrawalLocked();
            if (to == address(this) && !_escrowing) revert UseWithdrawalQueue();
        }
        super._update(from, to, value);
    }

    function _authorizeUpgrade(address) internal override onlyRole(DEFAULT_ADMIN_ROLE) {}

    /// @notice F16: the day's pro-rata claim pot (one slot, taken from the gap).
    PoolLayers.Pot private _pot;

    /// @dev Three slots taken from the gap: vaultHook (todo 19), staking (todo 20) and the claim pot (F16).
    uint256[27] private __gap;
}
