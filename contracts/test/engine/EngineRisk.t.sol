// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {EngineBase} from "./EngineBase.sol";
import {IOptionEngine} from "../../src/interfaces/IOptionEngine.sol";
import {EngineHelper} from "../../src/EngineHelper.sol";
import {Series, SessionKind, Speed} from "../../src/libs/OptionTypes.sol";

/// @notice Engine todo R2 (spread schedule and the API parity fixture), R4 (stress budget vs brute force).
contract EngineRiskTest is EngineBase {
    // ------------------------------------------------------------------------------------------------------ R2

    function _noInventory() internal {
        EngineHelper.Params memory p = engine.params();
        p.inventoryBps = 0;
        vm.prank(admin);
        engine.setParams(p);
    }

    /// @dev The 20 cases computed by the API's quote model (app/src/api/quote/model.ts) and recorded in
    /// test/vectors/quote-vectors.json. The model uses floating point, so money fields may differ by one micro-USDG and
    /// WAD fields by its 1e-12 rounding; spreadBps, sigma, session and buyable are exact.
    function test_R2_spreadScheduleMatchesApiModel() public {
        _noInventory();
        string memory json = vm.readFile("test/vectors/quote-vectors.json");
        for (uint256 i; i < 20; ++i) {
            string memory b = string.concat(".cases[", vm.toString(i), "]");
            bool isCall = vm.parseJsonBool(json, string.concat(b, ".isCall"));
            uint32 tau = uint32(vm.parseJsonUint(json, string.concat(b, ".tau")));
            uint256 s = vm.parseJsonUint(json, string.concat(b, ".s"));
            uint256 k = vm.parseJsonUint(json, string.concat(b, ".k"));
            uint64 sigma = uint64(vm.parseJsonUint(json, string.concat(b, ".sigmaBps")));
            SessionKind session = SessionKind(uint8(vm.parseJsonUint(json, string.concat(b, ".session"))));
            uint256 units = vm.parseJsonUint(json, string.concat(b, ".units"));
            bool isBuy = vm.parseJsonBool(json, string.concat(b, ".isBuy"));
            bool stale = vm.parseJsonBool(json, string.concat(b, ".volStale"));

            guard.set(address(nvda), s, session, true);
            Speed sp = tau == DAILY ? Speed.DAILY : Speed.WEEKLY;
            vol.set(address(nvda), sp, sigma, 0, stale ? uint64(vm.getBlockTimestamp() - 1) : uint64(vm.getBlockTimestamp() + 1 hours));
            bytes32 id = registry.idOf(address(nvda), isCall, uint128(k), tau);
            if (registry.seriesOf(id).token == address(0)) id = _list(address(nvda), isCall, uint128(k), tau);
            IOptionEngine.Quote memory q = engine.quote(id, units, isBuy);

            string memory tag = string.concat("case ", vm.toString(i));
            assertApproxEqAbs(q.usdg, vm.parseJsonUint(json, string.concat(b, ".usdg")), 1, string.concat(tag, " usdg"));
            assertApproxEqAbs(q.feeUsdg, vm.parseJsonUint(json, string.concat(b, ".feeUsdg")), 1, string.concat(tag, " fee"));
            assertApproxEqAbs(
                q.dailyCostUsdg, vm.parseJsonUint(json, string.concat(b, ".dailyCostUsdg")), 1, string.concat(tag, " daily")
            );
            assertApproxEqAbs(
                q.vMarkWad, vm.parseJsonUint(json, string.concat(b, ".vMarkWad")), 1e7, string.concat(tag, " vMark")
            );
            assertApproxEqAbs(
                q.breakevenWad, vm.parseJsonUint(json, string.concat(b, ".breakevenWad")), 1e7, string.concat(tag, " breakeven")
            );
            assertEq(q.spreadBps, vm.parseJsonUint(json, string.concat(b, ".spreadBps")), string.concat(tag, " spreadBps"));
            assertEq(q.sigmaBps, vm.parseJsonUint(json, string.concat(b, ".outSigmaBps")), string.concat(tag, " sigma"));
            assertEq(uint8(q.session), uint8(session), string.concat(tag, " session"));
            assertEq(q.buyable, vm.parseJsonBool(json, string.concat(b, ".buyable")), string.concat(tag, " buyable"));
        }
    }

    /// @dev The schedule itself: 150 bps at the money, linear to 400 bps at |K/S - 1| = 30%, flat beyond; x1 / x1.5 / x3.
    function test_R2_spreadSchedule() public {
        _noInventory();
        uint128[6] memory ks = [uint128(100e18), 106e18, 115e18, 85e18, 130e18, 60e18];
        uint256[6] memory want = [uint256(150), 200, 275, 275, 400, 400];
        for (uint256 i; i < 6; ++i) {
            bytes32 id = _list(address(nvda), true, ks[i], WEEKLY);
            guard.setSession(address(nvda), SessionKind.REGULAR);
            assertEq(engine.quote(id, 1e18, true).spreadBps, want[i], "regular");
            guard.setSession(address(nvda), SessionKind.EXTENDED);
            assertEq(engine.quote(id, 1e18, true).spreadBps, (want[i] * 15 + 5) / 10, "extended");
            guard.setSession(address(nvda), SessionKind.CLOSED);
            assertEq(engine.quote(id, 1e18, false).spreadBps, want[i] * 3, "closed");
        }
    }

    /// @dev Decision 17: skewK = (k_put x 1e4 << 32) | k_call x 1e4; sigma(K) = sigma (1 + k_put max(0, -ln K/S) +
    /// k_call max(0, ln K/S)).
    function test_R2_skewDecoding() public {
        uint64 skew = (uint64(12_000) << 32) | 4000; // k_put 1.2, k_call 0.4
        _setVol(address(nvda), 5000, skew);
        bytes32 atm = _list(address(nvda), true, 100e18, WEEKLY);
        bytes32 up = _list(address(nvda), true, 120e18, WEEKLY);
        bytes32 down = _list(address(nvda), false, 80e18, WEEKLY);
        (,, uint64 sAtm,) = engine.vMark(atm);
        (,, uint64 sUp,) = engine.vMark(up);
        (,, uint64 sDown,) = engine.vMark(down);
        assertEq(sAtm, 5000);
        // ln(1.2) = 0.18232; 5000 x (1 + 0.4 x 0.18232) = 5364.6 -> 5364
        assertEq(sUp, 5364);
        // -ln(0.8) = 0.22314; 5000 x (1 + 1.2 x 0.22314) = 6338.9 -> 6338
        assertEq(sDown, 6338);
    }

    function test_R2_staleVolSellsAtSigmaTimes1_2() public {
        bytes32 id = _list(address(nvda), true, 100e18, DAILY);
        (, uint256 tokens) = _buy(alice, id, 10e18);
        vol.set(address(nvda), Speed.DAILY, 4000, 0, uint64(vm.getBlockTimestamp() - 1));
        assertEq(engine.quote(id, tokens, false).sigmaBps, 4800);
        assertFalse(engine.quote(id, 1e18, true).buyable, "stale vol blocks buys");
    }

    function test_R2_dailyCostDefinition() public {
        _noInventory();
        bytes32 id = _list(address(nvda), true, 100e18, WEEKLY);
        IOptionEngine.Quote memory q = engine.quote(id, 10e18, true);
        (uint256 v, uint256 payoff,,) = engine.vMark(id);
        // units x (V - payoff) / tau x 86400, rounded up to 6 dp. Overview example: Weekly ATM ~ $0.35 per option a day.
        assertEq(q.dailyCostUsdg, Math.ceilDiv(Math.mulDiv((v - payoff) * 86_400, 10e18, uint256(WEEKLY) * WAD, Math.Rounding.Ceil), 1e12));
        assertApproxEqRel(q.dailyCostUsdg, 3_496_226, 1e15);
    }

    // ------------------------------------------------------------------------------------------------------ R4

    /// @dev Brute force: every series revalued at S x (1 +/- 25%) and S x (1 +/- 10%), loss = option value change minus
    /// the pool's spot hedge gain, combined as max_i(gap_i + sum_j move_j - move_i).
    function _bruteStress() internal view returns (uint256) {
        address[] memory ss = engine.stocks();
        int256 sumMove;
        int256 best = type(int256).min;
        for (uint256 i; i < ss.length; ++i) {
            (uint256 s,,,,) = guard.px(ss[i]);
            int256[4] memory l;
            int256[4] memory moves = [int256(-2500), -1000, 1000, 2500];
            for (uint256 m; m < 4; ++m) {
                uint256 s2 = uint256(int256(s) * (10_000 + moves[m]) / 10_000);
                int256 change;
                bytes32[] memory ids = engine.seriesOfStock(ss[i]);
                for (uint256 j; j < ids.length; ++j) {
                    Series memory se = registry.seriesOf(ids[j]);
                    uint256 units = Math.mulDiv(IERC20(se.token).totalSupply(), se.norm, WAD);
                    if (units == 0) continue;
                    (uint64 sig, uint64 sk) = _vol(ss[i], se.tauSeconds);
                    // the scenario values at the series' sigma at S (sigma does not move in the scenario)
                    uint64 sigma = helper.sigmaFor(s, se.strike, sig, sk, 0);
                    (uint256 v0,) = helper.valueAt(se.isCall, s, se.strike, sigma, 0, 0, se.tauSeconds);
                    (uint256 v1,) = helper.valueAt(se.isCall, s2, se.strike, sigma, 0, 0, se.tauSeconds);
                    change += (int256(v1) - int256(v0)) * int256(units) / int256(WAD);
                }
                uint256 hedgeUnits = IERC20(ss[i]).balanceOf(address(pool));
                l[m] = change - int256(hedgeUnits * s / WAD) * moves[m] / 10_000;
            }
            int256 m10 = l[1] > l[2] ? l[1] : l[2];
            int256 gap = l[0] > l[3] ? l[0] : l[3];
            sumMove += m10;
            if (gap - m10 > best) best = gap - m10;
        }
        int256 worst = sumMove + best;
        return worst > 0 ? uint256(worst) : 0;
    }

    function _randomBook(uint256 seed) internal returns (bytes32[] memory ids) {
        ids = new bytes32[](8);
        address[2] memory names = [address(nvda), address(tsla)];
        for (uint256 i; i < 8; ++i) {
            uint256 r = uint256(keccak256(abi.encode(seed, i)));
            address stock = names[r % 2];
            (uint256 s,,,,) = guard.px(stock);
            uint128 k = uint128(s * (85 + (r >> 8) % 31) / 100);
            k = k / 1e18 * 1e18;
            bool isCall = (r >> 16) % 2 == 0;
            uint32 tau = (r >> 24) % 2 == 0 ? DAILY : WEEKLY;
            bytes32 id = registry.idOf(stock, isCall, k, tau);
            if (registry.seriesOf(id).token == address(0)) id = _list(stock, isCall, k, tau);
            ids[i] = id;
            uint256 units = (1 + (r >> 32) % 400) * 1e18;
            vm.prank(alice);
            try engine.buy(id, uint128(units), type(uint128).max, uint64(vm.getBlockTimestamp()), alice) {} catch {}
        }
    }

    function testFuzz_R4_stressBudgetMatchesBruteForce(uint256 seed, uint256 hedge) public {
        hedge = bound(hedge, 0, 3_000e18);
        nvda.mint(address(pool), hedge);
        _randomBook(seed);
        (uint256 loss,) = engine.stressLoss();
        uint256 brute = _bruteStress();
        // At the prices the book was built at, the incremental book IS a full revaluation (rounding only).
        assertApproxEqAbs(loss, brute, 1e9, "same prices: exact up to rounding");
    }

    /// @dev R4 after a price move, with a proven bound instead of the old "within 5%" claim (todo 20c). The stored
    /// scenario changes sc_k were computed at the names' last-touch price S (sigma from the skew at S); the brute force
    /// uses the new price S' (sigma from the skew at S'). Split the difference per name and scenario in two parts:
    ///  1. price, same sigma: [V(S'(1+m)) - V(S')] - [V(S(1+m)) - V(S)] = integral over x from S to S' of
    ///     (1+m) delta(x(1+m)) - delta(x). An everlasting option's delta is in [0, 1] (call) or [-1, 0] (put), so the
    ///     integrand is in [-1, 1.25] (m <= 25%) and the part is at most 1.25 |S' - S| per unit (plus the hedge term
    ///     |m| |S' - S| per hedged stock unit, zero here).
    ///  2. skew: the same scenario re-priced at sigma(S') instead of sigma(S), computed exactly per series.
    /// The worst-case loss is sum_i m10_i + max_i (gap_i - m10_i), so it moves by at most sum_i eps_i + 2 max_i eps_i
    /// when every scenario of name i moves by at most eps_i. A relative bound cannot hold in general (hedged books
    /// make the loss a small difference of large numbers); the old 5% failed at 5.05% (regression test below).
    function testFuzz_R4_staleStressWithinProvenBoundAfterHalfPctMoves(uint256 seed, int256 moveA, int256 moveB) public {
        _randomBook(seed);
        moveA = bound(moveA, -50, 50); // +/- 0.5%: one feed deviation step, the keeper refreshes hourly
        moveB = bound(moveB, -50, 50);
        _assertStaleStressBound(moveA, moveB);
    }

    /// @dev The persisted counterexample that broke the old 5% claim (seed 3, NVDA -0.5%, TSLA -0.5%): stale 8,017.9
    /// vs fresh 7,632.4 (5.05%). Kept as a fixed regression test of the proven bound.
    function test_R4_staleStressCounterexampleWithinProvenBound() public {
        _randomBook(3);
        int256 moveA = bound(int256(4151779788931731037062097746348594670393659843899199454165130164343), -50, 50);
        int256 moveB = bound(-57896044618658097711785492504343953926634992332820282019728792003956564819967, -50, 50);
        (uint256 loss, uint256 brute,) = _assertStaleStressBound(moveA, moveB);
        assertApproxEqRel(loss, 8017897742935844051633, 1e12, "the counterexample's stale loss");
        assertApproxEqRel(brute, 7632425454722031570006, 1e12, "the counterexample's fresh loss");
        assertGt((loss - brute) * 1e18 / brute, 0.05e18, "the old 5% claim really fails here");
    }

    function _assertStaleStressBound(int256 moveA, int256 moveB) internal returns (uint256 loss, uint256 brute, uint256 bnd) {
        uint256 sA = 100e18;
        uint256 sB = 200e18;
        uint256 sA2 = uint256(int256(sA) * (10_000 + moveA) / 10_000);
        uint256 sB2 = uint256(int256(sB) * (10_000 + moveB) / 10_000);
        uint256 eA = _staleEps(address(nvda), sA, sA2);
        uint256 eB = _staleEps(address(tsla), sB, sB2);
        guard.setS(address(nvda), sA2);
        guard.setS(address(tsla), sB2);
        (loss,) = engine.stressLoss();
        brute = _bruteStress();
        bnd = eA + eB + 2 * (eA > eB ? eA : eB) + 1e12; // + fixed-point rounding
        uint256 diff = loss > brute ? loss - brute : brute - loss;
        assertLe(diff, bnd, "stale stress within the proven bound");
    }

    /// @dev eps for one name moving from s to s2: 1.25 |s2 - s| per unit outstanding (price part) plus the largest
    /// scenario change from re-pricing at the skew of s2 instead of s (skew part). Hedge part: no hedge in these books.
    function _staleEps(address stock, uint256 s, uint256 s2) internal view returns (uint256 eps) {
        assertEq(IERC20(stock).balanceOf(address(pool)), 0, "these books carry no hedge");
        uint256 d = s2 > s ? s2 - s : s - s2;
        int256[4] memory moves = [int256(-2500), -1000, 1000, 2500];
        int256[4] memory skew;
        uint256 units;
        bytes32[] memory ids = engine.seriesOfStock(stock);
        for (uint256 j; j < ids.length; ++j) {
            Series memory se = registry.seriesOf(ids[j]);
            uint256 u = Math.mulDiv(IERC20(se.token).totalSupply(), se.norm, WAD);
            if (u == 0) continue;
            units += u;
            (uint64 sig, uint64 sk) = _vol(stock, se.tauSeconds);
            uint64 sigOld = helper.sigmaFor(s, se.strike, sig, sk, 0);
            uint64 sigNew = helper.sigmaFor(s2, se.strike, sig, sk, 0);
            (uint256 v0n,) = helper.valueAt(se.isCall, s2, se.strike, sigNew, 0, 0, se.tauSeconds);
            (uint256 v0o,) = helper.valueAt(se.isCall, s2, se.strike, sigOld, 0, 0, se.tauSeconds);
            for (uint256 m; m < 4; ++m) {
                uint256 x = uint256(int256(s2) * (10_000 + moves[m]) / 10_000);
                (uint256 vn,) = helper.valueAt(se.isCall, x, se.strike, sigNew, 0, 0, se.tauSeconds);
                (uint256 vo,) = helper.valueAt(se.isCall, x, se.strike, sigOld, 0, 0, se.tauSeconds);
                skew[m] += ((int256(vn) - int256(v0n)) - (int256(vo) - int256(v0o))) * int256(u) / int256(WAD);
            }
        }
        uint256 worstSkew;
        for (uint256 m; m < 4; ++m) {
            uint256 a = uint256(skew[m] < 0 ? -skew[m] : skew[m]);
            if (a > worstSkew) worstSkew = a;
        }
        eps = Math.mulDiv(units, d, WAD) * 125 / 100 + worstSkew;
    }

    function test_R4_stressBudget() public {
        bytes32 id = _list(address(nvda), true, 100e18, DAILY);
        bytes32 t = _list(address(tsla), true, 200e18, DAILY);
        // A 25% gap on a Daily ATM call costs ~ $24 per unit; budget 20% x $2M = $400k.
        _buy(alice, id, 15_000e18); // ~$361k gap loss
        (uint256 loss, int256 nav) = engine.stressLoss();
        assertLt(loss * 10_000, uint256(nav) * 2000);
        // One more name: its 10% move adds to the NVDA gap; ~2,000 TSLA calls ($200, 10% up ~ $17.6 a unit) cross it.
        vm.expectRevert();
        vm.prank(bob);
        engine.buy(t, 3_000e18, type(uint128).max, uint64(vm.getBlockTimestamp()), bob);
        try engine.quote(t, 3_000e18, true) {} catch {}
        // The exact error carries the post-trade loss in bps of NAV.
        vm.prank(bob);
        try engine.buy(t, 3_000e18, type(uint128).max, uint64(vm.getBlockTimestamp()), bob) {
            revert("should revert");
        } catch (bytes memory err) {
            assertEq(bytes4(err), IOptionEngine.StressBudget.selector);
            (uint256 bps) = abi.decode(_tail(err), (uint256));
            assertGt(bps, 2000);
        }
        // A spot hedge on NVDA (the pool long the stock) reduces the up-gap loss and makes room.
        nvda.mint(address(pool), 5_000e18);
        vm.prank(bob);
        engine.buy(t, 3_000e18, type(uint128).max, uint64(vm.getBlockTimestamp()), bob);
    }

    function _tail(bytes memory err) internal pure returns (bytes memory out) {
        out = new bytes(err.length - 4);
        for (uint256 i; i < out.length; ++i) {
            out[i] = err[i + 4];
        }
    }
}
