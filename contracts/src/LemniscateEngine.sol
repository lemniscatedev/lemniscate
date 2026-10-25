// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AccessControlUpgradeable} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {ReentrancyGuardTransientUpgradeable} from
    "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardTransientUpgradeable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {IOptionEngine} from "./interfaces/IOptionEngine.sol";
import {IPool} from "./interfaces/IPool.sol";
import {IPriceGuard} from "./interfaces/IPriceGuard.sol";
import {ISeriesRegistry} from "./interfaces/ISeriesRegistry.sol";
import {IVolOracle} from "./interfaces/IVolOracle.sol";
import {SessionKind} from "./libs/OptionTypes.sol";
import {Roles} from "./libs/Roles.sol";
import {EngineHelper} from "./EngineHelper.sol";
import {EngineStorage} from "./engine/EngineStorage.sol";
import {EngineTradeLib} from "./engine/EngineTradeLib.sol";
import {EngineOpsLib} from "./engine/EngineOpsLib.sol";
import {EngineSellLib} from "./engine/EngineSellLib.sol";
import {EngineMarkLib} from "./engine/EngineMarkLib.sol";
import {EngineViewLib} from "./engine/EngineViewLib.sol";
import {EngineCore} from "./engine/EngineCore.sol";

/// @title LemniscateEngine
/// @notice Buys and sells everlasting options (Up = call, Down = put) on Stock Tokens at a model price plus a spread,
/// paid in USDG. The Writer Pool is the counterparty: buys send USDG from the buyer straight to the pool, sells are
/// paid by the pool; the engine never holds USDG. Holders pay funding in kind (the series norm shrinks), are never
/// liquidated and can never lose more than they paid; selling back is never blocked by a pause.
/// @dev UUPS proxy implementation. State lives in one ERC-7201 namespace (EngineStorage); the trade, accrual and
/// valuation logic lives in two external libraries this contract delegatecalls (EngineTradeLib, EngineOpsLib) and
/// the pure maths in EngineHelper, deployed by the constructor, so the contract stays under EIP-170.
/// Rules (engine todo R1-R21, tests in test/engine/):
///  - Every buy, sell, shield and token transfer accrues the series first. `accrue` is not behind the reentrancy lock
///    (the option token calls it from inside the engine's own mint and burn) and is a one-SLOAD no-op once the
///    series is accrued in this block.
///  - Valuation (accrual, sells, liability) reads each stock once per transaction with `PriceGuard.readLite`, cached in
///    transient storage; buys and shield use the full `read` with the TWAP cross-check.
///  - The valuation mark of a unit is V(sigma_mark), sigma_mark = posted sigma with the decision-17 skew. Funding and
///    the pool liability use it; trade prices add the inventory term and the spread (EngineHelper.price).
///  - Risk is kept per name: sums over its series of units x (value, delta, gamma, vega and the value change in the
///    four stress scenarios), refreshed whenever a series is touched (buy, sell, accrue). Caps and the stress budget
///    read these sums, so a buy costs O(names), not O(series); `totalLiability()` is the exact recomputation.
///  - Sells: REGULAR / EXTENDED at S; CLOSED / UNKNOWN at the last good S with 3x spread; HALTED (or a payout the pool
///    cannot make, e.g. an issuer pause) escrows the tokens in a ticket that anyone can fill at the first non-HALTED
///    price (`fillQueued`) and the seller can cancel. Pauses (global, series, guardian, stress, drawdown) stop buys
///    only.
///  - Review fixes (todo 27, decisions 30-38): trades are priced at the worse for the trader of the feed S and
///    PriceGuard's short trade TWAP, and a sell inside the account's hold (30 min after its buy, carried through
///    transfers) at the worse of that and the buy S; every buy costs and every partial sell moves at least the minimum
///    trade ($1) and leaves at least it behind; a gap is charged funding at max(rate at its start, rate now); stale vol
///    lowers the sell sigma; a stock HALTED past the settle delay can be settled at its last price (ORC-4); dust series
///    can be retired from the live list; the pool prices LP entries and exits on `navLiability` bounds.
contract LemniscateEngine is
    Initializable,
    AccessControlUpgradeable,
    UUPSUpgradeable,
    ReentrancyGuardTransientUpgradeable,
    IOptionEngine
{
    bytes32 public constant GUARDIAN_ROLE = Roles.GUARDIAN_ROLE;
    /// @notice Buys stop on a series whose norm fell below this (see EngineCore.BUY_MIN_NORM).
    uint256 public constant BUY_MIN_NORM = 1e15;
    /// @notice Hard bounds of the deploy-time trade guards (`setGuards`).
    uint64 public constant MAX_MIN_TRADE_USDG = 1_000e6;
    uint32 public constant MIN_HOLD_SECONDS = 5 minutes;
    uint32 public constant MAX_HOLD_SECONDS = 1 days;
    uint32 public constant MIN_SETTLE_DELAY = 1 days;
    uint32 public constant MAX_SETTLE_DELAY = 90 days;

    event ParamsSet(EngineHelper.Params params);
    event GuardsSet(EngineStorage.Guards guards);
    event HedgeDepthCapSet(address indexed stock, uint256 capWad);
    event UpgradesFrozen();
    event FeeTiersSet(address feeTiers);
    event AgentRouterSet(address agentRouter);

    error ZeroAddress();
    error UpgradesAreFrozen();
    error NotGuardian();
    error InvalidGuards();
    error NotSeriesToken();
    error NotAgentRouter();

    EngineHelper public immutable HELPER;

    /// @dev Kept for layout hygiene; the engine's own state is namespaced (EngineStorage).
    uint256[50] private __gap;

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        HELPER = new EngineHelper();
        _disableInitializers();
    }

    function initialize(
        address admin,
        IERC20 usdg_,
        IPool pool_,
        ISeriesRegistry registry_,
        IPriceGuard priceGuard_,
        IVolOracle volOracle_
    ) external initializer {
        if (
            admin == address(0) || address(usdg_) == address(0) || address(pool_) == address(0)
                || address(registry_) == address(0) || address(priceGuard_) == address(0)
                || address(volOracle_) == address(0)
        ) revert ZeroAddress();
        __AccessControl_init();
        __UUPSUpgradeable_init();
        __ReentrancyGuardTransient_init();
        EngineStorage.Layout storage $ = EngineStorage.layout();
        $.usdg = usdg_;
        $.pool = pool_;
        $.registry = registry_;
        $.priceGuard = priceGuard_;
        $.volOracle = volOracle_;
        $.p = HELPER.defaults();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        emit ParamsSet($.p);
    }

    // ---------------------------------------------------------------------------------------------------- admin

    /// @notice Caps, spreads and limits, each inside the bounds of `EngineHelper.validate`.
    function setParams(EngineHelper.Params calldata p) external onlyRole(DEFAULT_ADMIN_ROLE) {
        HELPER.validate(p);
        EngineStorage.layout().p = p;
        emit ParamsSet(p);
    }

    /// @notice Admin (timelock): the trade guards, each inside its hard bounds; a zero field means the default ($1
    /// minimum trade, 30-minute hold, 7-day settle delay). The minimum trade and the hold cannot be switched off.
    function setGuards(EngineStorage.Guards calldata g) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (
            g.minTradeUsdg > MAX_MIN_TRADE_USDG
                || (g.holdSeconds != 0 && (g.holdSeconds < MIN_HOLD_SECONDS || g.holdSeconds > MAX_HOLD_SECONDS))
                || (g.haltSettleDelay != 0 && (g.haltSettleDelay < MIN_SETTLE_DELAY || g.haltSettleDelay > MAX_SETTLE_DELAY))
        ) revert InvalidGuards();
        EngineStorage.layout().guards = g;
        emit GuardsSet(g);
    }

    /// @notice The guards in force (defaults filled in).
    function guards() external view returns (uint64 minTradeUsdg, uint32 holdSeconds, uint32 haltSettleDelay) {
        EngineStorage.Guards memory g = EngineStorage.layout().guards;
        return (
            uint64(EngineCore.minTradeUsdg()),
            uint32(EngineCore.holdSeconds()),
            g.haltSettleDelay == 0 ? EngineCore.DEFAULT_SETTLE_DELAY : g.haltSettleDelay
        );
    }

    /// @notice Per-name outstanding cap from the hedge pool's depth (0 = none): the name cap is min(8% NAV, this).
    function setHedgeDepthCap(address stock, uint256 capWad) external onlyRole(DEFAULT_ADMIN_ROLE) {
        EngineStorage.layout().hedgeDepthCapWad[stock] = capWad;
        emit HedgeDepthCapSet(stock, capWad);
    }

    /// @inheritdoc IOptionEngine
    /// @dev Guardian or admin may pause; only the admin may unpause. Sells are never affected.
    function setBuysPaused(bool paused) external {
        _checkPauser(paused);
        EngineStorage.layout().globalBuysPaused = paused;
        emit BuysPaused(true, bytes32(0), paused);
    }

    /// @inheritdoc IOptionEngine
    function setSeriesBuysPaused(bytes32 id, bool paused) external {
        _checkPauser(paused);
        EngineStorage.layout().seriesBuysPaused[id] = paused;
        emit BuysPaused(false, id, paused);
    }

    /// @notice Admin (timelock): the $LMNS staking contract whose tiers discount fee and spread (todo 20 R4). Zero =
    /// no discounts. Reads are gas-capped and clamped, so a broken contract only removes discounts, never blocks trades.
    function setFeeTiers(address feeTiers_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (feeTiers_ != address(0) && feeTiers_.code.length == 0) revert ZeroAddress();
        EngineStorage.layout().feeTiers = feeTiers_;
        emit FeeTiersSet(feeTiers_);
    }

    /// @notice Admin (timelock): the AgentRouter whose `sellFor` sells an owner's tokens as that owner (review R04) and
    /// which alone may buy for another recipient (R02). The router checks the owner's policy; zero switches agents off.
    function setAgentRouter(address router) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (router != address(0) && router.code.length == 0) revert ZeroAddress();
        EngineStorage.layout().agentRouter = router;
        emit AgentRouterSet(router);
    }

    function agentRouter() external view returns (address) {
        return EngineStorage.layout().agentRouter;
    }

    function feeTiers() external view returns (address) {
        return EngineStorage.layout().feeTiers;
    }

    /// @notice The fee and spread discounts (bps of each) a trade by `account` gets now; (0, 0) when tiers are off.
    function feeDiscountOf(address account) external view returns (uint16 feeDiscBps, uint16 spreadDiscBps) {
        return EngineCore.discountOf(account);
    }

    /// @notice One way: after this no upgrade is possible.
    function freezeUpgrades() external onlyRole(DEFAULT_ADMIN_ROLE) {
        EngineStorage.layout().upgradesFrozen = true;
        emit UpgradesFrozen();
    }

    function _authorizeUpgrade(address) internal view override onlyRole(DEFAULT_ADMIN_ROLE) {
        if (EngineStorage.layout().upgradesFrozen) revert UpgradesAreFrozen();
    }

    function _checkPauser(bool paused) private view {
        if (hasRole(DEFAULT_ADMIN_ROLE, msg.sender)) return;
        if (!paused || !hasRole(GUARDIAN_ROLE, msg.sender)) revert NotGuardian();
    }

    // ---------------------------------------------------------------------------------------------------- trade

    /// @inheritdoc IOptionEngine
    function buy(bytes32 id, uint128 units, uint128 maxCostUsdg, uint64 deadline, address recipient)
        external
        nonReentrant
        returns (uint256 costUsdg, uint256 tokensMinted)
    {
        return EngineTradeLib.buy(HELPER, id, units, maxCostUsdg, deadline, recipient);
    }

    /// @notice `buy` after an EIP-2612 USDG permit to this engine (a failed permit is ignored; the allowance decides).
    function buyWithPermit(
        bytes32 id,
        uint128 units,
        uint128 maxCostUsdg,
        uint64 deadline,
        address recipient,
        uint256 permitValue,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external nonReentrant returns (uint256 costUsdg, uint256 tokensMinted) {
        try IERC20Permit(address(EngineStorage.layout().usdg)).permit(
            msg.sender, address(this), permitValue, deadline, v, r, s
        ) {} catch {}
        return EngineTradeLib.buy(HELPER, id, units, maxCostUsdg, deadline, recipient);
    }

    /// @inheritdoc IOptionEngine
    function sell(bytes32 id, uint128 tokens, uint128 minProceedsUsdg, uint64 deadline, address recipient)
        external
        nonReentrant
        returns (uint256 proceedsUsdg)
    {
        return EngineSellLib.sell(HELPER, msg.sender, id, tokens, minProceedsUsdg, deadline, recipient);
    }

    /// @notice The agent router sells `owner`'s tokens for them (review R04): the engine burns from the owner and prices,
    /// sizes and escrows exactly as the owner's own `sell` would (the owner's hold, balance, fee tier and ticket),
    /// paying the owner. Only the configured AgentRouter, which enforces the owner's agent policy (canSell, names).
    function sellFor(address owner, bytes32 id, uint128 tokens, uint128 minProceedsUsdg, uint64 deadline)
        external
        nonReentrant
        returns (uint256 proceedsUsdg)
    {
        if (msg.sender != EngineStorage.layout().agentRouter || msg.sender == address(0)) revert NotAgentRouter();
        return EngineSellLib.sell(HELPER, owner, id, tokens, minProceedsUsdg, deadline, owner);
    }

    /// @inheritdoc IOptionEngine
    function shield(address stockToken, uint128 tokenUnits, uint16 strikePctBelowBps, uint128 maxCostUsdg, uint64 deadline)
        external
        nonReentrant
        returns (bytes32 id, uint256 costUsdg)
    {
        return EngineTradeLib.shield(HELPER, stockToken, tokenUnits, strikePctBelowBps, maxCostUsdg, deadline);
    }

    /// @inheritdoc IOptionEngine
    function fillQueued(uint256 ticket) external nonReentrant returns (uint256 usdgOut) {
        return EngineSellLib.fillQueued(HELPER, ticket);
    }

    /// @inheritdoc IOptionEngine
    function cancelQueued(uint256 ticket) external nonReentrant {
        EngineSellLib.cancelQueued(ticket);
    }

    /// @notice Called by a series' option token before every holder-to-holder transfer (after it accrues). Review R02:
    /// tokens under the sender's open hold cannot move until it ends (the hold is bound to them and never handed to
    /// anyone, so nobody can write another account's hold); the sender's other tokens move freely.
    function onTokenTransfer(bytes32 id, address from, address, uint256 amount) external view {
        EngineStorage.Layout storage $ = EngineStorage.layout();
        address token = $.info[id].token;
        if (msg.sender != token || msg.sender == address(0)) revert NotSeriesToken();
        EngineStorage.Hold memory f = EngineCore.openHold(id, from);
        if (f.tokens != 0 && amount + f.tokens > IERC20(token).balanceOf(from)) revert HeldTokens(f.until);
    }

    /// @notice An account's hold on a series (until 0 or in the past: none): its S and how many of its tokens it binds.
    function holdOf(bytes32 id, address account) external view returns (EngineStorage.Hold memory) {
        return EngineStorage.layout().holds[id][account];
    }

    /// @notice Permissionless: takes series worth less than the minimum trade off the live list (review F08/F24).
    function retireDust(bytes32[] calldata ids) external nonReentrant returns (uint256 retired) {
        return EngineOpsLib.retireDust(HELPER, ids);
    }

    /// @notice Permissionless ORC-4: settles a stock HALTED for the settle delay at its last good price.
    function settleHalted(address stock) external nonReentrant returns (uint256 s) {
        return EngineOpsLib.settleHalted(stock);
    }

    /// @notice The ORC-4 settlement price of `stock` (0 = not settled).
    function settlePrice(address stock) external view returns (uint256) {
        return EngineStorage.layout().settleS[stock];
    }

    /// @notice The liability the Writer Pool prices LP flows at (review F12/F15): `high` an upper bound at today's
    /// prices (claims, checkpoint), else a lower bound (deposits). O(names). See EngineMarkLib.
    function navLiability(bool high) external view returns (uint256 liabilityWad) {
        return EngineMarkLib.navLiability(high);
    }

    function nameMark(address stock) external view returns (EngineStorage.NameMark memory) {
        return EngineStorage.layout().marks[stock];
    }

    /// @notice A name's NAV-mark tier (0 live, 1 dust; review R09/R07): envelope, units, pass and its last completion.
    function markTier(address stock, uint256 tier) external view returns (EngineStorage.MarkTier memory) {
        return EngineStorage.layout().tiers[stock][tier];
    }

    // --------------------------------------------------------------------------------------------------- accrue

    /// @inheritdoc IOptionEngine
    function accrue(bytes32 id) external {
        EngineStorage.SeriesInfo storage si = EngineStorage.layout().info[id];
        if (si.known && si.lastAccrual >= block.timestamp) return; // already accrued in this block: no delegatecall
        EngineOpsLib.accrue(HELPER, id);
    }

    /// @inheritdoc IOptionEngine
    /// @dev Also re-evaluates the stress budget and samples the NAV/share drawdown once at the end (keeper path).
    function accrueMany(bytes32[] calldata ids) external {
        EngineOpsLib.accrueMany(HELPER, ids);
    }

    /// @notice Re-evaluates the stress budget and the drawdown pause now (permissionless).
    function pokeRisk() external {
        EngineOpsLib.pokeRisk(HELPER);
    }

    /// @notice Registers up to `maxCount` registry series the engine has not seen yet (shield picks from these).
    function syncSeries(uint256 maxCount) external {
        EngineOpsLib.syncSeries(maxCount);
    }

    /// @notice Removes up to `maxCount` archived series from `stock`'s shield candidate list (permissionless; the
    /// keeper calls it after archiving). Shield also drops archived candidates it meets.
    function pruneShieldList(address stock, uint256 maxCount) external returns (uint256 removed) {
        return EngineOpsLib.pruneShieldList(stock, maxCount);
    }

    function shieldList(address stock) external view returns (bytes32[] memory) {
        return EngineStorage.layout().weeklyPuts[stock];
    }

    // ---------------------------------------------------------------------------------------------------- views

    /// @inheritdoc IOptionEngine
    function quote(bytes32 id, uint256 units, bool isBuy) external view returns (Quote memory) {
        return isBuy ? EngineOpsLib.quote(HELPER, id, units, true, address(0)) : EngineSellLib.quoteSell(HELPER, id, units, address(0));
    }

    /// @notice `quote` with `account`'s $LMNS fee tier applied (what that account's buy or sell would get).
    function quoteFor(bytes32 id, uint256 units, bool isBuy, address account) external view returns (Quote memory) {
        return isBuy ? EngineOpsLib.quote(HELPER, id, units, true, account) : EngineSellLib.quoteSell(HELPER, id, units, account);
    }

    /// @inheritdoc IOptionEngine
    function vMark(bytes32 id)
        external
        view
        returns (uint256 vWad, uint256 payoffWad, uint64 sigmaBps, SessionKind session)
    {
        return EngineOpsLib.vMark(HELPER, id);
    }

    /// @inheritdoc IOptionEngine
    function totalLiability() external view returns (uint256 liabilityWad) {
        return EngineViewLib.totalLiability(HELPER);
    }

    /// @inheritdoc IOptionEngine
    /// @dev The OUTSTANDING OPTIONS' aggregate Greeks (holders' long side; the pool is short exactly this), so the
    /// liability changes by about delta x dS / 1e18 + gamma x dS^2 / 2e36 (call delta positive). Delta and gamma in
    /// underlying units (WAD), vega in WAD USDG per vol point, from the name book (each series at its last touch).
    /// Decision of 2026-10-16 (todo 08 hand-off) over the todo text's "pool's own exposure".
    function netGreeks(address stock) external view returns (int256 deltaWad, int256 gammaWad, int256 vegaWad) {
        EngineStorage.NameBook storage nb = EngineStorage.layout().book[stock];
        return (nb.delta, int256(nb.gamma), int256(nb.vega));
    }

    /// @notice Worst stress-scenario loss of the current book (WAD USDG) and the NAV it is measured against.
    function stressLoss() external view returns (uint256 lossWad, int256 navWad) {
        return EngineViewLib.stressLoss(HELPER);
    }

    function params() external view returns (EngineHelper.Params memory) {
        return EngineStorage.layout().p;
    }

    function usdg() external view returns (IERC20) {
        return EngineStorage.layout().usdg;
    }

    function pool() external view returns (IPool) {
        return EngineStorage.layout().pool;
    }

    function registry() external view returns (ISeriesRegistry) {
        return EngineStorage.layout().registry;
    }

    function priceGuard() external view returns (IPriceGuard) {
        return EngineStorage.layout().priceGuard;
    }

    function volOracle() external view returns (IVolOracle) {
        return EngineStorage.layout().volOracle;
    }

    /// @return global global buy pause
    /// @return stress automatic stress-budget pause
    /// @return drawdown automatic drawdown pause
    /// @return frozen upgrades frozen
    function flags() external view returns (bool global, bool stress, bool drawdown, bool frozen) {
        EngineStorage.Layout storage $ = EngineStorage.layout();
        return ($.globalBuysPaused, $.stressPaused, $.drawdownPaused, $.upgradesFrozen);
    }

    function seriesBuysPaused(bytes32 id) external view returns (bool) {
        return EngineStorage.layout().seriesBuysPaused[id];
    }

    function hedgeDepthCapWad(address stock) external view returns (uint256) {
        return EngineStorage.layout().hedgeDepthCapWad[stock];
    }

    /// @inheritdoc IOptionEngine
    function bookValue() external view returns (uint256) {
        return EngineStorage.layout().bookValue;
    }

    /// @inheritdoc IOptionEngine
    function capBps() external view returns (uint16 totalCapNavBps, uint16 nameCapNavBps) {
        EngineHelper.Params storage p = EngineStorage.layout().p;
        return (p.totalCapNavBps, p.nameCapNavBps);
    }

    /// @notice Series of `stock` with outstanding tokens (what the keeper accrues; zero-supply series are skipped).
    function liveSeries(address stock) external view returns (bytes32[] memory) {
        return EngineStorage.layout().live[stock];
    }

    function ticketCount() external view returns (uint256) {
        return EngineStorage.layout().ticketCount;
    }

    function seriesInfo(bytes32 id) external view returns (EngineStorage.SeriesInfo memory) {
        return EngineStorage.layout().info[id];
    }

    function seriesRisk(bytes32 id) external view returns (EngineStorage.SeriesRisk memory) {
        return EngineStorage.layout().risk[id];
    }

    function nameBook(address stock) external view returns (EngineStorage.NameBook memory) {
        return EngineStorage.layout().book[stock];
    }

    function stocks() external view returns (address[] memory) {
        return EngineStorage.layout().stocks;
    }

    function seriesOfStock(address stock) external view returns (bytes32[] memory) {
        return EngineStorage.layout().byStock[stock];
    }

    function queuedSell(uint256 ticket) external view returns (EngineStorage.Ticket memory) {
        return EngineStorage.layout().tickets[ticket];
    }
}
