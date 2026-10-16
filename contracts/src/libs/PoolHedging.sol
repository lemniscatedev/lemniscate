// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IHedgeAdapter} from "../interfaces/IHedgeAdapter.sol";
import {IOptionEngine} from "../interfaces/IOptionEngine.sol";
import {IPriceGuard} from "../interfaces/IPriceGuard.sol";
import {IPriceReference} from "../interfaces/IPriceReference.sol";
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

    /// @dev Pool parameters the library reads.
    struct Ctx {
        IERC20 usdg;
        IPriceGuard priceGuard;
        IPriceReference priceReference;
        uint16 maxSlippageBps;
    }

    /// @dev Same signatures as IPool's events, so logs read the same whichever contract emits them.
    event Rebalanced(address indexed stock, bool buy, uint256 amountIn, uint256 amountOut, uint256 unitsAfter);
    event CashRaised(address indexed stock, uint256 stockSold, uint256 usdgOut);

    error InvalidRoute();
    error StalePrice(address stock);
    error NoCash();

    // ---------------------------------------------------------------- valuation

    /// @dev Returns hedgeWad (sum of units x S over tracked stocks, WAD USDG), up (sum of positive best-case guard
    /// moves), down (sum of negative worst-case guard moves) and prices (S per tracked stock, 0 when not read).
    function value(
        Book storage b,
        IPriceGuard pg,
        IOptionEngine engine,
        bool guard,
        uint16 openBps,
        uint16 closedBps
    ) external view returns (uint256 hedgeWad, int256 up, int256 down, uint256[] memory prices) {
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
    /// (and at least the caller's `minOutOrMaxIn`). Requires a fresh live price.
    function rebalance(
        Book storage b,
        Ctx memory c,
        address stock,
        uint256 targetUnits,
        uint256 minOutOrMaxIn,
        uint256 spendable
    ) external returns (int256 unitsDelta) {
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
            b.units[stock] = current + received;
            unitsDelta = int256(received);
            emit Rebalanced(stock, true, spent, received, current + received);
        } else {
            uint256 sellUnits = current - targetUnits;
            uint256 minOut = _minUsdgOut(sellUnits, twap > s ? twap : s, c.maxSlippageBps);
            if (minOutOrMaxIn > minOut) minOut = minOutOrMaxIn;
            (uint256 sold, uint256 received) = _swap(r, stock, address(c.usdg), sellUnits, minOut);
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
