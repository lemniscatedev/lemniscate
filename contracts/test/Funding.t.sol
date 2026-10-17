// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, console2} from "forge-std/Test.sol";
import {Funding} from "../src/libs/Funding.sol";

/// @dev External wrapper so reverts of the internal library can be asserted.
contract FundingHarness {
    function step(uint256 norm, uint256 v, uint256 payoff, uint256 dt, uint256 tau) external pure returns (uint256) {
        return Funding.step(norm, v, payoff, dt, tau);
    }
}

contract FundingTest is Test {
    uint256 internal constant WAD = 1e18;
    uint256 internal constant DAY = 86_400;
    uint256 internal constant WEEK = 604_800;
    /// @dev e^(-1/7) * 1e18 = 866877899750181627.50...
    uint256 internal constant EXP_MINUS_ONE_SEVENTH = 866877899750181628;
    /// @dev e^(-1) * 1e18 = 367879441171442321.59...
    uint256 internal constant EXP_MINUS_ONE = 367879441171442322;

    struct FundingCase {
        uint256 V;
        uint256 dtSeconds;
        uint256 newNorm;
        uint256 norm;
        uint256 payoff;
        uint256 tauSeconds;
    }

    FundingHarness internal h = new FundingHarness();

    // ------------------------------------------------------------------------------------------------------ R6

    function test_R6_weeklyOtmLosesOneSeventhPerDay() public pure {
        uint256 n = Funding.step(WAD, 2e18, 0, DAY, WEEK);
        assertApproxEqRel(n, EXP_MINUS_ONE_SEVENTH, 1e9, "1 - exp(-1/7) per day within 1e-9");
        // Daily OTM: 1 - e^-1 per day.
        assertApproxEqRel(Funding.step(WAD, 2e18, 0, DAY, DAY), EXP_MINUS_ONE, 1e9);
        // Spec wording: about 1/7 of units per day (13.3%).
        assertApproxEqAbs(WAD - n, 0.1331e18, 0.0001e18);
    }

    function test_R6_deepItmBarelyShrinks() public pure {
        // V = payoff + 1e-6 V: rate 1e-6.
        uint256 v = 100e18;
        uint256 payoff = v - v / 1e6;
        uint256 n = Funding.step(WAD, v, payoff, DAY, WEEK);
        assertLt(WAD - n, 1e13, "shrink < 1e-5 over a day");
        // Even over a whole tau the shrink is about 1e-6.
        n = Funding.step(WAD, v, payoff, WEEK, WEEK);
        assertLt(WAD - n, 1e13, "shrink < 1e-5 over a tau");
        assertGt(WAD - n, 0, "still shrinks");
    }

    // ------------------------------------------------------------------------------------------------------ R7

    function test_R7_matchesTsReference() public view {
        string memory json = vm.readFile(string.concat(vm.projectRoot(), "/test/vectors/funding-vectors.json"));
        FundingCase[] memory c = abi.decode(
            vm.parseJsonTypeArray(
                json,
                ".cases",
                "FundingCase(uint256 V,uint256 dtSeconds,uint256 newNorm,uint256 norm,uint256 payoff,uint256 tauSeconds)"
            ),
            (FundingCase[])
        );
        assertEq(c.length, 200, "200 vectors");
        uint256 worst;
        for (uint256 i; i < c.length; ++i) {
            uint256 got = Funding.step(c[i].norm, c[i].V, c[i].payoff, c[i].dtSeconds, c[i].tauSeconds);
            uint256 want = c[i].newNorm;
            uint256 diff = got > want ? got - want : want - got;
            // Below ~1e12 (reachable since review F06 lowered MIN_NORM to 1e6) one wei of rounding is more than 1e-9
            // relative: a difference of at most 2 wei always passes.
            uint256 rel = diff <= 2 ? 0 : diff * 1e18 / want;
            if (rel > worst) worst = rel;
            if (rel > 1e9) {
                console2.log("case", i);
                console2.log("got / want", got, want);
            }
            assertLe(rel, 1e9, "within 1e-9 relative");
        }
        console2.log("R7 worst relative error (1e-18 units):", worst);
    }

    // ------------------------------------------------------------------------------------------------------ R9

    function test_R9_chunkedEqualsSingleStep() public pure {
        uint256[4] memory dts = [uint256(1 hours), DAY, 3 * WEEK + 1234, 400 * DAY];
        for (uint256 j; j < dts.length; ++j) {
            for (uint256 k = 1; k <= 24; k += 23) {
                _chunked(WAD, 150e18, 100e18, dts[j], WEEK, k);
                _chunked(0.37e18, 3e18, 0, dts[j], DAY, k);
            }
        }
    }

    function testFuzz_R9_chunkedEqualsSingleStep(uint256 norm, uint256 v, uint256 payoff, uint256 dt, uint8 k, bool weekly)
        public
        pure
    {
        norm = bound(norm, 1e15, WAD);
        v = bound(v, 1, 1e24);
        payoff = bound(payoff, 0, v);
        dt = bound(dt, 0, 60 days);
        _chunked(norm, v, payoff, dt, weekly ? WEEK : DAY, bound(k, 1, 48));
    }

    function _chunked(uint256 norm, uint256 v, uint256 payoff, uint256 dt, uint256 tau, uint256 k) internal pure {
        uint256 single = Funding.step(norm, v, payoff, dt, tau);
        uint256 n = norm;
        uint256 piece = dt / k;
        for (uint256 i; i < k; ++i) {
            n = Funding.step(n, v, payoff, i == k - 1 ? dt - piece * (k - 1) : piece, tau);
        }
        if (single <= Funding.MIN_NORM * 1000) {
            // Near the floor the 1-wei rounding per chunk is a visible fraction; both must still be at/near the floor.
            assertApproxEqAbs(n, single, k + 1);
        } else {
            assertApproxEqRel(n, single, 1e9, "k chunks == one step");
        }
    }

    // ----------------------------------------------------------------------------------------------------- units

    function test_rateClampsAndZeroV() public pure {
        assertEq(Funding.rate(0, 0), WAD, "V = 0 is rate 1");
        assertEq(Funding.rate(0, 5e18), WAD);
        assertEq(Funding.rate(1e18, 2e18), 0, "payoff above V is rate 0");
        assertEq(Funding.rate(1e18, 1e18), 0);
        assertEq(Funding.rate(2e18, 0), WAD);
        assertEq(Funding.rate(2e18, 1e18), 0.5e18);
    }

    function test_noShrinkCases() public pure {
        assertEq(Funding.step(WAD, 2e18, 0, 0, WEEK), WAD, "dt 0");
        assertEq(Funding.step(WAD, 1e18, 1e18, DAY, WEEK), WAD, "no time value");
        assertEq(Funding.step(Funding.MIN_NORM, 2e18, 0, DAY, DAY), Funding.MIN_NORM, "at the floor");
        assertEq(Funding.step(5, 2e18, 0, DAY, DAY), 5, "below the floor never rises");
    }

    function test_floorAfterLongGap() public pure {
        assertEq(Funding.step(WAD, 2e18, 0, 3650 days, DAY), Funding.MIN_NORM);
        assertEq(Funding.step(WAD, 2e18, 0, 3650 days, WEEK), Funding.MIN_NORM);
        // 42 taus at rate 1 is past e^-42.
        assertEq(Funding.step(WAD, 2e18, 0, 42 * DAY, DAY), Funding.MIN_NORM);
    }

    function test_tauZeroReverts() public {
        vm.expectRevert(Funding.TauZero.selector);
        h.step(WAD, 2e18, 0, DAY, 0);
    }

    function test_gasOneStep() public view {
        uint256 g = gasleft();
        h.step(WAD, 2e18, 1e18, 400 days, DAY);
        uint256 used = g - gasleft();
        console2.log("Funding.step gas (external call, 400 day gap):", used);
        assertLt(used, 30_000);
    }
}
