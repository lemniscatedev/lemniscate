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

    function testFuzz_R4_stressWithin5PctAfterHalfPctMoves(uint256 seed, int256 moveA, int256 moveB) public {
        _randomBook(seed);
        moveA = bound(moveA, -50, 50); // +/- 0.5%: one feed deviation step, the keeper refreshes hourly
        moveB = bound(moveB, -50, 50);
        guard.setS(address(nvda), uint256(int256(100e18) * (10_000 + moveA) / 10_000));
        guard.setS(address(tsla), uint256(int256(200e18) * (10_000 + moveB) / 10_000));
        (uint256 loss,) = engine.stressLoss();
        uint256 brute = _bruteStress();
        if (brute < 1_000e18) return; // tiny books: relative error is meaningless
        assertApproxEqRel(loss, brute, 0.05e18, "stale aggregates within 5% after a 0.5% move");
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
