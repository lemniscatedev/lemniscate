// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, console2} from "forge-std/Test.sol";
import {FixedMath} from "../src/libs/FixedMath.sol";
import {EverlastingMath} from "../src/libs/EverlastingMath.sol";
import {EverlastingMathHarness} from "./harness/EverlastingMathHarness.sol";

/// @notice Unit tests for FixedMath and EverlastingMath (todo 02): R2, R3, R6, R7 and fixed-point constants.
contract EverlastingMathTest is Test {
    uint256 internal constant WAD = 1e18;
    uint32 internal constant DAILY = 86_400;
    uint32 internal constant WEEKLY = 604_800;

    EverlastingMathHarness internal h;

    // One vector case; the JSON holds decimal strings, parsed into uint256 by the explicit type below.
    struct Case {
        uint256 K;
        uint256 S;
        uint256 call;
        uint256 put;
        uint256 sigmaBps;
        uint256 tauSeconds;
        uint256 u;
    }

    struct Vectors {
        uint256[] S;
        uint256[] K;
        uint256[] sigmaBps;
        uint256[] tauSeconds;
        uint256[] call;
        uint256[] put;
        uint256[] u;
    }

    function setUp() public {
        h = new EverlastingMathHarness();
    }

    function _vectors() internal view returns (Vectors memory v) {
        string memory json = vm.readFile(string.concat(vm.projectRoot(), "/test/vectors/pricing-vectors.json"));
        Case[] memory c = abi.decode(
            vm.parseJsonTypeArray(
                json,
                ".cases",
                "Case(uint256 K,uint256 S,uint256 call,uint256 put,uint256 sigmaBps,uint256 tauSeconds,uint256 u)"
            ),
            (Case[])
        );
        uint256 n = c.length;
        v.S = new uint256[](n);
        v.K = new uint256[](n);
        v.sigmaBps = new uint256[](n);
        v.tauSeconds = new uint256[](n);
        v.call = new uint256[](n);
        v.put = new uint256[](n);
        v.u = new uint256[](n);
        for (uint256 i = 0; i < n; ++i) {
            (v.S[i], v.K[i], v.sigmaBps[i], v.tauSeconds[i]) = (c[i].S, c[i].K, c[i].sigmaBps, c[i].tauSeconds);
            (v.call[i], v.put[i], v.u[i]) = (c[i].call, c[i].put, c[i].u);
        }
    }

    /// @dev |got - want| <= relTol * want  or  <= absTol (both in 1e18-scaled ratios: 1e9 = 1e-9).
    function _close(uint256 got, uint256 want, uint256 relTol, uint256 absTol) internal pure returns (bool) {
        uint256 d = got > want ? got - want : want - got;
        return d <= absTol || d * WAD <= relTol * want;
    }

    function _relErr(uint256 got, uint256 want) internal pure returns (uint256) {
        if (want == 0) return got == 0 ? 0 : type(uint256).max;
        uint256 d = got > want ? got - want : want - got;
        return d * WAD / want; // 1e18 = 100%
    }

    // ---------------------------------------------------------------------------------------- constants and spot

    function test_fixedMathKnownValues() public view {
        assertEq(h.expWad(0), WAD);
        assertApproxEqAbs(h.expWad(1e18), 2718281828459045235, 1); // e
        assertApproxEqAbs(h.expWad(-1e18), 367879441171442321, 1); // 1/e
        assertEq(h.lnWad(WAD), 0);
        assertApproxEqAbs(h.lnWad(2e18), 693147180559945309, 1); // ln 2
        assertApproxEqAbs(h.lnWad(2718281828459045235), 1e18, 1);
        assertApproxEqAbs(h.lnWad(1), -41446531673892822312, 1); // ln 1e-18
        assertEq(h.sqrtWad(4e18), 2e18);
        assertEq(h.sqrtWad(2e18), 1414213562373095048);
        assertApproxEqAbs(h.powWad(2e18, 0.5e18), 1414213562373095048, 1);
        assertApproxEqAbs(h.powWad(10e18, 3e18), 1000e18, 1e3);
        assertEq(h.powWad(0, 1e18), 0);
        assertEq(h.powWad(5e18, 0), WAD);
        // Saturation and overflow edges.
        assertEq(h.expWad(-42e18 - 1), 0);
        assertLe(h.expWad(-42e18), 1);
        assertGt(h.expWad(135e18), 4e76);
    }

    function test_designDecisionExamples() public view {
        // 01-design-decisions.md: S = K = 100, sigma 50%, Daily -> 0.92525; Weekly -> 2.447.
        assertApproxEqRel(h.callValue(100e18, 100e18, 5000, DAILY), 925251905208399476, 1e6);
        assertApproxEqRel(h.callValue(100e18, 100e18, 5000, WEEKLY), 2447357973558453248, 1e6);
    }

    // ---------------------------------------------------------------------------------------------- R2 high u

    /// R2: u up to 1323 (sigma 10%, tau 1 h) and x in [0.1, 10]: never reverts, result in [0, K], matches a 80-digit
    /// Decimal reference (python) within 1e-12 relative or 2 wei, and saturates to 0 below 1 wei.
    function test_R2_highUNoOverflow() public view {
        uint256 K = 100e18;
        uint256[11] memory S =
            [uint256(10e18), 50e18, 90e18, 99e18, 99.9e18, 100e18, 100.1e18, 101e18, 110e18, 200e18, 1000e18];
        uint256[3] memory U = [uint256(200e18), 54039337523696566000, 1323e18];
        uint256[11][3] memory want = [
            [
                uint256(0),
                0,
                167325892,
                33327023327825452,
                204559850670398787,
                250000000000000000,
                204805469921975755,
                34342028083649138,
                1380699983,
                0,
                0
            ],
            [
                uint256(0),
                35,
                2955811715221652,
                534818464729411349,
                876116790910175344,
                925251905208399476,
                877040739641549808,
                543120878974589455,
                5625006729269937,
                70,
                0
            ],
            [
                uint256(0),
                0,
                0,
                63181540396,
                10053883007582529,
                37792894935752078,
                10077265335882136,
                72843924002,
                0,
                0,
                0
            ]
        ];
        for (uint256 i = 0; i < 3; ++i) {
            for (uint256 j = 0; j < 11; ++j) {
                uint256 got = h.timeValueU(S[j], K, U[i]);
                assertLe(got, K, "tv <= K");
                assertTrue(_close(got, want[i][j], 1e6, 2), "tv vs 80-digit reference");
            }
        }
        // u = 1/2: x^(1/2 + 1/2) = x below K, so tv = S exactly up to rounding; above K tv = K.
        assertApproxEqAbs(h.timeValueU(50e18, K, 0.5e18), 50e18, 2);
        assertApproxEqAbs(h.timeValueU(1000e18, K, 0.5e18), K, 2);
    }

    // --------------------------------------------------------------------------------------------- R3 vectors

    /// R3: every case of the TS-generated vectors, call and put within 1e-9 relative or 1e-12 of K absolute; u within
    /// 1e-12 relative. Logs the worst relative error on values >= 1e12 wei (below that the
    /// 1-wei granularity of the result dominates).
    function test_R3_callMatchesVectors() public view {
        Vectors memory v = _vectors();
        assertEq(v.S.length, 2000);
        assertEq(v.u.length, 2000);
        uint256 worstCall;
        uint256 worstPut;
        uint256 worstU;
        for (uint256 i = 0; i < v.S.length; ++i) {
            uint256 s = v.S[i];
            uint256 k = v.K[i];
            uint64 sig = uint64(v.sigmaBps[i]);
            uint32 tau = uint32(v.tauSeconds[i]);
            uint256 c = h.callValue(s, k, sig, tau);
            uint256 p = h.putValue(s, k, sig, tau);
            uint256 wc = v.call[i];
            uint256 wp = v.put[i];
            uint256 absTol = k / 1e12;
            assertTrue(_close(c, wc, 1e9, absTol), string.concat("call case ", vm.toString(i)));
            assertTrue(_close(p, wp, 1e9, absTol), string.concat("put case ", vm.toString(i)));
            uint256 uu = h.uWad(sig, tau);
            assertTrue(_close(uu, v.u[i], 1e6, 0), string.concat("u case ", vm.toString(i)));
            if (wc >= 1e12) worstCall = _max(worstCall, _relErr(c, wc));
            if (wp >= 1e12) worstPut = _max(worstPut, _relErr(p, wp));
            worstU = _max(worstU, _relErr(uu, v.u[i]));
        }
        console2.log("R3 worst rel err (1e18 = 100%) call / put / u:", worstCall, worstPut, worstU);
    }

    function _max(uint256 a, uint256 b) internal pure returns (uint256) {
        return a > b ? a : b;
    }

    // ------------------------------------------------------------------------------------------------- R6 gas

    /// R6: callValue average gas across the vector set (external call through the harness, overhead included).
    function test_R6_gasBudget() public view {
        Vectors memory v = _vectors();
        uint256 n = 400;
        uint256 total;
        uint256 worst;
        for (uint256 i = 0; i < n; ++i) {
            uint256 s = v.S[i];
            uint256 k = v.K[i];
            uint64 sig = uint64(v.sigmaBps[i]);
            uint32 tau = uint32(v.tauSeconds[i]);
            uint256 g0 = gasleft();
            h.callValue(s, k, sig, tau);
            uint256 used = g0 - gasleft();
            total += used;
            if (used > worst) worst = used;
        }
        uint256 avg = total / n;
        console2.log("R6 callValue gas avg / max over 400 vectors:", avg, worst);
        assertLe(avg, 150_000, "callValue average gas over budget");
    }

    // --------------------------------------------------------------------------------------------- R7 domain

    function test_R7_domainReverts() public {
        bytes4 ood = EverlastingMath.OutOfDomain.selector;
        // zero and out-of-range prices
        vm.expectRevert(ood);
        h.callValue(0, 100e18, 5000, DAILY);
        vm.expectRevert(ood);
        h.callValue(100e18, 0, 5000, DAILY);
        vm.expectRevert(ood);
        h.putValue(1e12 - 1, 100e18, 5000, DAILY);
        vm.expectRevert(ood);
        h.putValue(100e18, 1e30 + 1, 5000, DAILY);
        // sigma
        vm.expectRevert(ood);
        h.callValue(100e18, 100e18, 0, DAILY);
        vm.expectRevert(ood);
        h.callValue(100e18, 100e18, 999, DAILY);
        vm.expectRevert(ood);
        h.putValue(100e18, 100e18, 30_001, DAILY);
        vm.expectRevert(ood);
        h.uWad(999, DAILY);
        // tau
        vm.expectRevert(ood);
        h.callValue(100e18, 100e18, 5000, 0);
        vm.expectRevert(ood);
        h.callValue(100e18, 100e18, 5000, 3599);
        vm.expectRevert(ood);
        h.putValue(100e18, 100e18, 5000, 30 days + 1);
        vm.expectRevert(ood);
        h.uWad(5000, 30 days + 1);
        // time value core
        vm.expectRevert(ood);
        h.timeValueU(100e18, 100e18, 0.5e18 - 1);
        vm.expectRevert(ood);
        h.timeValueU(0, 100e18, 1e18);
        // FixedMath named errors
        vm.expectRevert(FixedMath.LnUndefined.selector);
        h.lnWad(0);
        vm.expectRevert(abi.encodeWithSelector(FixedMath.ExpOverflow.selector, int256(135e18 + 1)));
        h.expWad(135e18 + 1);
        vm.expectRevert(FixedMath.PowUndefined.selector);
        h.powWad(0, 0);
        vm.expectRevert(FixedMath.PowUndefined.selector);
        h.powWad(0, -1e18);
        // Domain edges themselves are accepted.
        h.callValue(1e12, 1e30, 1000, 3600);
        h.putValue(1e30, 1e12, 30_000, 30 days);
    }
}
