// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {PriceReading, SessionKind, Speed, VolReading} from "../libs/OptionTypes.sol";
import {EngineStorage} from "./EngineStorage.sol";

/// @title EngineMarkLib
/// @notice The liability the Writer Pool prices LP entries and exits at (review F12/F15). `bookValue` holds every
/// series at its last touch while the pool marks its hedges at today's S, so between keeper re-marks a deposit or a
/// claim was priced on a stale liability (and a caller could re-mark only the series that suit them). This library
/// keeps, per name, O(1) sums over the series' last marks and turns them into a bound on today's liability:
///  - lower bound (deposits): bookValue + sum of delta_i x (S - S_i), the tangent at each series' mark (option values
///    are convex in S), less the most funding can have taken since the name's last full re-mark (value x dt / tau per
///    speed, follow-up B2), floored at minus the name's book value;
///  - upper bound (claims, the high-water checkpoint): bookValue + call units x max(0, S - lo) + put units x
///    max(0, hi - S), since |dV/dS| <= 1 per unit and every mark S_i lies in the envelope [lo, hi];
///  - plus a first-order vol term per speed, vega x (sigma now - sigma at the mark), 1.5x on the side that hurts the
///    caller.
/// A selective re-mark moves a series' stored value toward the truth and its mark into the envelope, so it never
/// widens what a caller gets. When every live series of a name is re-marked at one S (the keeper's accrueMany), the
/// envelope collapses to that S and both bounds equal the exact liability. Cost: one readLite and two vol reads per
/// name, never a loop over series. External library, delegatecalled by the engine.
library EngineMarkLib {
    uint256 private constant WAD = 1e18;
    uint256 private constant VOL_POINT_BPS = 100;
    uint256 private constant DAILY = 86_400;
    uint256 private constant WEEKLY = 604_800;

    /// @dev Replaces series `id`'s contribution (old delta and vega, units and mark S / sigma as stored) with the new
    /// one at mark S `s` and base sigma `sigma`. Internal: inlined into the trade and accrual libraries (gas).
    function update(
        bytes32 id,
        address stock,
        uint32 tau,
        bool isCall,
        int256[2] memory delta,
        uint256[2] memory vega,
        uint256[2] memory value,
        uint256 units,
        uint256 s,
        uint64 sigma
    ) internal {
        EngineStorage.Layout storage $ = EngineStorage.layout();
        EngineStorage.SeriesMark storage m = $.seriesMarks[id];
        EngineStorage.NameMark storage n = $.marks[stock];
        uint256 sp = tau == 86_400 ? 0 : 1;
        if (m.s != 0) {
            n.d -= delta[0];
            n.ds -= _smul(delta[0], m.s);
            if (isCall) n.uCall -= m.units;
            else n.uPut -= m.units;
            n.vg[sp] -= vega[0];
            n.vb[sp] -= vega[0] * m.sigma;
        }
        n.val[sp] = n.val[sp] + value[1] - value[0];
        if (n.lo == 0) n.tc = uint64(block.timestamp);
        n.d += delta[1];
        n.ds += _smul(delta[1], s);
        if (isCall) n.uCall += units;
        else n.uPut += units;
        n.vg[sp] += vega[1];
        uint24 sg = sigma > type(uint24).max ? type(uint24).max : uint24(sigma);
        n.vb[sp] += vega[1] * sg;
        m.s = uint104(s);
        m.units = uint128(units);
        m.sigma = sg;
        if (n.lo == 0 || s < n.lo) n.lo = uint128(s);
        if (s > n.hi) n.hi = uint128(s);
    }

    /// @dev Every live series of `stock` is marked at `s` now: the envelope collapses to it.
    function collapse(address stock, uint256 s) public {
        EngineStorage.NameMark storage n = EngineStorage.layout().marks[stock];
        n.lo = uint128(s);
        n.hi = uint128(s);
        n.tc = uint64(block.timestamp);
    }

    /// @notice The liability bound at today's prices: `high` the upper bound (claims), else the lower bound (deposits).
    /// A name without a usable price now (HALTED, settled or no reading) keeps its book value.
    function navLiability(bool high) public view returns (uint256) {
        EngineStorage.Layout storage $ = EngineStorage.layout();
        int256 total = int256($.bookValue);
        for (uint256 i; i < $.stocks.length; ++i) {
            address stock = $.stocks[i];
            if ($.live[stock].length == 0) continue;
            PriceReading memory r = $.priceGuard.readLite(stock);
            if (r.s == 0 || r.session == SessionKind.HALTED) continue;
            total += _adjust($, stock, r.s, high);
        }
        return total > 0 ? uint256(total) : 0;
    }

    function _adjust(EngineStorage.Layout storage $, address stock, uint256 s, bool high) private view returns (int256 a) {
        EngineStorage.NameMark storage n = $.marks[stock];
        int256 vol;
        for (uint256 sp; sp < 2; ++sp) {
            VolReading memory v = $.volOracle.read(stock, sp == 0 ? Speed.DAILY : Speed.WEEKLY);
            if (v.sigmaBps == 0) continue;
            vol += (int256(n.vg[sp] * v.sigmaBps) - int256(n.vb[sp])) / int256(VOL_POINT_BPS);
        }
        if (high) {
            uint256 up = s > n.lo ? Math.mulDiv(n.uCall, s - n.lo, WAD) : 0;
            uint256 down = n.hi > s ? Math.mulDiv(n.uPut, n.hi - s, WAD) : 0;
            a = int256(up + down);
            if (vol > 0) a += vol * 3 / 2;
        } else {
            a = _smul(n.d, s) - n.ds;
            // B2: funding since the marks only lowers the liability, by at most value x dt / tau per series (the
            // funding rate (V - payoff) / (V tau) is at most 1 / tau, also at F11's max(start, now) rate); every
            // non-dust mark is at or after tc.
            uint256 dt = block.timestamp - n.tc;
            if (dt != 0) a -= int256((n.val[0] / DAILY + n.val[1] / WEEKLY) * dt);
            int256 floor_ = -int256($.book[stock].value);
            if (a < floor_) a = floor_;
            if (vol < 0) a += vol * 3 / 2;
        }
    }

    function _smul(int256 x, uint256 s) private pure returns (int256) {
        return x >= 0 ? int256(Math.mulDiv(uint256(x), s, WAD)) : -int256(Math.mulDiv(uint256(-x), s, WAD));
    }
}
