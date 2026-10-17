// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IOptionEngine} from "./interfaces/IOptionEngine.sol";
import {SessionKind} from "./libs/OptionTypes.sol";
import {EverlastingMath} from "./libs/EverlastingMath.sol";
import {EverlastingGreeks} from "./libs/EverlastingGreeks.sol";
import {FixedMath} from "./libs/FixedMath.sol";

/// @title EngineHelper
/// @notice Pure pricing, per-unit risk and parameter validation for LemniscateEngine, split out to keep the engine
/// under the EIP-170 size limit. The engine deploys one in its constructor and only ever staticcalls it.
/// @dev Quote rules (design decisions, "Canonical quote parameters"; mirrored by app/src/api/quote/model.ts):
///  - sigma(K) = sigmaBps x (1 + k_put max(0, -ln(K/S)) + k_call max(0, ln(K/S))), skewK = (k_put*1e4 << 32) | k_call*1e4
///    (decision 17), floored to whole bps and clamped to the pricing library's domain [10%, 300%]. A stale vol post
///    prices sells at sigma x (1 + staleVolBumpBps) = x 1.20.
///  - V_mark = V(sigma) x (1 + a x n), n = post-trade name vega / vega cap in [0, 1], a = inventoryBps (0.15).
///  - spread (bps of V_mark) = 150 + 250 x min(|K/S - 1| / 0.30, 1), x 1 / 1.5 / 3 for REGULAR / EXTENDED / otherwise,
///    at least minSpreadWad ($0.01) per unit. ask = V_mark + spread, bid = max(V_mark - spread, 0).
///  - fee = 3 bps of S x units on buys and sells, inside the quoted USDG. Buys round every term up, sells down.
///  - dailyCostUsdg = units x (V - payoff) x 86400 / tau; breakeven = K +/- (ask + 3 bps of S).
contract EngineHelper {
    uint256 private constant WAD = 1e18;
    uint256 private constant BPS = 10_000;
    uint256 private constant USDG_SCALE = 1e12; // WAD -> 6 dp
    uint256 private constant DAY = 86_400;
    uint256 private constant LN_SCALE = 1e40; // skew coefficients (1e4) x ln at 1e36

    /// @notice Stress scenario moves in bps of S, in the order of `PerUnit.sc`: -gap, -move, +move, +gap (spec 4.2).
    int256 public constant GAP_BPS = 2500;
    int256 public constant MOVE_BPS = 1000;

    /// @notice Admin-tunable engine parameters (three storage slots). Bounds in `validate`.
    struct Params {
        uint16 feeBps; // 3: fee in bps of S x units
        uint16 spreadAtmBps; // 150
        uint16 spreadFarBps; // 400
        uint16 farMoneynessBps; // 3000: |K/S - 1| where the spread reaches spreadFarBps
        uint16 extendedMultBps; // 15000: EXTENDED spread multiplier
        uint16 closedMultBps; // 30000: CLOSED / UNKNOWN / HALTED spread multiplier
        uint16 staleVolBumpBps; // 2000: sells on a stale vol post use sigma x 1.2
        uint16 inventoryBps; // 1500: a = 0.15
        uint16 extendedCapBps; // 5000: EXTENDED session caps are halved
        uint16 seriesCapNavBps; // 200: per-series outstanding value <= 2% NAV
        uint16 nameCapNavBps; // 800: per-name outstanding value <= 8% NAV
        uint16 totalCapNavBps; // 3500: total outstanding value <= 35% NAV
        uint16 vegaCapNavBps; // 60: per-name net short vega <= 0.6% NAV per vol point
        uint16 gammaCapNavBps; // 40: per-name gamma P&L of a 1% move <= 0.4% NAV
        uint16 stressBudgetBps; // 2000: stress loss <= 20% NAV
        uint16 drawdownBps; // 1500: NAV/share drawdown over 30 days that pauses buys
        uint128 minSpreadWad; // 0.01e18: smallest spread per option unit
        uint128 seriesCapWad; // 40_000e18: per-series outstanding value
        uint128 accountCapWad; // 25_000e18: per-account per-series option value
    }

    /// @notice Value and risk of ONE option unit (1e18 units) at S. sc[i] = V(S x (1 + move_i)) - V(S).
    struct PerUnit {
        uint256 v;
        uint256 payoff;
        int256 delta;
        uint256 gamma;
        uint256 vega;
        int256[4] sc;
    }

    struct PriceIn {
        bool isBuy;
        bool isCall;
        SessionKind session;
        uint32 tau;
        uint64 sigmaBps; // the sigma priced (reported)
        uint256 s;
        uint256 k;
        uint256 units;
        uint256 vPrice; // per-unit value at the priced sigma, before the inventory term
        uint256 payoff;
        uint256 vVal; // per-unit valuation (the liability mark), for the spread income split
        uint256 invWad; // n in [0, 1e18]
        uint16 feeDiscBps; // $LMNS fee tier: share of the fee waived (bps of the fee), bounded by the engine
        uint16 spreadDiscBps; // $LMNS fee tier: share of the spread waived (bps of the spread), bounded by the engine
    }

    /// @notice A series' (or a name's) risk: units x the per-unit fields, long side.
    struct Risk {
        uint256 value;
        int256 delta;
        uint256 gamma;
        uint256 vega;
        int256[4] sc;
    }

    struct BookIn {
        EngineHelper.PerUnit pu;
        Risk sNow; // the series as stored
        Risk nNow; // its name as stored
        uint256 tNow; // the engine's book value as stored
        uint256 supply;
        uint256 norm;
        uint256 tokens;
        bool isBuy;
        bool refresh; // re-evaluate the series at `norm` before the trade (accrual or the quote's simulated accrual)
    }

    struct Book {
        Risk sNow;
        Risk nNow;
        uint256 tNow;
        Risk sAfter;
        Risk nAfter;
        uint256 tAfter;
    }

    struct CapIn {
        uint256 nav; // > 0
        bool extended;
        uint256 seriesAfter;
        uint256 accountAfter;
        uint256 nameAfter;
        uint256 depthCap;
        uint256 totalAfter;
        uint256 vegaAfter;
        uint256 gammaAfter;
        uint256 s;
        uint256 stressLoss;
    }

    error InvalidParams(bytes32 field);

    // ------------------------------------------------------------------------------------------------ defaults

    function defaults() external pure returns (Params memory p) {
        p.feeBps = 3;
        p.spreadAtmBps = 150;
        p.spreadFarBps = 400;
        p.farMoneynessBps = 3000;
        p.extendedMultBps = 15_000;
        p.closedMultBps = 30_000;
        p.staleVolBumpBps = 2000;
        p.inventoryBps = 1500;
        p.extendedCapBps = 5000;
        p.seriesCapNavBps = 200;
        p.nameCapNavBps = 800;
        p.totalCapNavBps = 3500;
        p.vegaCapNavBps = 60;
        p.gammaCapNavBps = 40;
        p.stressBudgetBps = 2000;
        p.drawdownBps = 1500;
        p.minSpreadWad = 0.01e18;
        p.seriesCapWad = 40_000e18;
        p.accountCapWad = 25_000e18;
    }

    /// @notice Reverts `InvalidParams(field)` for any value outside its bounds.
    function validate(Params calldata p) external pure {
        _bound(p.feeBps, 0, 100, "feeBps");
        _bound(p.spreadAtmBps, 10, 2000, "spreadAtmBps");
        _bound(p.spreadFarBps, p.spreadAtmBps, 5000, "spreadFarBps");
        _bound(p.farMoneynessBps, 100, 10_000, "farMoneynessBps");
        _bound(p.extendedMultBps, 10_000, 50_000, "extendedMultBps");
        _bound(p.closedMultBps, p.extendedMultBps, 60_000, "closedMultBps");
        _bound(p.staleVolBumpBps, 0, 10_000, "staleVolBumpBps");
        _bound(p.inventoryBps, 0, 5000, "inventoryBps");
        _bound(p.extendedCapBps, 1000, 10_000, "extendedCapBps");
        _bound(p.seriesCapNavBps, 1, 2000, "seriesCapNavBps");
        _bound(p.nameCapNavBps, 1, 5000, "nameCapNavBps");
        _bound(p.totalCapNavBps, 1, 10_000, "totalCapNavBps");
        _bound(p.vegaCapNavBps, 1, 1000, "vegaCapNavBps");
        _bound(p.gammaCapNavBps, 1, 1000, "gammaCapNavBps");
        _bound(p.stressBudgetBps, 100, 5000, "stressBudgetBps");
        _bound(p.drawdownBps, 100, 5000, "drawdownBps");
        _bound(p.minSpreadWad, 0, 1e18, "minSpreadWad");
        _bound(p.seriesCapWad, 1e18, 1e27, "seriesCapWad");
        _bound(p.accountCapWad, 1e18, 1e27, "accountCapWad");
    }

    // ------------------------------------------------------------------------------------------------- pricing

    /// @notice Skewed (and optionally bumped) sigma in bps for strike K at S, clamped to the pricing domain.
    function sigmaFor(uint256 s, uint256 k, uint64 sigmaBps, uint64 skewK, uint256 bumpBps)
        public
        pure
        returns (uint64)
    {
        uint256 sig = uint256(sigmaBps) * (BPS + bumpBps) / BPS;
        uint256 kPut = (uint256(skewK) >> 32) & 0xffffffff;
        uint256 kCall = uint256(skewK) & 0xffffffff;
        if (kPut | kCall != 0) {
            int256 l = FixedMath.ln36(k) - FixedMath.ln36(s); // ln(K/S) at 1e36
            uint256 add = l < 0 ? kPut * uint256(-l) : kCall * uint256(l);
            sig = Math.mulDiv(sig, LN_SCALE + add, LN_SCALE);
        }
        if (sig < EverlastingMath.MIN_SIGMA_BPS) return EverlastingMath.MIN_SIGMA_BPS;
        if (sig > EverlastingMath.MAX_SIGMA_BPS) return EverlastingMath.MAX_SIGMA_BPS;
        return uint64(sig);
    }

    /// @notice Per-unit value, Greeks and stress-scenario changes at the skewed sigma. Inputs must be in the pricing
    /// domain (S and K in [1e12, 1e30]); the engine checks S before calling.
    function perUnit(bool isCall, uint256 s, uint256 k, uint64 sigmaBps, uint64 skewK, uint32 tau)
        external
        pure
        returns (PerUnit memory p, uint64 sigma)
    {
        sigma = sigmaFor(s, k, sigmaBps, skewK, 0);
        EverlastingGreeks.G memory g =
            isCall ? EverlastingGreeks.call(s, k, sigma, tau) : EverlastingGreeks.put(s, k, sigma, tau);
        p.v = g.v;
        p.delta = g.delta;
        p.gamma = g.gamma;
        p.vega = g.vega;
        p.payoff = _payoff(isCall, s, k);
        int256[4] memory moves = [-GAP_BPS, -MOVE_BPS, MOVE_BPS, GAP_BPS];
        for (uint256 i; i < 4; ++i) {
            uint256 s2 = uint256(int256(s) * (int256(BPS) + moves[i]) / int256(BPS));
            p.sc[i] = int256(_valueSafe(isCall, s2, k, sigma, tau)) - int256(p.v);
        }
    }

    /// @notice Per-unit value at the skewed sigma bumped by `bumpBps` (stale-vol sells), and that sigma.
    function valueAt(bool isCall, uint256 s, uint256 k, uint64 sigmaBps, uint64 skewK, uint256 bumpBps, uint32 tau)
        external
        pure
        returns (uint256 v, uint64 sigma)
    {
        sigma = sigmaFor(s, k, sigmaBps, skewK, bumpBps);
        v = isCall ? EverlastingMath.callValue(s, k, sigma, tau) : EverlastingMath.putValue(s, k, sigma, tau);
    }

    /// @notice The quote for `units` (IOptionEngine.Quote, `buyable` left false) and the spread income it carries:
    /// everything above (buys) or below (sells) the valuation mark, fee included, in USDG 6 dp.
    function price(PriceIn calldata a, Params calldata p)
        external
        pure
        returns (IOptionEngine.Quote memory q, uint256 spreadUsdg)
    {
        uint256 spreadBpsWad = _spreadBpsWad(a, p);
        q.spreadBps = _spreadBpsRounded(a, p);
        uint256 vMark = a.vPrice + Math.mulDiv(a.vPrice, uint256(p.inventoryBps) * a.invWad, BPS * WAD);
        uint256 spu = Math.mulDiv(vMark, spreadBpsWad, BPS * WAD);
        if (spu < p.minSpreadWad) spu = p.minSpreadWad;
        if (a.spreadDiscBps != 0) {
            spu = Math.mulDiv(spu, BPS - a.spreadDiscBps, BPS, Math.Rounding.Ceil);
            q.spreadBps = Math.mulDiv(q.spreadBps, BPS - a.spreadDiscBps, BPS, Math.Rounding.Ceil);
        }
        uint256 ask = vMark + spu;
        uint256 feeWad =
            Math.mulDiv(Math.mulDiv(a.s, a.units, WAD, Math.Rounding.Ceil), p.feeBps, BPS, Math.Rounding.Ceil);
        if (a.feeDiscBps != 0) feeWad = Math.mulDiv(feeWad, BPS - a.feeDiscBps, BPS, Math.Rounding.Ceil);
        q.feeUsdg = Math.ceilDiv(feeWad, USDG_SCALE);
        if (a.isBuy) {
            q.usdg = Math.ceilDiv(Math.mulDiv(ask, a.units, WAD, Math.Rounding.Ceil) + feeWad, USDG_SCALE);
            uint256 val = Math.mulDiv(a.vVal, a.units, WAD * USDG_SCALE);
            spreadUsdg = q.usdg > val ? q.usdg - val : 0;
        } else {
            uint256 bid = vMark > spu ? vMark - spu : 0;
            uint256 gross = Math.mulDiv(bid, a.units, WAD);
            q.usdg = gross > feeWad ? (gross - feeWad) / USDG_SCALE : 0;
            uint256 val = Math.mulDiv(a.vVal, a.units, WAD * USDG_SCALE, Math.Rounding.Ceil);
            spreadUsdg = val > q.usdg ? val - q.usdg : 0;
        }
        q.vMarkWad = vMark;
        uint256 tv = a.vPrice > a.payoff ? a.vPrice - a.payoff : 0;
        q.dailyCostUsdg = Math.ceilDiv(
            Math.mulDiv(tv * DAY, a.units, uint256(a.tau) * WAD, Math.Rounding.Ceil), USDG_SCALE
        );
        uint256 allIn = ask + Math.mulDiv(Math.mulDiv(a.s, p.feeBps, BPS), BPS - a.feeDiscBps, BPS);
        q.breakevenWad = a.isCall ? a.k + allIn : (a.k > allIn ? a.k - allIn : 0);
        q.sigmaBps = a.sigmaBps;
        q.session = a.session;
    }

    /// @notice Pool loss of the worst stress scenario (spec 4.2): a gap on one name (worst direction) plus a move on
    /// every other name (worst direction each). `sc[i]` are the names' option value changes (long side) for -gap,
    /// -move, +move, +gap; `hedgeValue[i]` the pool's spot hedge on that name in WAD USDG (units x S). Same formula as
    /// the replay simulator (app/src/sim/pool.ts stressLoss).
    function stressLoss(int256[4][] calldata sc, uint256[] calldata hedgeValue) external pure returns (uint256) {
        uint256 len = sc.length;
        if (len == 0) return 0;
        int256 sumMove;
        int256 bestExtra = type(int256).min;
        for (uint256 i; i < len; ++i) {
            int256 h = int256(hedgeValue[i]);
            // Hedge gain for a move m is h x m; the pool's loss is the option change minus the hedge gain.
            int256 down = sc[i][0] + h * GAP_BPS / int256(BPS);
            int256 m10 = _max(sc[i][1] + h * MOVE_BPS / int256(BPS), sc[i][2] - h * MOVE_BPS / int256(BPS));
            int256 up = sc[i][3] - h * GAP_BPS / int256(BPS);
            sumMove += m10;
            int256 extra = _max(up, down) - m10;
            if (extra > bestExtra) bestExtra = extra;
        }
        int256 worst = sumMove + bestExtra;
        return worst > 0 ? uint256(worst) : 0;
    }

    // ------------------------------------------------------------------------------------------- book and caps

    /// @notice The book of one series and its name now (optionally refreshed at `norm`) and after trading `tokens`.
    function book(BookIn calldata a) external pure returns (Book memory b) {
        b.sNow = a.sNow;
        b.nNow = a.nNow;
        b.tNow = a.tNow;
        if (a.refresh) {
            Risk memory fresh = scale(a.pu, Math.mulDiv(a.supply, a.norm, WAD));
            b.nNow = _swap(b.nNow, b.sNow, fresh);
            b.tNow = b.tNow - b.sNow.value + fresh.value;
            b.sNow = fresh;
        }
        uint256 supplyAfter = a.isBuy ? a.supply + a.tokens : a.supply - Math.min(a.tokens, a.supply);
        b.sAfter = scale(a.pu, Math.mulDiv(supplyAfter, a.norm, WAD));
        b.nAfter = _swap(b.nNow, b.sNow, b.sAfter);
        b.tAfter = b.tNow - b.sNow.value + b.sAfter.value;
    }

    /// @notice `units` x the per-unit risk.
    function scale(PerUnit memory pu, uint256 units) public pure returns (Risk memory r) {
        if (units == 0) return r;
        r.value = Math.mulDiv(units, pu.v, WAD);
        r.delta = _smul(units, pu.delta);
        r.gamma = Math.mulDiv(units, pu.gamma, WAD);
        r.vega = Math.mulDiv(units, pu.vega, WAD);
        for (uint256 i; i < 4; ++i) {
            r.sc[i] = _smul(units, pu.sc[i]);
        }
    }

    /// @notice Buy caps (spec 4.2, decision 6, R17/R21), each with its own `CapExceeded` kind, then the stress budget.
    /// EXTENDED halves the per-series, per-account and per-name caps (spec 4.3).
    function checkCaps(CapIn calldata a, Params calldata p) external pure {
        uint256 nav = a.nav;
        uint256 sc = a.extended ? p.extendedCapBps : BPS;
        if (a.seriesAfter > Math.min(p.seriesCapWad, nav * p.seriesCapNavBps / BPS) * sc / BPS) {
            revert IOptionEngine.CapExceeded("SERIES");
        }
        if (a.accountAfter > uint256(p.accountCapWad) * sc / BPS) revert IOptionEngine.CapExceeded("ACCOUNT");
        if (a.nameAfter > nav * p.nameCapNavBps / BPS * sc / BPS) revert IOptionEngine.CapExceeded("NAME");
        if (a.depthCap != 0 && a.nameAfter > a.depthCap * sc / BPS) revert IOptionEngine.CapExceeded("DEPTH");
        if (a.totalAfter > nav * p.totalCapNavBps / BPS) revert IOptionEngine.CapExceeded("TOTAL");
        if (a.vegaAfter > nav * p.vegaCapNavBps / BPS) revert IOptionEngine.CapExceeded("VEGA");
        uint256 dS = a.s / 100; // gamma P&L of a 1% move: gamma x dS^2 / 2
        if (Math.mulDiv(Math.mulDiv(a.gammaAfter, dS, WAD), dS, 2 * WAD) > nav * p.gammaCapNavBps / BPS) {
            revert IOptionEngine.CapExceeded("GAMMA");
        }
        if (a.stressLoss * BPS > nav * p.stressBudgetBps) {
            revert IOptionEngine.StressBudget(a.stressLoss * BPS / nav);
        }
    }

    /// @notice Reverts with the engine error for buy-block `code` (see LemniscateEngine._buyBlock).
    function revertBlock(uint8 code, bytes32 id, SessionKind session, address stock) external pure {
        if (code == 1 || code == 9) revert IOptionEngine.StalePrice();
        if (code == 2) revert IOptionEngine.SeriesNotBuyable(id);
        if (code == 3) revert IOptionEngine.BuysArePaused("GLOBAL");
        if (code == 4) revert IOptionEngine.BuysArePaused("SERIES");
        if (code == 5) revert IOptionEngine.BuysArePaused("STRESS");
        if (code == 6) revert IOptionEngine.BuysArePaused("DRAWDOWN");
        if (code == 7) revert IOptionEngine.BuysArePaused("HEDGE");
        if (code == 8) revert IOptionEngine.SessionBlocksBuys(session);
        if (code == 10) revert IOptionEngine.BuysArePaused("PRICE");
        if (code == 11) revert IOptionEngine.StaleVol();
        if (code == 12) revert IOptionEngine.EarningsBlock(stock);
    }

    // ------------------------------------------------------------------------------------------------ internal

    /// @dev name - out + in, field by field.
    function _swap(Risk memory name, Risk memory out, Risk memory in_) private pure returns (Risk memory r) {
        r.value = name.value - out.value + in_.value;
        r.delta = name.delta - out.delta + in_.delta;
        r.gamma = name.gamma - out.gamma + in_.gamma;
        r.vega = name.vega - out.vega + in_.vega;
        for (uint256 i; i < 4; ++i) {
            r.sc[i] = name.sc[i] - out.sc[i] + in_.sc[i];
        }
    }

    function _smul(uint256 units, int256 x) private pure returns (int256) {
        return x >= 0 ? int256(Math.mulDiv(units, uint256(x), WAD)) : -int256(Math.mulDiv(units, uint256(-x), WAD));
    }

    function _spreadBpsWad(PriceIn calldata a, Params calldata p) private pure returns (uint256) {
        uint256 away = a.k > a.s ? a.k - a.s : a.s - a.k;
        uint256 frac = Math.mulDiv(Math.mulDiv(away, WAD, a.s), BPS, p.farMoneynessBps);
        if (frac > WAD) frac = WAD;
        uint256 base = uint256(p.spreadAtmBps) * WAD + uint256(p.spreadFarBps - p.spreadAtmBps) * frac;
        return base * _mult(a, p) / BPS;
    }

    /// @dev The reported spread, rounded half up from the exact rational (the WAD form floors twice).
    function _spreadBpsRounded(PriceIn calldata a, Params calldata p) private pure returns (uint256) {
        uint256 away = a.k > a.s ? a.k - a.s : a.s - a.k;
        uint256 den = a.s * p.farMoneynessBps; // <= 1e34
        uint256 x = Math.min(away * BPS, den);
        uint256 num = (uint256(p.spreadAtmBps) * den + uint256(p.spreadFarBps - p.spreadAtmBps) * x) * _mult(a, p);
        den *= BPS;
        return (num + den / 2) / den;
    }

    function _mult(PriceIn calldata a, Params calldata p) private pure returns (uint256) {
        if (a.session == SessionKind.REGULAR) return BPS;
        return a.session == SessionKind.EXTENDED ? p.extendedMultBps : p.closedMultBps;
    }

    function _valueSafe(bool isCall, uint256 s, uint256 k, uint64 sigma, uint32 tau) private pure returns (uint256) {
        if (s < EverlastingMath.MIN_PRICE_WAD || s > EverlastingMath.MAX_PRICE_WAD) return _payoff(isCall, s, k);
        return isCall ? EverlastingMath.callValue(s, k, sigma, tau) : EverlastingMath.putValue(s, k, sigma, tau);
    }

    function _payoff(bool isCall, uint256 s, uint256 k) private pure returns (uint256) {
        if (isCall) return s > k ? s - k : 0;
        return k > s ? k - s : 0;
    }

    function _max(int256 a, int256 b) private pure returns (int256) {
        return a > b ? a : b;
    }

    function _bound(uint256 v, uint256 lo, uint256 hi, bytes32 field) private pure {
        if (v < lo || v > hi) revert InvalidParams(field);
    }
}
