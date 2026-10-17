// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IHedgeAdapter} from "../interfaces/IHedgeAdapter.sol";
import {IOptionEngine} from "../interfaces/IOptionEngine.sol";
import {IPriceGuard} from "../interfaces/IPriceGuard.sol";
import {IPriceReference} from "../interfaces/IPriceReference.sol";
import {IReserve} from "../interfaces/IReserve.sol";
import {ILmnsStaking} from "../interfaces/ILmnsStaking.sol";
import {PriceReading, SessionKind} from "./OptionTypes.sol";

/// @title PoolHedging
/// @notice The Writer Pool's spot hedge book: valuation of held Stock Tokens, the NAV guard move, TWAP-floored swaps
/// and cash raising. External library (delegatecalled, runs in the pool's storage and balance) so the pool stays under
/// the contract size limit. Deployments link it into WriterPool.
library PoolHedging {
    using SafeERC20 for IERC20;

    uint256 private constant BPS = 10_000;
    uint256 private constant STOCK_VALUE_DENOMINATOR = 1e30; // raw stock units x WAD price -> USDG 6 dp

    struct Route {
        IHedgeAdapter adapter;
        uint24 fee;
    }

    /// @dev Pool storage for the hedge book.
    struct Book {
        address[] stocks;
        mapping(address stock => Route) routes;
        mapping(address stock => uint256 units) units;
    }

    /// @dev The pool's NAV at one moment (WAD unless noted). Built by `valuation`.
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

    /// @dev Pool state `valuation` reads (passed in so the pool keeps one small call site).
    struct ValIn {
        IERC20 usdg;
        IPriceGuard priceGuard;
        IOptionEngine engine;
        IReserve reserve;
        ILmnsStaking staking;
        uint256 liability;
        uint256 supply;
        uint256 feeOwed; // USDG 6 dp
        uint256 highWaterNavPerShare;
        uint256 lastNavUsdg;
        uint16 openBps;
        uint16 closedBps;
        bool guard;
    }

    /// @dev Pool parameters the library reads.
    struct Ctx {
        IERC20 usdg;
        IPriceGuard priceGuard;
        IPriceReference priceReference;
        uint16 maxSlippageBps;
        uint256 navUsdg; // the pool's last checkpointed NAV, USDG 6 dp
    }

    /// @dev Perp-venue equity (decision 19) and the hedger's on-chain bounds (security review 2026-10-17, F03/F17).
    /// Two slots, laid out where the pool kept `_equityUsdg` and `_equityAsOf`.
    struct Guard {
        uint256 equityUsdg;
        uint64 equityAsOf;
        uint16 maxPerpEquityBps; // of the pool's last NAV; 0 = perps off (launch): no positive equity is ever counted
        uint16 maxHedgeLossBps; // F27: realised rebalance loss allowed per UTC day, bps of the last NAV (0 = default)
        bool frozen; // F27: guardian stop for every hedger action; only the admin clears it
        uint32 lossDay;
        uint96 lossUsdg; // realised rebalance loss booked on `lossDay`, USDG 6 dp
    }

    uint256 private constant EQUITY_STALE_AFTER = 2 hours;
    uint256 private constant EQUITY_MAX_MOVE_BPS_PER_HOUR = 1_000;
    /// @notice Ceiling of `maxPerpEquityBps`: perp equity can never be more than 20% of NAV.
    uint16 internal constant MAX_PERP_EQUITY_BPS = 2_000;
    /// @notice Daily realised rebalance-loss budget: 0.5% of NAV unless the admin sets another value (at most 2%).
    uint16 internal constant DEFAULT_HEDGE_LOSS_BPS = 50;
    uint16 internal constant MAX_HEDGE_LOSS_BPS = 200;

    /// @dev Same signatures as IPool's events, so logs read the same whichever contract emits them.
    event HedgeEquityPosted(uint256 equityUsdg, uint64 asOf, bytes32 ref);
    event HedgerLimitsSet(uint16 maxPerpEquityBps, uint16 maxHedgeLossBps);
    event HedgerFrozenSet(bool frozen);
    event Rebalanced(address indexed stock, bool buy, uint256 amountIn, uint256 amountOut, uint256 unitsAfter);
    event CashRaised(address indexed stock, uint256 stockSold, uint256 usdgOut);

    error InvalidRoute();
    error StalePrice(address stock);
    error NoCash();
    error HedgeJump(uint256 previous, uint256 posted);
    error BadAsOf(uint64 asOf);
    error PerpEquityCap(uint256 posted, uint256 cap);
    error InvalidParams();
    error HedgerFrozen();
    error HedgeLossBudget(uint256 lossUsdg, uint256 budgetUsdg);

    // ---------------------------------------------------------------- perp equity (F03/F17)

    /// @dev Records a perp-venue equity snapshot. Whatever `ref` says (it is only logged), every post obeys the same two
    /// bounds: it may not rise above `maxPerpEquityBps` of the pool's last NAV, and it may not move by more than 10% of
    /// max(previous, cap) per hour of `asOf` progress (at most one hour counts per post). With the cap at 0 (launch,
    /// perps off) only zero can ever be posted.
    function postEquity(Guard storage g, uint256 equityUsdg, uint64 asOf, bytes32 ref, uint256 navUsdg) external {
        if (g.frozen) revert HedgerFrozen();
        uint64 prevAsOf = g.equityAsOf;
        if (asOf > block.timestamp || asOf <= prevAsOf) revert BadAsOf(asOf);
        uint256 prev = g.equityUsdg;
        uint256 cap = Math.mulDiv(navUsdg, g.maxPerpEquityBps, BPS);
        if (equityUsdg > cap && equityUsdg > prev) revert PerpEquityCap(equityUsdg, cap);
        uint256 dt = prevAsOf == 0 || asOf - prevAsOf > 1 hours ? 1 hours : asOf - prevAsOf;
        uint256 allowed = Math.mulDiv(prev > cap ? prev : cap, EQUITY_MAX_MOVE_BPS_PER_HOUR * dt, BPS * 1 hours);
        if ((equityUsdg > prev ? equityUsdg - prev : prev - equityUsdg) > allowed) revert HedgeJump(prev, equityUsdg);
        g.equityUsdg = equityUsdg;
        g.equityAsOf = asOf;
        emit HedgeEquityPosted(equityUsdg, asOf, ref);
    }

    /// @dev Setter body (kept here so the pool stays under the size limit). The pool has checked the caller: the admin
    /// sets everything; a guardian (`isAdmin` false) may only freeze.
    function setLimits(Guard storage g, uint16 maxPerpEquityBps, uint16 maxHedgeLossBps, bool frozen, bool isAdmin)
        external
    {
        if (isAdmin) {
            if (maxPerpEquityBps > MAX_PERP_EQUITY_BPS || maxHedgeLossBps == 0 || maxHedgeLossBps > MAX_HEDGE_LOSS_BPS) {
                revert InvalidParams();
            }
            g.maxPerpEquityBps = maxPerpEquityBps;
            g.maxHedgeLossBps = maxHedgeLossBps;
            emit HedgerLimitsSet(maxPerpEquityBps, maxHedgeLossBps);
        }
        if (g.frozen != frozen) {
            g.frozen = frozen;
            emit HedgerFrozenSet(frozen);
        }
    }

    /// @dev (maxPerpEquityBps, maxHedgeLossBps in force, frozen, realised rebalance loss booked today in USDG).
    function limits(Guard storage g) external view returns (uint16, uint16, bool, uint256) {
        uint16 lossBps = g.maxHedgeLossBps;
        return (
            g.maxPerpEquityBps,
            lossBps == 0 ? DEFAULT_HEDGE_LOSS_BPS : lossBps,
            g.frozen,
            g.lossDay == uint32(block.timestamp / 1 days) ? g.lossUsdg : 0
        );
    }

    /// @dev Equity counted in NAV: zero once stale (2h), and never above the current cap (so it can neither inflate NAV
    /// past the cap nor overflow the valuation).
    function _perpEquity(Guard storage g, uint256 navUsdg) private view returns (uint256 e) {
        uint64 asOf = g.equityAsOf;
        if (asOf == 0 || block.timestamp > uint256(asOf) + EQUITY_STALE_AFTER) return 0;
        e = g.equityUsdg;
        uint256 cap = Math.mulDiv(navUsdg, g.maxPerpEquityBps, BPS);
        if (e > cap) e = cap;
    }

    // ---------------------------------------------------------------- valuation

    uint256 private constant USDG_TO_WAD = 1e12;
    uint256 private constant SHARE_UNIT = 1e12;

    /// @dev The pool's NAV (kept here, one copy, so the pool stays under the size limit): cash - fees owed + fresh perp
    /// equity (clamped to its cap) + spot hedges at the PriceGuard price - liability, plus the reserve share. With
    /// `guard`, also the NAV change for an adverse feed move of openBps (live session) or closedBps (otherwise) per
    /// stock, from the hedge and the engine's net greeks of the outstanding options (liability change = delta dS +
    /// gamma dS^2 / 2).
    function valuation(Book storage b, Guard storage g, ValIn memory x) external view returns (Valuation memory v) {
        v.liability = x.liability;
        v.supply = x.supply;
        v.cash = x.usdg.balanceOf(address(this));
        int256 gross = _toInt(v.cash * USDG_TO_WAD) - _toInt(x.feeOwed * USDG_TO_WAD);
        gross += _toInt(_perpEquity(g, x.lastNavUsdg) * USDG_TO_WAD);
        (uint256 hedgeWad, int256 up, int256 down, uint256[] memory prices) =
            _value(b, x.priceGuard, x.engine, x.guard, x.openBps, x.closedBps);
        v.prices = prices;
        gross += _toInt(hedgeWad);
        v.raw = gross - _toInt(x.liability);
        v.reserveShare = _reserveShare(x, v.raw);
        v.nav = v.raw + _toInt(v.reserveShare);
        v.navLow = v.nav + down;
        v.navHigh = v.nav + up;
    }

    /// @dev The part of the first-loss layers needed to lift NAV per share back to the high-water mark: the reserve
    /// first, then the staked $LMNS cover (read only when the reserve alone falls short).
    function _reserveShare(ValIn memory x, int256 raw) private view returns (uint256) {
        uint256 hwm = x.highWaterNavPerShare;
        if (x.supply == 0 || hwm == 0) return 0;
        int256 defended = _toInt(Math.mulDiv(hwm, x.supply, SHARE_UNIT));
        if (raw >= defended) return 0;
        uint256 deficit = uint256(defended - raw);
        uint256 bal = address(x.reserve) == address(0) ? 0 : x.usdg.balanceOf(address(x.reserve)) * USDG_TO_WAD;
        if (deficit <= bal) return deficit;
        if (address(x.staking) != address(0)) bal += x.staking.coverValueUsdg() * USDG_TO_WAD;
        return deficit < bal ? deficit : bal;
    }

    function _toInt(uint256 value) private pure returns (int256) {
        if (value > uint256(type(int256).max)) revert InvalidParams();
        return int256(value);
    }

    /// @dev Returns hedgeWad (sum of units x S over tracked stocks, WAD USDG), up (sum of positive best-case guard
    /// moves), down (sum of negative worst-case guard moves) and prices (S per tracked stock, 0 when not read).
    function _value(
        Book storage b,
        IPriceGuard pg,
        IOptionEngine engine,
        bool guard,
        uint16 openBps,
        uint16 closedBps
    ) private view returns (uint256 hedgeWad, int256 up, int256 down, uint256[] memory prices) {
        uint256 count = b.stocks.length;
        prices = new uint256[](count);
        for (uint256 i; i < count; ++i) {
            address stock = b.stocks[i];
            uint256 units = b.units[stock];
            if (units == 0 && !guard) continue;
            (uint256 s, bool live) = price(pg, stock);
            prices[i] = s;
            uint256 hv = Math.mulDiv(units, s, 1e18);
            hedgeWad += hv;
            if (!guard || address(engine) == address(0)) continue;
            (int256 best, int256 worst) = _guardMove(engine, stock, s, hv, live ? openBps : closedBps);
            if (best > 0) up += best;
            if (worst < 0) down += worst;
        }
    }

    /// @dev Hedges at their slippage floor, USDG 6 dp, from the prices `value` returned.
    function liquidHedges(Book storage b, uint256[] memory prices, uint16 maxSlippageBps)
        external
        view
        returns (uint256 liquid)
    {
        uint256 count = b.stocks.length;
        for (uint256 i; i < count; ++i) {
            uint256 units = b.units[b.stocks[i]];
            if (units != 0 && prices[i] != 0) liquid += _minUsdgOut(units, prices[i], maxSlippageBps);
        }
    }

    /// @dev PriceGuard S for valuation: `readLite` (decision 15) when PriceGuard has it, else `read`; the last good
    /// price when the reading carries none. `fresh` = a live (REGULAR/EXTENDED) fresh reading.
    function price(IPriceGuard pg, address stock) public view returns (uint256 s, bool fresh) {
        PriceReading memory r;
        (bool ok, bytes memory ret) = address(pg).staticcall(abi.encodeWithSignature("readLite(address)", stock));
        if (ok && ret.length >= 160) r = abi.decode(ret, (PriceReading));
        else r = pg.read(stock);
        s = r.s;
        if (s == 0) (s,) = pg.lastGoodPrice(stock);
        fresh = r.fresh && (r.session == SessionKind.REGULAR || r.session == SessionKind.EXTENDED);
    }

    /// @dev NAV change for a feed move of +/- moveBps: hedge gains units x dS; the liability changes by
    /// delta x dS + gamma x dS^2 / 2 (engine net greeks of the outstanding options, WAD).
    function _guardMove(IOptionEngine engine, address stock, uint256 s, uint256 hedgeValue, uint256 moveBps)
        private
        view
        returns (int256 best, int256 worst)
    {
        if (moveBps == 0 || s == 0) return (0, 0);
        (int256 delta, int256 gamma,) = engine.netGreeks(stock);
        int256 dS = int256(s * moveBps / BPS);
        int256 hedgeMove = int256(hedgeValue * moveBps / BPS);
        int256 deltaMove = delta * dS / 1e18;
        int256 gammaMove = gamma * dS / 1e18 * dS / 2e18;
        int256 upMove = hedgeMove - deltaMove - gammaMove;
        int256 downMove = deltaMove - hedgeMove - gammaMove;
        (best, worst) = upMove > downMove ? (upMove, downMove) : (downMove, upMove);
    }

    // ---------------------------------------------------------------- trading

    /// @dev Moves the hedge in `stock` toward `targetUnits`. Buys spend at most min(maxIn, spendable) USDG and expect
    /// at least amountIn / min(S, TWAP) units less slippage; sells expect at least units x max(S, TWAP) less slippage
    /// (and at least the caller's `minOutOrMaxIn`). Requires a fresh live price. F27: refused while the guardian has frozen
    /// the hedger, and each trade's realised loss against the feed price S is booked against a daily budget (bps of the
    /// last NAV); the trade that would exceed it reverts. That bounds what a compromised hedger can lose to a pool it
    /// sandwiches, however many times it trades.
    function rebalance(
        Book storage b,
        Guard storage g,
        Ctx memory c,
        address stock,
        uint256 targetUnits,
        uint256 minOutOrMaxIn,
        uint256 spendable
    ) external returns (int256 unitsDelta) {
        if (g.frozen) revert HedgerFrozen();
        Route memory r = b.routes[stock];
        if (address(r.adapter) == address(0)) revert InvalidRoute();
        (uint256 s, bool fresh) = price(c.priceGuard, stock);
        if (!fresh || s == 0) revert StalePrice(stock);
        uint256 current = b.units[stock];
        if (targetUnits == current) return 0;
        uint256 twap = _twap(c.priceReference, stock, r.fee);

        if (targetUnits > current) {
            uint256 amountIn = Math.mulDiv(targetUnits - current, s, STOCK_VALUE_DENOMINATOR, Math.Rounding.Ceil);
            if (minOutOrMaxIn != 0 && amountIn > minOutOrMaxIn) amountIn = minOutOrMaxIn;
            if (amountIn > spendable) amountIn = spendable;
            if (amountIn == 0) revert NoCash();
            uint256 ref = twap != 0 && twap < s ? twap : s;
            uint256 minOut =
                Math.mulDiv(Math.mulDiv(amountIn, STOCK_VALUE_DENOMINATOR, ref), BPS - c.maxSlippageBps, BPS);
            (uint256 spent, uint256 received) = _swap(r, address(c.usdg), stock, amountIn, minOut);
            uint256 fair = Math.mulDiv(received, s, STOCK_VALUE_DENOMINATOR);
            _bookLoss(g, spent > fair ? spent - fair : 0, c.navUsdg);
            b.units[stock] = current + received;
            unitsDelta = int256(received);
            emit Rebalanced(stock, true, spent, received, current + received);
        } else {
            uint256 sellUnits = current - targetUnits;
            uint256 minOut = _minUsdgOut(sellUnits, twap > s ? twap : s, c.maxSlippageBps);
            if (minOutOrMaxIn > minOut) minOut = minOutOrMaxIn;
            (uint256 sold, uint256 received) = _swap(r, stock, address(c.usdg), sellUnits, minOut);
            uint256 fair = Math.mulDiv(sold, s, STOCK_VALUE_DENOMINATOR, Math.Rounding.Ceil);
            _bookLoss(g, fair > received ? fair - received : 0, c.navUsdg);
            b.units[stock] = current - sold;
            unitsDelta = -int256(sold);
            emit Rebalanced(stock, false, sold, received, current - sold);
        }
    }

    /// @dev Sells hedges until cash plus the accumulated execution shortfall covers `amount` (or, with `fullCash`,
    /// until cash alone does: sales are grossed up by the slippage allowance). A failing route is skipped. Sale floor:
    /// the higher of the PriceGuard price and the pool TWAP, less the slippage allowance. Never reverts for lack of
    /// cash; the caller checks the result.
    function ensureCash(Book storage b, Ctx memory c, uint256 amount, bool fullCash)
        external
        returns (uint256 shortfall)
    {
        uint256 count = b.stocks.length;
        for (uint256 i; i < count; ++i) {
            uint256 cash = c.usdg.balanceOf(address(this));
            uint256 covered = fullCash ? cash : cash + shortfall;
            if (covered >= amount) break;
            address stock = b.stocks[i];
            uint256 units = b.units[stock];
            Route memory r = b.routes[stock];
            if (units == 0 || address(r.adapter) == address(0)) continue;
            (uint256 s,) = price(c.priceGuard, stock);
            uint256 twap = _twap(c.priceReference, stock, r.fee);
            uint256 p = twap > s ? twap : s;
            if (p == 0) continue;

            uint256 unitsNeeded = Math.mulDiv(amount - covered, STOCK_VALUE_DENOMINATOR, p, Math.Rounding.Ceil);
            if (fullCash) unitsNeeded = Math.mulDiv(unitsNeeded, BPS, BPS - c.maxSlippageBps, Math.Rounding.Ceil);
            uint256 toSell = unitsNeeded < units ? unitsNeeded : units;
            (bool ok, uint256 sold, uint256 received) =
                _trySwap(r, stock, address(c.usdg), toSell, _minUsdgOut(toSell, p, c.maxSlippageBps));
            if (!ok) continue;
            b.units[stock] = units - sold;
            uint256 v = Math.mulDiv(sold, p, STOCK_VALUE_DENOMINATOR, Math.Rounding.Ceil);
            if (v > received) shortfall += v - received;
            emit CashRaised(stock, sold, received);
        }
    }

    function _bookLoss(Guard storage g, uint256 loss, uint256 navUsdg) private {
        uint32 day = uint32(block.timestamp / 1 days);
        uint256 used = (g.lossDay == day ? g.lossUsdg : 0) + loss;
        uint16 bps = g.maxHedgeLossBps;
        uint256 budget = Math.mulDiv(navUsdg, bps == 0 ? DEFAULT_HEDGE_LOSS_BPS : bps, BPS);
        if (used > budget) revert HedgeLossBudget(used, budget);
        g.lossDay = day;
        g.lossUsdg = uint96(used);
    }

    function _twap(IPriceReference ref, address stock, uint24 fee) private view returns (uint256) {
        if (address(ref) == address(0)) return 0;
        try ref.referencePrice(stock, fee) returns (uint256 twap) {
            return twap;
        } catch {
            return 0;
        }
    }

    function _swap(Route memory r, address tokenIn, address tokenOut, uint256 amountIn, uint256 minOut)
        private
        returns (uint256 actualIn, uint256 actualOut)
    {
        bool ok;
        (ok, actualIn, actualOut) = _trySwap(r, tokenIn, tokenOut, amountIn, minOut);
        if (!ok) revert InvalidRoute();
    }

    /// @dev Exact approval, cleared after. Balance deltas must equal amountIn and reach minOut; a swap that executed
    /// but fails those checks reverts the whole call (try/catch would not undo it).
    function _trySwap(Route memory r, address tokenIn, address tokenOut, uint256 amountIn, uint256 minOut)
        private
        returns (bool ok, uint256 actualIn, uint256 actualOut)
    {
        IERC20 input = IERC20(tokenIn);
        IERC20 output = IERC20(tokenOut);
        uint256 inBefore = input.balanceOf(address(this));
        uint256 outBefore = output.balanceOf(address(this));
        input.forceApprove(address(r.adapter), amountIn);
        try r.adapter.swapExactIn(tokenIn, tokenOut, r.fee, amountIn, minOut, address(this)) returns (uint256 reported)
        {
            uint256 inAfter = input.balanceOf(address(this));
            uint256 outAfter = output.balanceOf(address(this));
            if (inAfter <= inBefore && outAfter >= outBefore) {
                actualIn = inBefore - inAfter;
                actualOut = outAfter - outBefore;
                ok = actualIn == amountIn && reported >= minOut && actualOut >= minOut;
            }
        } catch {}
        input.forceApprove(address(r.adapter), 0);
        if (!ok) {
            if (input.balanceOf(address(this)) != inBefore) revert InvalidRoute();
            (actualIn, actualOut) = (0, 0);
        }
    }

    function _minUsdgOut(uint256 stockUnits, uint256 p, uint16 maxSlippageBps) private pure returns (uint256) {
        return Math.mulDiv(Math.mulDiv(stockUnits, p, STOCK_VALUE_DENOMINATOR), BPS - maxSlippageBps, BPS);
    }
}
