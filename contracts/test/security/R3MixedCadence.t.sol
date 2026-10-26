// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {console2} from "forge-std/console2.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {EngineStorage} from "../../src/engine/EngineStorage.sol";
import {Series, SessionKind} from "../../src/libs/OptionTypes.sol";
import {EngineBase} from "../engine/EngineBase.sol";

/// @notice Round-3 review R3-01 (MEDIUM): a live-tier NAV pass completes only when every tier-0 series has been
/// re-marked, but the keeper's 5-minute grid sampled only series worth >= $100 (not archived, within budget). One $1-$100
/// position accrued by the hourly catch-up held the name's tier-0 pass to the hourly cadence, so tc lagged 1-2 hours:
/// (a) the deposit bound subtracted value x (now - tc) / tau of funding the grid had already re-marked, and (b) the claim
/// bound charged every unit the S range of the last 1-2 hours.
/// Fix: (1) the deposit-side funding term is per series and O(1) (now x A - B, A = sum ceil(val_i / tau_i), B = sum
/// ceil(val_i / tau_i) x mark_i), independent of pass completion; (2) the keeper grids every tier-0 series of a name it
/// grids (app/src/keeper/jobs/accrue.ts), so the name's pass completes every slot; (3) the keeper alerts on a stale
/// tier-0 mark in session.
contract R3MixedCadenceTest is EngineBase {
    uint256 internal constant GRID = 300;

    bytes32[] internal batchA;
    bytes32[] internal batchB;
    bytes32 internal small;
    /// @dev S at each series' last mark (the fuzz tracks it to compute the tangent's convexity gap).
    mapping(bytes32 id => uint256) internal markS;

    function setUp() public override {
        super.setUp();
        // 20 Daily NVDA series around the money, about $35k of liability.
        for (uint256 i; i < 20; ++i) {
            bool isCall = i < 10;
            uint128 k = isCall ? uint128(95e18 + i * 1e18) : uint128(96e18 + (i - 10) * 1e18);
            bytes32 id = _list(address(nvda), isCall, k, DAILY);
            _buy(alice, id, 1_000e18);
            if (i % 2 == 0) batchA.push(id);
            else batchB.push(id);
        }
        // One 104.5 call bought for about $2.55: worth more than the $1 minimum (tier 0), less than the old $100 grid line.
        small = _list(address(nvda), true, 104.5e18, DAILY);
        (uint256 v,) = helper.valueAt(true, 100e18, 104.5e18, 5000, 0, 0, DAILY);
        _buy(bob, small, Math.mulDiv(2.55e18, WAD, v));
    }

    function _accrue(bytes32[] storage list, bool withSmall) internal {
        bytes32[] memory b = new bytes32[](list.length + (withSmall ? 1 : 0));
        for (uint256 i; i < list.length; ++i) {
            b[i] = list[i];
        }
        if (withSmall) b[list.length] = small;
        engine.accrueMany(b);
    }

    function _accrueSmall() internal {
        bytes32[] memory b = new bytes32[](1);
        b[0] = small;
        engine.accrueMany(b);
    }

    /// @dev One grid slot: two keeper batches 3 s apart. `gridSmall`: the fixed keeper (every tier-0 series of the name
    /// on the grid); else the old keeper (the small series only by the hourly catch-up, every 12th slot).
    function _slot(uint256 k, bool gridSmall) internal {
        skip(GRID - 3);
        _accrue(batchA, false);
        skip(3);
        _accrue(batchB, gridSmall);
        if (!gridSmall && k % 12 == 0) _accrueSmall();
    }

    function _bps(uint256 num, uint256 den) internal pure returns (uint256) {
        return Math.mulDiv(num, 10_000, den);
    }

    /// @dev Six hours of keeper slots; S steady, or 100 <-> 101.8 every half hour. Returns the largest deposit gap
    /// (exact - low) and claim gap (high - exact) in bps of the exact liability, and the largest tier-0 tc lag, over the
    /// slots after the first hour.
    function _run(bool gridSmall, bool oscillate) internal returns (uint256 depGap, uint256 claimGap, uint256 lag) {
        for (uint256 k = 1; k <= 72; ++k) {
            if (oscillate) guard.setS(address(nvda), (k / 6) % 2 == 0 ? 100e18 : 101.8e18);
            _slot(k, gridSmall);
            if (k <= 12) continue;
            uint256 exact = _liabilityRef();
            uint256 lo = engine.navLiability(false);
            uint256 hi = engine.navLiability(true);
            uint256 d = exact > lo ? _bps(exact - lo, exact) : 0;
            uint256 c = hi > exact ? _bps(hi - exact, exact) : 0;
            uint256 l = vm.getBlockTimestamp() - engine.markTier(address(nvda), 0).tc;
            if (d > depGap) depGap = d;
            if (c > claimGap) claimGap = c;
            if (l > lag) lag = l;
        }
    }

    /// @dev Reviewer PoC, deposit side, with the OLD keeper schedule (the small series hourly): the deposit bound
    /// subtracted val x (now - tc) / tau with tc 1-2 hours old (806 bps before the fix). The funding term is now per
    /// series, so it is the 5-minute funding of the grid (~35 bps) whatever the slowest series does.
    function test_R3_01_depositGapIndependentOfTheSlowestSeries() public {
        (uint256 depGap,, uint256 lag) = _run(false, false);
        console2.log("old schedule, steady S: deposit gap bps", depGap);
        console2.log("old schedule, steady S: tier-0 tc lag s", lag);
        assertLe(depGap, 60, "deposit gap is one grid interval of funding, not the hourly tc lag");
    }

    /// @dev Reviewer PoC, claim side, with the FIXED keeper schedule (every tier-0 series of the name on the grid): the
    /// pass completes every slot, tc stays within one slot and the claim bound is the S range of one slot.
    function test_R3_01_claimGapWithWholeNameOnTheGrid() public {
        (uint256 depGap, uint256 claimGap, uint256 lag) = _run(true, true);
        console2.log("fixed schedule, oscillating S: claim gap bps", claimGap);
        console2.log("fixed schedule, oscillating S: deposit gap bps", depGap);
        console2.log("fixed schedule, oscillating S: tier-0 tc lag s", lag);
        assertLe(claimGap, 5, "claim bound equals the exact liability after each slot");
        assertLe(depGap, 60, "deposit bound within one slot of funding");
        assertLe(lag, 2 * GRID, "tier-0 tc within two grid intervals");
    }

    /// @dev Documents why the keeper half is required: the engine's live tier is every series worth the $1 minimum, so
    /// a keeper that leaves one of them to the hourly catch-up still slows the name's claim envelope to the hour.
    /// accrue.ts must therefore grid every tier-0 series of a gridded name (decision 67).
    function test_R3_01_offGridSeriesStillWidensClaimEnvelope() public {
        (, uint256 claimGap, uint256 lag) = _run(false, true);
        console2.log("old schedule, oscillating S: claim gap bps", claimGap);
        console2.log("old schedule, oscillating S: tier-0 tc lag s", lag);
        assertGt(lag, 2 * GRID, "an off-grid tier-0 series holds tc to the hourly catch-up");
    }

    /// @dev The sum over series with units of val_i x (now - mark_i) / tau_i: each series' own first-order funding bound.
    function _fundingSinceMarks() internal view returns (uint256 f) {
        bytes32[] memory all = engine.seriesOfStock(address(nvda));
        for (uint256 i; i < all.length; ++i) {
            if (_token(all[i]).totalSupply() == 0) continue;
            uint256 v = engine.seriesRisk(all[i]).value;
            uint256 at = registry.seriesOf(all[i]).lastAccrual;
            uint32 tau = registry.seriesOf(all[i]).tauSeconds;
            f += Math.mulDiv(v, vm.getBlockTimestamp() - at, tau) + 1;
        }
    }

    /// @dev sum_i V_i(S) - (value_i + delta_i x (S - S_i)): how far the tangent the lower bound uses lies under the exact
    /// value (>= 0 by convexity); zero for a series marked at S.
    function _convexity(uint256 s) internal view returns (uint256 total) {
        bytes32[] memory all = engine.seriesOfStock(address(nvda));
        int256 sum;
        for (uint256 i; i < all.length; ++i) {
            uint256 supply = _token(all[i]).totalSupply();
            if (supply == 0) continue;
            Series memory se = registry.seriesOf(all[i]);
            (uint64 sigma, uint64 skew) = _vol(address(nvda), se.tauSeconds);
            (uint256 v,) = helper.valueAt(se.isCall, s, se.strike, sigma, skew, 0, se.tauSeconds);
            uint256 ex = Math.mulDiv(Math.mulDiv(supply, se.norm, WAD), v, WAD);
            EngineStorage.SeriesRisk memory r = engine.seriesRisk(all[i]);
            int256 tangent = int256(uint256(r.value)) + int256(r.delta) * (int256(s) - int256(markS[all[i]])) / 1e18;
            sum += int256(ex) - tangent;
        }
        total = sum > 0 ? uint256(sum) : 0;
    }

    /// @dev Dust-tier envelope term: every dust-tier unit at the full S range of the tier's marks and S now.
    function _slowTerm(uint256 s) internal view returns (uint256) {
        EngineStorage.MarkTier memory t = engine.markTier(address(nvda), 1);
        if (t.count == 0) return 0;
        uint256 lo = t.lo < s ? t.lo : s;
        uint256 hi = t.hi > s ? t.hi : s;
        return Math.mulDiv(t.uCall + t.uPut, hi - lo, WAD);
    }

    /// @dev PROPERTY (R3-01), production schedule simulated: grid slots every 300 s in random batches, any extra $1-$100
    /// position in any series, S moving up to 2% per slot. `gridAll` false = the old keeper (the extra series only
    /// hourly), true = the fixed keeper (whole name on the grid). For both:
    ///  (i)  exact - navLiability(false) <= sum_i val_i (now - mark_i) / tau_i + eps (the deposit bound does not depend on
    ///       how fast the slowest series is re-marked);
    /// and for the fixed keeper:
    ///  (ii) navLiability(true) - exact <= grid-tier units x |S - S at the last grid slot| + funding since the marks +
    ///       a slow-tier term over dust-tier units only.
    function testFuzz_R3_01_boundsUnderMixedCadence(uint256 seed, uint256 extraUsd, uint8 extraIdx, bool gridAll)
        public
    {
        extraUsd = bound(extraUsd, 1.2e18, 100e18);
        bool isCall = extraIdx % 2 == 0;
        uint128 k = uint128(90.25e18 + uint256(extraIdx % 41) * 0.5e18); // never a strike the book already lists
        bytes32 extra = _list(address(nvda), isCall, k, extraIdx % 3 == 0 ? WEEKLY : DAILY);
        {
            uint32 tau = extraIdx % 3 == 0 ? WEEKLY : DAILY;
            (uint256 v,) = helper.valueAt(isCall, 100e18, k, 5000, 0, 0, tau);
            vm.prank(bob);
            try engine.buy(extra, uint128(Math.mulDiv(extraUsd, WAD, v)), type(uint128).max, uint64(block.timestamp), bob) {}
            catch {
                vm.assume(false); // a buy the engine refuses (stress budget) is not a position
            }
        }
        // the off-grid positions under the old keeper: setUp's $2.55 call and the fuzzed one
        bytes32[] memory offGrid = new bytes32[](2);
        offGrid[0] = small;
        offGrid[1] = extra;
        markS[small] = 100e18;
        markS[extra] = 100e18;
        for (uint256 i; i < 10; ++i) {
            markS[batchA[i]] = 100e18;
            markS[batchB[i]] = 100e18;
        }
        uint256 sPass = 100e18;
        for (uint256 slot = 1; slot <= 30; ++slot) {
            uint256 r = uint256(keccak256(abi.encode(seed, slot)));
            sPass = bound(r, sPass * 98 / 100, sPass * 102 / 100);
            if (sPass < 85e18) sPass = 85e18;
            if (sPass > 115e18) sPass = 115e18;
            guard.setS(address(nvda), sPass);
            // random batching of the 20 grid series (1-20 per transaction)
            uint256 batch = 1 + (r >> 128) % 20;
            skip(GRID - 6);
            bytes32[] memory all = new bytes32[](20 + (gridAll ? 2 : 0));
            for (uint256 i; i < 10; ++i) {
                all[2 * i] = batchA[i];
                all[2 * i + 1] = batchB[i];
            }
            if (gridAll) (all[20], all[21]) = (offGrid[0], offGrid[1]);
            for (uint256 i; i < all.length; i += batch) {
                uint256 end = i + batch > all.length ? all.length : i + batch;
                bytes32[] memory b = new bytes32[](end - i);
                for (uint256 j = i; j < end; ++j) {
                    b[j - i] = all[j];
                }
                engine.accrueMany(b);
            }
            for (uint256 i; i < all.length; ++i) {
                markS[all[i]] = sPass;
            }
            skip(6);
            if (!gridAll && slot % 12 == 0) {
                engine.accrueMany(offGrid);
                (markS[offGrid[0]], markS[offGrid[1]]) = (sPass, sPass);
            }
            // a move after the slot, before a deposit or claim
            uint256 sNow = bound(r >> 64, sPass * 99 / 100, sPass * 101 / 100);
            guard.setS(address(nvda), sNow);
            uint256 exact = _liabilityRef();
            uint256 f = _fundingSinceMarks();
            uint256 lo = engine.navLiability(false);
            assertLe(lo, exact + 1e12, "low <= exact");
            // beyond the tangent's convexity gap (exact at S - the tangent at each mark), only funding separates them
            assertLe(exact - lo, _convexity(sNow) + f + 1e13, "(i) deposit gap <= convexity + per-series funding");
            if (gridAll) {
                uint256 hi = engine.navLiability(true);
                EngineStorage.MarkTier memory t0 = engine.markTier(address(nvda), 0);
                uint256 dS = sNow > sPass ? sNow - sPass : sPass - sNow;
                uint256 bound_ = Math.mulDiv(t0.uCall + t0.uPut, dS, WAD) + f + _slowTerm(sNow) + 1e12;
                assertLe(hi > exact ? hi - exact : 0, bound_, "(ii) claim gap <= grid units x |S - S at the slot|");
                assertLe(vm.getBlockTimestamp() - t0.tc, 2 * GRID, "tier-0 tc within two grid intervals");
            }
        }
    }

    /// @dev A and B recomputed from scratch: c_i = ceil(value at the mark / tau) over series with tokens outstanding, each
    /// at its mark time (the series' lastAccrual: every mark follows an accrual in the same block).
    function _assertFundExact(string memory where) internal view {
        bytes32[] memory all = engine.seriesOfStock(address(nvda));
        uint256 a;
        uint256 b;
        for (uint256 i; i < all.length; ++i) {
            if (_token(all[i]).totalSupply() == 0) continue;
            uint256 c = Math.ceilDiv(engine.seriesRisk(all[i]).value, registry.seriesOf(all[i]).tauSeconds);
            a += c;
            b += c * registry.seriesOf(all[i]).lastAccrual;
        }
        (uint256 fa, uint256 fb) = engine.fundingSums(address(nvda));
        assertEq(fa, a, where);
        assertEq(fb, b, where);
    }

    /// @dev Skeptic follow-up: a partial sell, then a sell to zero, in the middle of a grid slot (between its batches) and
    /// of the next one, keep A and B equal to their recomputation; the series closed to zero leaves no term behind.
    function test_R3_01_sellToZeroMidGridKeepsSumsExact() public {
        _assertFundExact("start");
        bytes32 x = batchB[3];
        uint256 tokens = _token(x).balanceOf(alice);
        skip(GRID - 3);
        _accrue(batchA, false);
        _assertFundExact("after batch A");
        skip(1);
        _sell(alice, x, tokens / 2);
        _assertFundExact("after a partial sell");
        skip(1);
        _sell(alice, x, _token(x).balanceOf(alice));
        assertEq(_token(x).totalSupply(), 0, "closed");
        _assertFundExact("after the sell to zero");
        skip(1);
        _accrue(batchB, true); // the closed series is in batch B: accrueMany skips it
        _assertFundExact("after batch B");
        // the small series too, partially then to zero, in the next slot between its batches
        uint256 st = _token(small).balanceOf(bob);
        skip(GRID - 3);
        _accrue(batchA, false);
        _sell(bob, small, st / 2); // ~$1.27 sold, ~$1.27 left: both above the $1 minimum
        _assertFundExact("small partial");
        skip(1);
        _sell(bob, small, _token(small).balanceOf(bob));
        _assertFundExact("small to zero");
        skip(2);
        _accrue(batchB, false);
        _assertFundExact("end");
        // re-buying a closed series starts a fresh term at its new mark
        skip(10);
        _buy(alice, x, 500e18);
        _assertFundExact("re-bought");
    }

    /// @dev The per-series funding sums are exact: after every series is closed, nothing is left (no drift, no
    /// underflow on removal), and a series re-bought afterwards starts from its own mark.
    function test_R3_01_fundingSumsReturnToZero() public {
        skip(GRID);
        _accrue(batchA, false);
        _accrue(batchB, true);
        bytes32[] memory all = engine.seriesOfStock(address(nvda));
        for (uint256 i; i < all.length; ++i) {
            uint256 aBal = _token(all[i]).balanceOf(alice);
            if (aBal != 0) _sell(alice, all[i], aBal);
            uint256 bBal = _token(all[i]).balanceOf(bob);
            if (bBal != 0) _sell(bob, all[i], bBal);
        }
        (uint256 a, uint256 b) = engine.fundingSums(address(nvda));
        assertEq(a, 0, "A empty");
        assertEq(b, 0, "B empty");
        _buy(alice, batchA[0], 1_000e18);
        skip(1 hours);
        uint256 exact = _liabilityRef();
        uint256 lo = engine.navLiability(false);
        assertLe(lo, exact + 1e12, "low <= exact");
        assertLe(exact - lo, _fundingSinceMarks() + 1e12, "one series' own funding bound");
        guard.set(address(nvda), 100e18, SessionKind.REGULAR, true);
    }
}
