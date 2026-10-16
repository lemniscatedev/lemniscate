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
import {PoolHedging} from "./libs/PoolHedging.sol";
import {Roles} from "./libs/Roles.sol";

/// @title WriterPool
/// @notice USDG Writer Pool (spec 2.5): the counterparty of every option the engine sells. LPs deposit USDG at NAV per
/// share plus 10 bps and leave through a 72h queue paid at NAV at claim time. NAV = USDG cash + spot hedges at the
/// PriceGuard price + fresh perp equity - engine.totalLiability() + reserve share - fees owed.
/// @dev Kept from the reference vault: ERC-4626 shares with a 6-decimal offset (12-decimal shares), virtual shares,
/// deposit allowlist and self-received 24h deposit lock, NAV guard band (entries at the high edge, exits at the low
/// edge, from the engine's net greeks), pool-held spot hedges on Uniswap v3 routes with TWAP-floored minimum outputs,
/// cash raising from those routes, and exact approvals cleared after every swap.
/// Reserve share: the Reserve tops NAV per share back up to its high-water mark, so a loss reaches LP NAV only once
/// the reserve is used up (spec 2.6). The share is virtual until cash is needed (claims and payouts draw it).
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
    event CapsUpdated(uint16 maxOutstandingBps, uint16 maxPerNameBps);
    event HedgeRouteUpdated(address indexed stock, address indexed adapter, uint24 poolFee);
    event HedgeUnitsSynced(address indexed stock, uint256 units);
    event ModulesSet(address engine, address reserve, address feeRouter, address priceReference);

    uint256 private constant BPS = 10_000;
    uint256 private constant USDG_TO_WAD = 1e12;
    uint256 private constant SHARE_UNIT = 1e12; // one whole share (12 decimals)
    uint256 private constant DEPOSIT_PREMIUM_BPS = 10;
    uint256 private constant MAX_LOCK_SECONDS = 30 days;
    uint256 private constant MAX_NAV_GUARD_BPS = 2_000;
    uint256 private constant MAX_STOCKS = 16;
    uint256 private constant MIN_FIRST_DEPOSIT = 1e6;
    uint256 public constant QUEUE_DELAY = 72 hours;
    uint256 public constant HEDGE_STALE_AFTER = 2 hours;
    uint256 public constant HEDGE_MAX_MOVE_BPS_PER_HOUR = 1_000;

    bytes32 public constant HEDGER_ROLE = keccak256("HEDGER_ROLE");
    bytes32 public constant GUARDIAN_ROLE = Roles.GUARDIAN_ROLE;

    struct Ticket {
        address owner;
        uint64 claimableAt;
        uint256 shares;
    }

    struct Valuation {
        uint256 cash; // USDG 6 dp held by the pool
        uint256 liability; // WAD
        uint256 supply;
        int256 raw; // WAD, before the reserve share
        uint256 reserveShare; // WAD
        int256 nav; // WAD = raw + reserveShare
        int256 navLow;
        int256 navHigh;
        uint256[] prices; // WAD S per tracked stock (0 when not read)
    }

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
    uint16 public override maxOutstandingBps;
    uint16 public override maxPerNameBps;
    uint128 public maxTotalDeposits;

    mapping(address account => bool allowed) public isDepositor;
    mapping(address account => uint256 timestamp) public lastDeposit;

    PoolHedging.Book private _book;

    uint256 private _equityUsdg;
    uint64 private _equityAsOf;

    uint256 public nextTicket;
    uint256 public queuedShares;
    mapping(uint256 ticket => Ticket) private _tickets;

    /// @notice Protocol fees the pool could not pay for lack of cash; subtracted from NAV, paid on the next inflow.
    uint256 public feeOwed;
    /// @notice NAV per whole share (WAD) the reserve defends.
    uint256 public highWaterNavPerShare;
    /// @notice NAV in USDG at the last checkpoint; caps reserve funding without a valuation on every sale.
    uint256 public lastNavUsdg;

    bool private transient _escrowing;

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
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
        maxOutstandingBps = 3_500;
        maxPerNameBps = 800;
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
    }

    /// @inheritdoc IPool
    function onFunding(bytes32 seriesId, uint256 fundingUsdg) external override onlyEngine nonReentrant {
        emit FundingRecorded(seriesId, fundingUsdg);
        _takeIncome(fundingUsdg, false);
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
            if (cash < usdgOut && address(reserve) != address(0)) {
                Valuation memory v = _valuation(_liability(), false);
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
        Valuation memory v = _valuation(_liability(), true);
        uint256 maxAssets = _maxDeposit(v);
        if (assets > maxAssets) revert ERC4626ExceededMaxDeposit(receiver, assets, maxAssets);
        if (v.supply == 0 && assets < MIN_FIRST_DEPOSIT) revert InvalidParams();
        shares = _depositShares(assets, v);
        if (shares == 0) revert InvalidParams();
        _deposit(caller, receiver, assets, shares);
        lastDeposit[receiver] = block.timestamp;
        _checkpoint(v.liability);
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
        _tickets[ticket] = Ticket({owner: owner, claimableAt: claimableAt, shares: shares});
        queuedShares += shares;
        emit WithdrawalQueued(owner, ticket, shares, claimableAt);
    }

    /// @inheritdoc IPool
    /// @dev Anyone may claim a matured ticket; USDG always goes to the ticket owner. Paid at the NAV guard's low edge.
    /// When liquid assets (cash, reserve share, hedges at their slippage floor) cannot pay every queued share, each
    /// claim gets its pro-rata part and the rest of the ticket stays claimable. A forced hedge sale's execution
    /// shortfall is charged to the claim.
    function claim(uint256 ticket) external override nonReentrant returns (uint256 paid) {
        Ticket storage t = _tickets[ticket];
        uint256 shares = t.shares;
        if (shares == 0) revert UnknownTicket(ticket);
        if (block.timestamp < t.claimableAt) revert NotClaimable(t.claimableAt);

        Valuation memory v = _valuation(_liability(), true);
        if (v.navLow <= 0) revert NavNotPositive();
        uint256 value = _assetsFor(shares, v.navLow, v.supply);
        if (value == 0) revert NothingClaimable();

        // Pro rata only when liquid assets cannot pay every queued share at once.
        uint256 queued = queuedShares;
        uint256 liquid = _liquidAssets(v);
        uint256 target = liquid >= _assetsFor(queued, v.navLow, v.supply) ? value : Math.mulDiv(liquid, shares, queued);
        if (target > value) target = value;
        uint256 burnShares = target == value ? shares : Math.mulDiv(shares, target, value, Math.Rounding.Ceil);

        // Realise this claim's part of the reserve share (NAV-neutral for everyone else).
        _drawReserve(Math.mulDiv(v.reserveShare / USDG_TO_WAD, burnShares, v.supply));

        uint256 shortfall;
        if (usdg.balanceOf(address(this)) < target) shortfall = _ensureCash(target, false);
        uint256 covered = usdg.balanceOf(address(this)) + shortfall;
        if (covered < target) {
            // Routes failed (paused stock, drained pool): this ticket's pro-rata part of what exists; the rest of
            // the ticket stays claimable.
            target = Math.mulDiv(covered, shares, queued);
            burnShares = Math.mulDiv(shares, target, value, Math.Rounding.Ceil);
        }
        if (burnShares > shares) burnShares = shares;
        paid = target > shortfall ? target - shortfall : 0;
        if (burnShares == 0 || paid == 0) revert NothingClaimable();

        address owner = t.owner;
        t.shares = shares - burnShares;
        queuedShares -= burnShares;
        _burn(address(this), burnShares);
        usdg.safeTransfer(owner, paid);
        emit Withdraw(_msgSender(), owner, owner, paid, burnShares);
        emit WithdrawalClaimed(owner, ticket, paid);
        _checkpoint(v.liability);
    }

    /// @notice Records the current NAV per share for the reserve's high-water mark and the reserve funding cap.
    function checkpoint() external nonReentrant {
        _checkpoint(_liability());
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
    /// @dev Perp venues only (decision 19). Spot hedges are valued on chain and never posted.
    function postHedgeEquity(uint256 equityUsdg, uint64 asOf, bytes32 ref) external override onlyRole(HEDGER_ROLE) {
        uint64 prevAsOf = _equityAsOf;
        if (asOf > block.timestamp || asOf <= prevAsOf) revert BadAsOf(asOf);
        uint256 prev = _equityUsdg;
        if (ref == bytes32(0) && equityUsdg != prev) {
            uint256 allowed = Math.mulDiv(prev, HEDGE_MAX_MOVE_BPS_PER_HOUR * (asOf - prevAsOf), BPS * 1 hours);
            uint256 diff = equityUsdg > prev ? equityUsdg - prev : prev - equityUsdg;
            if (prevAsOf == 0 || diff > allowed) revert HedgeJump(prev, equityUsdg);
        }
        _equityUsdg = equityUsdg;
        _equityAsOf = asOf;
        emit HedgeEquityPosted(equityUsdg, asOf, ref);
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
            _book, _ctx(), stock, targetUnits, minOutOrMaxIn, cash > buffer ? cash - buffer : 0
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
        if (!hasRole(DEFAULT_ADMIN_ROLE, msg.sender) && !(paused && hasRole(GUARDIAN_ROLE, msg.sender))) {
            revert AccessControlUnauthorizedAccount(msg.sender, GUARDIAN_ROLE);
        }
        depositsPaused = paused;
        emit DepositsPausedSet(paused);
    }

    function setParams(uint32 lockSeconds_, uint16 cashBufferBps_, uint16 maxHedgeSlippageBps_, uint128 maxTotalDeposits_)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        if (lockSeconds_ > MAX_LOCK_SECONDS || cashBufferBps_ > 5_000 || maxHedgeSlippageBps_ > 500) {
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

    function setCaps(uint16 maxOutstandingBps_, uint16 maxPerNameBps_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (maxOutstandingBps_ > BPS || maxPerNameBps_ > maxOutstandingBps_) revert InvalidParams();
        maxOutstandingBps = maxOutstandingBps_;
        maxPerNameBps = maxPerNameBps_;
        emit CapsUpdated(maxOutstandingBps_, maxPerNameBps_);
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
        return _valuation(_liability(), false).nav;
    }

    /// @inheritdoc IPool
    function navFor(uint256 liabilityWad) public view override returns (int256) {
        return _valuation(liabilityWad, false).nav;
    }

    /// @notice Mid NAV and the guard band's low (exit) and high (entry) edges, WAD.
    function navBand() external view returns (int256 navWad, int256 lowWad, int256 highWad) {
        Valuation memory v = _valuation(_liability(), true);
        return (v.nav, v.navLow, v.navHigh);
    }

    /// @inheritdoc IPool
    /// @dev WAD USDG per whole (1e12) share. 1e18 while empty.
    function navPerShare() external view override returns (uint256) {
        Valuation memory v = _valuation(_liability(), false);
        if (v.supply == 0) return 1e18;
        return v.nav > 0 ? Math.mulDiv(uint256(v.nav), SHARE_UNIT, v.supply) : 0;
    }

    /// @notice NAV before the reserve share and the reserve share itself, WAD.
    function navParts() external view returns (int256 rawWad, uint256 reserveShareWad) {
        Valuation memory v = _valuation(_liability(), false);
        return (v.raw, v.reserveShare);
    }

    function totalAssets() public view override(ERC4626Upgradeable) returns (uint256) {
        return _assetsOf(_valuation(_liability(), false).nav);
    }

    /// @inheritdoc IPool
    function capsFor(uint256 liabilityWad) external view override returns (uint256, uint256) {
        int256 n = navFor(liabilityWad);
        if (n <= 0) return (0, 0);
        return (uint256(n) * maxOutstandingBps / BPS, uint256(n) * maxPerNameBps / BPS);
    }

    /// @inheritdoc IPool
    function hedgeEquity() external view override returns (uint256, uint64) {
        return (_equityUsdg, _equityAsOf);
    }

    /// @inheritdoc IPool
    function hedgeStale() public view override returns (bool) {
        return _equityAsOf != 0 && block.timestamp > uint256(_equityAsOf) + HEDGE_STALE_AFTER;
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
        Ticket memory t = _tickets[ticket];
        return (t.owner, t.shares, t.claimableAt);
    }

    function unlockTime(address account) public view returns (uint256) {
        uint256 at = lastDeposit[account];
        return at == 0 ? 0 : at + lockSeconds;
    }

    function maxDeposit(address receiver) public view override(ERC4626Upgradeable) returns (uint256) {
        if (!_canDeposit(receiver) || depositsPaused) return 0;
        return _maxDeposit(_valuation(_liability(), false));
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
        return _depositShares(assets, _valuation(_liability(), true));
    }

    /// @notice Indicative USDG for `shares` at today's guard low edge (a ticket is paid at claim-time NAV).
    function previewRedeem(uint256 shares) public view override(ERC4626Upgradeable) returns (uint256) {
        Valuation memory v = _valuation(_liability(), true);
        return v.navLow > 0 ? _assetsFor(shares, v.navLow, v.supply) : 0;
    }

    // ---------------------------------------------------------------- internals: valuation

    function _liability() private view returns (uint256) {
        IOptionEngine e = engine;
        return address(e) == address(0) ? 0 : e.totalLiability();
    }

    /// @dev One pass over the tracked stocks. With `guard`, also the NAV change for an adverse feed move of
    /// navGuardOpenBps (live session) or navGuardClosedBps (otherwise) per stock, from the hedge and the engine's net
    /// greeks of the outstanding options (liability change = delta dS + gamma dS^2 / 2).
    function _valuation(uint256 liability, bool guard) private view returns (Valuation memory v) {
        v.liability = liability;
        v.supply = totalSupply();
        v.cash = usdg.balanceOf(address(this));
        int256 gross = _toInt(v.cash * USDG_TO_WAD) - _toInt(feeOwed * USDG_TO_WAD);
        if (!hedgeStale()) gross += _toInt(_equityUsdg * USDG_TO_WAD);

        (uint256 hedgeWad, int256 up, int256 down, uint256[] memory prices) = PoolHedging.value(
            _book, priceGuard, engine, guard, navGuardOpenBps, navGuardClosedBps
        );
        v.prices = prices;
        gross += _toInt(hedgeWad);
        v.raw = gross - _toInt(liability);
        v.reserveShare = _reserveShare(v.raw, v.supply);
        v.nav = v.raw + _toInt(v.reserveShare);
        v.navLow = v.nav + down;
        v.navHigh = v.nav + up;
    }

    /// @dev The part of the reserve needed to lift NAV per share back to the high-water mark.
    function _reserveShare(int256 raw, uint256 supply) private view returns (uint256) {
        IReserve r = reserve;
        uint256 hwm = highWaterNavPerShare;
        if (address(r) == address(0) || supply == 0 || hwm == 0) return 0;
        int256 defended = _toInt(Math.mulDiv(hwm, supply, SHARE_UNIT));
        if (raw >= defended) return 0;
        uint256 deficit = uint256(defended - raw);
        uint256 bal = usdg.balanceOf(address(r)) * USDG_TO_WAD;
        return deficit < bal ? deficit : bal;
    }

    function _checkpoint(uint256 liability) private {
        Valuation memory v = _valuation(liability, false);
        lastNavUsdg = _assetsOf(v.nav);
        if (v.supply == 0) {
            highWaterNavPerShare = 0;
            return;
        }
        uint256 rawPerShare = v.raw > 0 ? Math.mulDiv(uint256(v.raw), SHARE_UNIT, v.supply) : 0;
        if (rawPerShare >= highWaterNavPerShare) {
            highWaterNavPerShare = rawPerShare;
        } else if (address(reserve) != address(0) && v.reserveShare >= usdg.balanceOf(address(reserve)) * USDG_TO_WAD) {
            // Reserve exhausted: the loss beyond it is LP loss; defend the new level from here on.
            highWaterNavPerShare = v.nav > 0 ? Math.mulDiv(uint256(v.nav), SHARE_UNIT, v.supply) : 0;
        }
    }

    /// @dev USDG the pool can reach without a fresh deposit: cash, the reserve share and hedges at their slippage floor.
    function _liquidAssets(Valuation memory v) private view returns (uint256 liquid) {
        liquid = v.cash + v.reserveShare / USDG_TO_WAD
            + PoolHedging.liquidHedges(_book, v.prices, maxHedgeSlippageBps);
    }

    function _maxDeposit(Valuation memory v) private view returns (uint256) {
        if (v.nav <= 0 && !(v.supply == 0 && v.liability == 0)) return 0;
        uint256 assets = _assetsOf(v.nav);
        return assets >= maxTotalDeposits ? 0 : uint256(maxTotalDeposits) - assets;
    }

    /// @dev shares = assets x (supply + virtual) / (NAV_high + 1) / 1.001, rounded down.
    function _depositShares(uint256 assets, Valuation memory v) private pure returns (uint256) {
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

    /// @dev Pays the protocol fee (plus any fee owed) to the router and, for spread income, the reserve's share until
    /// it holds its target of NAV. Never sells hedges for fees: what cash cannot cover is owed.
    function _takeIncome(uint256 income, bool isSpread) private {
        IFeeRouter router = feeRouter;
        uint256 fee = address(router) == address(0) ? 0 : Math.mulDiv(income, router.protocolFeeBps(), BPS);
        uint256 owed = feeOwed + fee;
        uint256 cash = usdg.balanceOf(address(this));
        uint256 sent = owed < cash ? owed : cash;
        if (sent != 0) usdg.safeTransfer(address(router), sent);
        feeOwed = owed - sent;
        cash -= sent;

        uint256 toReserve;
        IReserve r = reserve;
        if (isSpread && address(r) != address(0) && income != 0) {
            uint256 target = Math.mulDiv(lastNavUsdg, r.targetBps(), BPS);
            uint256 held = usdg.balanceOf(address(r));
            toReserve = Math.mulDiv(income, r.incomeShareBps(), BPS);
            uint256 room = target > held ? target - held : 0;
            if (toReserve > room) toReserve = room;
            if (toReserve > cash) toReserve = cash;
            if (toReserve != 0) usdg.safeTransfer(address(r), toReserve);
        }
        if (income != 0 || sent != 0) emit IncomeSplit(income, sent, toReserve, feeOwed);
    }

    function _drawReserve(uint256 amount) private {
        if (amount == 0 || address(reserve) == address(0)) return;
        uint256 sent = reserve.cover(amount);
        if (sent != 0) emit ReserveDrawn(sent);
    }

    function _ensureCash(uint256 amount, bool fullCash) private returns (uint256) {
        return PoolHedging.ensureCash(_book, _ctx(), amount, fullCash);
    }

    function _ctx() private view returns (PoolHedging.Ctx memory) {
        return PoolHedging.Ctx({
            usdg: usdg,
            priceGuard: priceGuard,
            priceReference: priceReference,
            maxSlippageBps: maxHedgeSlippageBps
        });
    }

    function _canDeposit(address receiver) private view returns (bool) {
        return receiver != address(0) && receiver != address(this) && (publicDeposits || isDepositor[receiver]);
    }

    function _toInt(uint256 value) private pure returns (int256) {
        if (value > uint256(type(int256).max)) revert InvalidParams();
        return int256(value);
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

    uint256[30] private __gap;
}
