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
///    are convex in S), less the most funding can have taken since each series' own mark (value_i x dt_i / tau_i,
///    follow-up B2, per series since review R3-01), floored at minus the name's book value;
///  - upper bound (claims, the high-water checkpoint): bookValue + call units x max(0, S - lo) + put units x
///    max(0, hi - S), since |dV/dS| <= 1 per unit and every mark S_i lies in the envelope [lo, hi];
///  - plus a first-order vol term per speed, vega x (sigma now - sigma at the mark), 1.5x on the side that hurts the
///    caller.
/// A selective re-mark moves a series' stored value toward the truth and its mark into the envelope, so it never
/// widens what a caller gets. Review R09: the envelope and tc are kept per tier (live, dust) and reset when a pass
/// completes, i.e. when every series with units in the tier has been re-marked since the pass began, across any number
/// of transactions (keeper batches, trades); a pass's envelope is the S range of its own marks, so after a keeper pass
/// at a steady S both bounds equal the exact liability. Dust and retired series (R07) keep their own envelope until
/// they are re-marked. Cost: one readLite and two vol reads per name, never a loop over series. External library,
/// delegatecalled by the engine.
library EngineMarkLib {
    uint256 private constant WAD = 1e18;
    uint256 private constant VOL_POINT_BPS = 100;
    uint256 private constant DAILY = 86_400;
    uint256 private constant WEEKLY = 604_800;

    error InnerCallOutOfGas();

    uint24 private constant TIER_BIT = 1 << 23;
    uint24 private constant SIGMA_MASK = TIER_BIT - 1;

    /// @dev Replaces series `id`'s contribution (old delta and vega, units and mark S / sigma as stored, marked at
    /// `prevAt`) with the new one at mark S `s` and base sigma `sigma`, now. Public (one delegatecalled copy) so the
    /// trade, sell and accrual libraries keep their EIP-170 margin.
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
        uint64 sigma,
        uint256 prevAt
    ) public {
        EngineStorage.Layout storage $ = EngineStorage.layout();
        EngineStorage.SeriesMark storage m = $.seriesMarks[id];
        EngineStorage.NameMark storage n = $.marks[stock];
        uint256 sp = tau == 86_400 ? 0 : 1;
        uint24 oldSigma = m.sigma;
        if (m.s != 0) {
            n.d -= delta[0];
            n.ds -= _smul(delta[0], m.s);
            n.vg[sp] -= vega[0];
            n.vb[sp] -= vega[0] * (oldSigma & SIGMA_MASK);
        }
        n.d += delta[1];
        n.ds += _smul(delta[1], s);
        n.vg[sp] += vega[1];
        uint24 sg = sigma > SIGMA_MASK ? SIGMA_MASK : uint24(sigma);
        n.vb[sp] += vega[1] * sg;
        _fund($, id, stock, units == 0 ? 0 : Math.ceilDiv(value[1], sp == 0 ? DAILY : WEEKLY));
        uint256 t0 = oldSigma & TIER_BIT == 0 ? 0 : 1;
        uint256 t1 = value[1] < dustWad() ? 1 : 0;
        EngineStorage.MarkTier storage a = $.tiers[stock][t0];
        EngineStorage.MarkTier storage b = $.tiers[stock][t1];
        uint256 oldUnits = m.units;
        m.s = uint104(s);
        m.units = uint128(units);
        m.sigma = t1 == 1 ? sg | TIER_BIT : sg;
        if (oldUnits != 0 && units != 0 && t0 == t1) {
            _move(a, oldUnits, units, isCall, sp, value, s, prevAt); // the keeper's common case, fewer writes
        } else {
            if (oldUnits != 0) _remove(a, oldUnits, isCall, sp, value[0], prevAt);
            if (units != 0) _add(b, units, isCall, sp, value[1], s);
            if (t1 != t0) _completeIfMarked(b);
        }
        _completeIfMarked(a);
    }

    /// @dev Review R3-01: replaces series `id`'s term in its name's funding sums by `c` marked now. The removal uses the
    /// stored term, so the sums stay exact (A and B return to zero when every series is closed).
    function _fund(EngineStorage.Layout storage $, bytes32 id, address stock, uint256 c) private {
        EngineStorage.SeriesFund storage f = $.seriesFund[id];
        uint256 old = f.c;
        if (old == 0 && c == 0) return;
        EngineStorage.FundSum storage fs = $.fund[stock];
        fs.a = fs.a + c - old;
        fs.b = fs.b + c * block.timestamp - old * f.at;
        f.c = uint128(c);
        f.at = uint40(block.timestamp);
    }

    /// @dev `_remove` then `_add` in the same tier, with the count unchanged.
    function _move(
        EngineStorage.MarkTier storage t,
        uint256 oldUnits,
        uint256 units,
        bool isCall,
        uint256 sp,
        uint256[2] memory value,
        uint256 s,
        uint256 at
    ) private {
        if (isCall) t.uCall = t.uCall + units - oldUnits;
        else t.uPut = t.uPut + units - oldUnits;
        t.val[sp] = t.val[sp] + value[1] - value[0];
        bool wasDue = at <= t.passStart;
        bool due = block.timestamp <= t.passStart;
        if (wasDue && !due) --t.pending;
        else if (due && !wasDue) ++t.pending;
        if (!due) _widen(t, s, true);
        if (t.nowTs != block.timestamp) {
            t.nowTs = uint40(block.timestamp);
            t.nowCount = 1;
            t.nowLo = uint128(s);
            t.nowHi = uint128(s);
        } else {
            if (at != block.timestamp) ++t.nowCount;
            if (s < t.nowLo) t.nowLo = uint128(s);
            if (s > t.nowHi) t.nowHi = uint128(s);
        }
        _widen(t, s, false);
    }

    /// @dev The dust line (the minimum trade, WAD): EngineCore.minTradeUsdg without the import cycle.
    function dustWad() internal view returns (uint256) {
        uint64 m = EngineStorage.layout().guards.minTradeUsdg;
        return uint256(m == 0 ? 1e6 : m) * 1e12;
    }

    function _remove(EngineStorage.MarkTier storage t, uint256 units, bool isCall, uint256 sp, uint256 v0, uint256 at)
        private
    {
        if (isCall) t.uCall -= units;
        else t.uPut -= units;
        t.val[sp] -= v0;
        --t.count;
        if (at <= t.passStart) --t.pending; // it was still due in the open pass
        if (at == t.nowTs) --t.nowCount; // it was counted among this block's marks
    }

    function _add(EngineStorage.MarkTier storage t, uint256 units, bool isCall, uint256 sp, uint256 v1, uint256 s)
        private
    {
        if (t.count == 0) {
            // A tier with no series starts over at this mark.
            t.lo = 0;
            t.hi = 0;
            t.passLo = 0;
            t.passHi = 0;
            t.pending = 0;
            t.nowTs = 0;
            t.tc = uint40(block.timestamp);
            t.passStart = uint40(block.timestamp);
        }
        if (isCall) t.uCall += units;
        else t.uPut += units;
        t.val[sp] += v1;
        ++t.count;
        if (block.timestamp <= t.passStart) ++t.pending; // marked in the second the pass began: still due
        else _widen(t, s, true);
        if (t.nowTs != block.timestamp) {
            t.nowTs = uint40(block.timestamp);
            t.nowCount = 0;
            t.nowLo = 0;
            t.nowHi = 0;
        }
        ++t.nowCount;
        if (t.nowLo == 0 || s < t.nowLo) t.nowLo = uint128(s);
        if (s > t.nowHi) t.nowHi = uint128(s);
        _widen(t, s, false);
    }

    function _widen(EngineStorage.MarkTier storage t, uint256 s, bool pass) private {
        if (pass) {
            if (t.passLo == 0 || s < t.passLo) t.passLo = uint128(s);
            if (s > t.passHi) t.passHi = uint128(s);
        } else {
            if (t.lo == 0 || s < t.lo) t.lo = uint128(s);
            if (s > t.hi) t.hi = uint128(s);
        }
    }

    /// @dev Every series with units in the tier marked in this block (the keeper's one-transaction pass): the envelope
    /// is exactly this block's marks. Else, every one marked since the open pass began: the envelope becomes that pass's
    /// marks and `tc` its start. Either way a new pass opens now with every series due again.
    function _completeIfMarked(EngineStorage.MarkTier storage t) private {
        if (t.count == 0) return;
        if (t.nowTs == block.timestamp && t.nowCount == t.count) {
            t.lo = t.nowLo;
            t.hi = t.nowHi;
            t.tc = uint40(block.timestamp);
        } else if (t.pending == 0) {
            t.lo = t.passLo;
            t.hi = t.passHi;
            t.tc = t.passStart;
        } else {
            return;
        }
        t.passStart = uint40(block.timestamp);
        t.pending = t.count;
        t.passLo = 0;
        t.passHi = 0;
    }

    /// @notice The liability bound at today's prices: `high` the upper bound (claims), else the lower bound (deposits).
    /// A name without any price keeps its book value. Review R3-02: a HALTED name is bounded at its last good S (or its
    /// ORC-4 settlement price, as sells read it) with the trade TWAP, like CLOSED, so the R16 worse-of rule also holds
    /// while the feed is halted and the token's pool moves (the hedge leg already used the TWAP).
    function navLiability(bool high) public view returns (uint256) {
        EngineStorage.Layout storage $ = EngineStorage.layout();
        int256 total = int256($.bookValue);
        for (uint256 i; i < $.stocks.length; ++i) {
            address stock = $.stocks[i];
            EngineStorage.MarkTier[2] storage tiers = $.tiers[stock];
            if (tiers[0].count == 0 && tiers[1].count == 0) continue;
            PriceReading memory r = $.priceGuard.readLite(stock);
            if (r.session == SessionKind.HALTED && $.settleS[stock] != 0) r.s = $.settleS[stock];
            if (r.s == 0) continue;
            total += _adjust($, stock, r.s, _tradeTwap($, stock), high);
        }
        return total > 0 ? uint256(total) : 0;
    }

    /// @dev PriceGuard's trade TWAP (0 = none). A read that failed for lack of gas reverts: an LP must not pick the gas
    /// that drops it (review R16).
    function _tradeTwap(EngineStorage.Layout storage $, address stock) private view returns (uint256) {
        uint256 gasBefore = gasleft();
        (bool ok, bytes memory ret) =
            address($.priceGuard).staticcall{gas: 400_000}(abi.encodeWithSignature("tradeTwap(address)", stock));
        if (!ok && gasleft() <= gasBefore / 63) revert InnerCallOutOfGas();
        if (!ok || ret.length < 32) return 0;
        return abi.decode(ret, (uint256));
    }

    /// @dev Review R16: like the hedge leg (decision 52a), the liability is read at the worse for the LP crossing the
    /// pool boundary of the feed S and the trade TWAP, so a feed the market has moved away from (weekend, closed
    /// session, a lagging print) cannot move value between LPs: exits mark calls at max(S, TWAP) and puts at min(S,
    /// TWAP); entries take the lower of the tangent at S and at the TWAP.
    function _adjust(EngineStorage.Layout storage $, address stock, uint256 s, uint256 tw, bool high)
        private
        view
        returns (int256 a)
    {
        EngineStorage.NameMark storage n = $.marks[stock];
        EngineStorage.MarkTier[2] storage tiers = $.tiers[stock];
        int256 vol;
        for (uint256 sp; sp < 2; ++sp) {
            VolReading memory v = $.volOracle.read(stock, sp == 0 ? Speed.DAILY : Speed.WEEKLY);
            if (v.sigmaBps == 0) continue;
            vol += (int256(n.vg[sp] * v.sigmaBps) - int256(n.vb[sp])) / int256(VOL_POINT_BPS);
        }
        if (high) {
            for (uint256 k; k < 2; ++k) {
                EngineStorage.MarkTier storage t = tiers[k];
                if (t.count == 0) continue;
                uint256 sc = tw > s ? tw : s;
                uint256 spt = tw != 0 && tw < s ? tw : s;
                if (sc > t.lo) a += int256(Math.mulDiv(t.uCall, sc - t.lo, WAD));
                if (t.hi > spt) a += int256(Math.mulDiv(t.uPut, t.hi - spt, WAD));
            }
            if (vol > 0) a += vol * 3 / 2;
        } else {
            a = _smul(n.d, s) - n.ds;
            if (tw != 0) {
                int256 at = _smul(n.d, tw) - n.ds;
                if (at < a) a = at;
            }
            // B2: funding since the marks only lowers the liability, by at most value x dt / tau per series (the
            // funding rate (V - payoff) / (V tau) is at most 1 / tau, also at F11's max(start, now) rate). Review
            // R3-01: each series' own bound, sum c_i x (now - mark_i) = now x A - B, so a series re-marked late (a
            // small position the keeper samples hourly) no longer charges the whole name's value since its tc.
            EngineStorage.FundSum storage fs = $.fund[stock];
            a -= int256(block.timestamp * fs.a - fs.b);
            int256 floor_ = -int256($.book[stock].value);
            if (a < floor_) a = floor_;
            if (vol < 0) a += vol * 3 / 2;
        }
    }

    function _smul(int256 x, uint256 s) private pure returns (int256) {
        return x >= 0 ? int256(Math.mulDiv(uint256(x), s, WAD)) : -int256(Math.mulDiv(uint256(-x), s, WAD));
    }
}
