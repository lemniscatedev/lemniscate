// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, console2} from "forge-std/Test.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {EverlastingMath} from "../src/libs/EverlastingMath.sol";
import {EverlastingGreeks} from "../src/libs/EverlastingGreeks.sol";

/// @notice External wrappers so the tests can expect reverts and call the internal libraries.
contract EverlastingGreeksHarness {
    function callGreeks(uint256 s, uint256 k, uint64 sig, uint32 tau)
        external
        pure
        returns (EverlastingGreeks.G memory)
    {
        return EverlastingGreeks.call(s, k, sig, tau);
    }

    function putGreeks(uint256 s, uint256 k, uint64 sig, uint32 tau)
        external
        pure
        returns (EverlastingGreeks.G memory)
    {
        return EverlastingGreeks.put(s, k, sig, tau);
    }

    function callValue(uint256 s, uint256 k, uint64 sig, uint32 tau) external pure returns (uint256) {
        return EverlastingMath.callValue(s, k, sig, tau);
    }

    function uWad(uint64 sig, uint32 tau) external pure returns (uint256) {
        return EverlastingMath.uWad(sig, tau);
    }
}

/// @notice Todo 03: Greeks of the everlasting option. R1 to R6 as named in the todo.
contract EverlastingGreeksTest is Test {
    uint256 internal constant WAD = 1e18;
    uint32 internal constant DAILY = 86_400;
    uint32 internal constant WEEKLY = 604_800;
    /// @dev Finite-difference tolerance 1e-4 (1e18-scaled) and Sol-vs-TS tolerance 1e-8.
    uint256 internal constant REL_FD = 1e14;
    uint256 internal constant REL_TS = 1e10;

    EverlastingGreeksHarness internal h;

    struct GreeksCase {
        uint256 K;
        uint256 S;
        uint256 delta;
        uint256 gamma;
        uint256 sigmaBps;
        uint256 tauSeconds;
        uint256 vega;
    }

    function setUp() public {
        h = new EverlastingGreeksHarness();
    }

    // -------------------------------------------------------------------------------------------------- helpers

    function _abs(int256 x) internal pure returns (uint256) {
        return x >= 0 ? uint256(x) : uint256(-x);
    }

    /// @dev |got - want| <= rel * |want| / 1e18 + absTol.
    function _near(int256 got, int256 want, uint256 rel, uint256 absTol) internal pure returns (bool) {
        return _abs(got - want) <= Math.mulDiv(rel, _abs(want), WAD) + absTol;
    }

    function _logUniform(uint256 seed, uint256 lo, uint256 hi) internal pure returns (uint256) {
        uint256 decades = Math.log10(hi / lo);
        uint256 d = seed % (decades + 1);
        uint256 base = lo * 10 ** d;
        uint256 top = base * 10 > hi ? hi : base * 10;
        return bound(uint256(keccak256(abi.encode(seed))), base, top);
    }

    /// @dev K in [1e15, 1e27] wei (0.001 to 1e9 USDG), S/K in [1/2, 2], sigma in [1002, 29998] bps (room for the
    /// +/- 2 bps vega steps), tau in [1 h, 30 d].
    function _domain(uint256 kSeed, uint256 rSeed, uint256 sigSeed, uint256 tauSeed)
        internal
        pure
        returns (uint256 s, uint256 k, uint64 sig, uint32 tau)
    {
        k = _logUniform(kSeed, 1e15, 1e27);
        uint256 ratio = bound(rSeed, WAD / 2, 2 * WAD);
        s = Math.mulDiv(k, ratio, WAD);
        sig = uint64(bound(sigSeed, 1002, 29_998));
        tau = uint32(bound(tauSeed, 3600, 30 days));
    }

    /// @dev Step in S: S / (1000 u). Keeps (h u / S)^2 = 1e-6, so the O(h^2) truncation is far below 1e-4.
    function _hS(uint256 s, uint64 sig, uint32 tau) internal view returns (uint256) {
        return Math.mulDiv(s, WAD, 1000 * h.uWad(sig, tau));
    }

    function _v(uint256 s, uint256 k, uint64 sig, uint32 tau) internal view returns (int256) {
        return int256(h.callValue(s, k, sig, tau));
    }

    /// @dev Central difference in S of the closed-form call value, WAD.
    function _fdDelta(uint256 s, uint256 k, uint64 sig, uint32 tau, uint256 hs) internal view returns (int256) {
        return (_v(s + hs, k, sig, tau) - _v(s - hs, k, sig, tau)) * int256(WAD) / int256(2 * hs);
    }

    function _fdGamma(uint256 s, uint256 k, uint64 sig, uint32 tau, uint256 hs) internal view returns (int256) {
        int256 d2 = _v(s + hs, k, sig, tau) - 2 * _v(s, k, sig, tau) + _v(s - hs, k, sig, tau);
        return d2 * 1e36 / int256(hs * hs);
    }

    /// @dev Central difference in sigma with steps of 1 and 2 bps, Richardson-extrapolated (O(h^4)); per vol point
    /// (100 bps): D_h = (V(sig + h) - V(sig - h)) / (2h) * 100.
    function _fdVega(uint256 s, uint256 k, uint64 sig, uint32 tau) internal view returns (int256) {
        int256 d1 = (_v(s, k, sig + 1, tau) - _v(s, k, sig - 1, tau)) * 50;
        int256 d2 = (_v(s, k, sig + 2, tau) - _v(s, k, sig - 2, tau)) * 25;
        return (4 * d1 - d2) / 3;
    }

    // ------------------------------------------------------------------------------------------ R1 to R3 (fuzz)

    /// R1 deltaMatchesFiniteDifference (away from S = K): relative error < 1e-4, plus the 1-wei noise of the values
    /// divided by the step.
    function testFuzz_R1_deltaMatchesFiniteDifference(uint256 kSeed, uint256 rSeed, uint256 sigSeed, uint256 tauSeed)
        public
        view
    {
        (uint256 s, uint256 k, uint64 sig, uint32 tau) = _domain(kSeed, rSeed, sigSeed, tauSeed);
        uint256 hs = _hS(s, sig, tau);
        if (s <= k && k - s < 4 * hs) s = k - 4 * hs;
        if (s > k && s - k < 4 * hs) s = k + 4 * hs;
        EverlastingGreeks.G memory g = h.callGreeks(s, k, sig, tau);
        int256 fd = _fdDelta(s, k, sig, tau, hs);
        assertTrue(_near(fd, g.delta, REL_FD, 4 * WAD / (2 * hs) + 1), "delta vs finite difference");
    }

    /// R2 gammaMatchesFiniteDifference (away from S = K).
    function testFuzz_R2_gammaMatchesFiniteDifference(uint256 kSeed, uint256 rSeed, uint256 sigSeed, uint256 tauSeed)
        public
        view
    {
        (uint256 s, uint256 k, uint64 sig, uint32 tau) = _domain(kSeed, rSeed, sigSeed, tauSeed);
        uint256 hs = _hS(s, sig, tau);
        if (s <= k && k - s < 4 * hs) s = k - 4 * hs;
        if (s > k && s - k < 4 * hs) s = k + 4 * hs;
        EverlastingGreeks.G memory g = h.callGreeks(s, k, sig, tau);
        int256 fd = _fdGamma(s, k, sig, tau, hs);
        assertTrue(_near(fd, int256(g.gamma), REL_FD, 8 * 1e36 / (hs * hs) + 1), "gamma vs finite difference");
    }

    /// R3 vegaMatchesFiniteDifference (anywhere, including S = K: V is smooth in sigma).
    function testFuzz_R3_vegaMatchesFiniteDifference(uint256 kSeed, uint256 rSeed, uint256 sigSeed, uint256 tauSeed)
        public
        view
    {
        (uint256 s, uint256 k, uint64 sig, uint32 tau) = _domain(kSeed, rSeed, sigSeed, tauSeed);
        EverlastingGreeks.G memory g = h.callGreeks(s, k, sig, tau);
        int256 fd = _fdVega(s, k, sig, tau);
        assertTrue(_near(fd, int256(g.vega), REL_FD, 400), "vega vs finite difference");
        assertTrue(_near(_fdVega(k, k, sig, tau), int256(h.callGreeks(k, k, sig, tau).vega), REL_FD, 400), "ATM vega");
    }

    /// R1 / R2 at S = K: second-order one-sided differences from each side against the stated (S <= K) branch.
    function testFuzz_R1R2_oneSidedAtStrike(uint256 kSeed, uint256 sigSeed, uint256 tauSeed) public view {
        (, uint256 k, uint64 sig, uint32 tau) = _domain(kSeed, WAD, sigSeed, tauSeed);
        uint256 hs = _hS(k, sig, tau);
        EverlastingGreeks.G memory g = h.callGreeks(k, k, sig, tau);
        int256 v0 = _v(k, k, sig, tau);
        int256[4] memory up;
        int256[4] memory dn;
        for (uint256 i = 1; i <= 3; ++i) {
            up[i] = _v(k + i * hs, k, sig, tau);
            dn[i] = _v(k - i * hs, k, sig, tau);
        }
        int256 ih = int256(hs);
        int256 dUp = (-3 * v0 + 4 * up[1] - up[2]) * int256(WAD) / (2 * ih);
        int256 dDn = (3 * v0 - 4 * dn[1] + dn[2]) * int256(WAD) / (2 * ih);
        uint256 dNoise = 8 * WAD / (2 * hs) + 1;
        assertTrue(_near(dUp, g.delta, REL_FD, dNoise), "delta, right-hand difference");
        assertTrue(_near(dDn, g.delta, REL_FD, dNoise), "delta, left-hand difference");
        int256 gUp = (2 * v0 - 5 * up[1] + 4 * up[2] - up[3]) * 1e36 / (ih * ih);
        int256 gDn = (2 * v0 - 5 * dn[1] + 4 * dn[2] - dn[3]) * 1e36 / (ih * ih);
        uint256 gNoise = 12 * 1e36 / (hs * hs) + 1;
        assertTrue(_near(gUp, int256(g.gamma), REL_FD, gNoise), "gamma, right-hand difference");
        assertTrue(_near(gDn, int256(g.gamma), REL_FD, gNoise), "gamma, left-hand difference");
    }

    // ---------------------------------------------------------------------------------------------- R4, R5

    /// R4 putGreeksFromParity: put delta = call delta - 1, equal gamma and vega, exactly.
    function testFuzz_R4_putGreeksFromParity(uint256 sSeed, uint256 kSeed, uint256 sigSeed, uint256 tauSeed)
        public
        view
    {
        uint256 k = _logUniform(kSeed, 1e12, 1e30);
        uint256 s = _logUniform(sSeed, 1e12, 1e30);
        uint64 sig = uint64(bound(sigSeed, 1000, 30_000));
        uint32 tau = uint32(bound(tauSeed, 3600, 30 days));
        EverlastingGreeks.G memory c = h.callGreeks(s, k, sig, tau);
        EverlastingGreeks.G memory p = h.putGreeks(s, k, sig, tau);
        assertEq(p.delta, c.delta - int256(WAD), "put delta");
        assertEq(p.gamma, c.gamma, "put gamma");
        assertEq(p.vega, c.vega, "put vega");
        // Values satisfy parity C - P = S - K exactly (same time value).
        assertEq(int256(c.v) - int256(p.v), int256(s) - int256(k), "value parity");
    }

    /// R5 signsAndRanges: call delta in [0, 1] and put delta in [-1, 0] everywhere on the domain (open intervals
    /// whenever the time value is at least 1e-6 of K, below that the q terms can round to 0 in WAD); gamma, vega >= 0;
    /// delta continuous at S = K within 1e-9.
    function testFuzz_R5_signsAndRanges(uint256 sSeed, uint256 kSeed, uint256 sigSeed, uint256 tauSeed) public view {
        uint256 k = _logUniform(kSeed, 1e15, 1e24);
        uint256 s = _logUniform(sSeed, 1e15, 1e24);
        uint64 sig = uint64(bound(sigSeed, 1000, 30_000));
        uint32 tau = uint32(bound(tauSeed, 3600, 30 days));
        EverlastingGreeks.G memory c = h.callGreeks(s, k, sig, tau);
        EverlastingGreeks.G memory p = h.putGreeks(s, k, sig, tau);
        assertGe(c.delta, 0);
        assertLe(c.delta, int256(WAD));
        assertGe(p.delta, -int256(WAD));
        assertLe(p.delta, 0);
        uint256 tv = s > k ? c.v - (s - k) : c.v;
        if (tv * 1e6 >= k) {
            assertGt(c.delta, 0, "call delta > 0");
            assertLt(c.delta, int256(WAD), "call delta < 1");
            assertGt(p.delta, -int256(WAD), "put delta > -1");
            assertLt(p.delta, 0, "put delta < 0");
            assertGt(c.gamma, 0, "gamma > 0");
            assertGt(c.vega, 0, "vega > 0");
        }
        // Continuity at the strike: one wei either side.
        EverlastingGreeks.G memory a = h.callGreeks(k, k, sig, tau);
        EverlastingGreeks.G memory b = h.callGreeks(k + 1, k, sig, tau);
        EverlastingGreeks.G memory d = h.callGreeks(k - 1, k, sig, tau);
        assertLe(_abs(b.delta - a.delta), 1e9, "delta right of strike");
        assertLe(_abs(a.delta - d.delta), 1e9, "delta left of strike");
    }

    /// ATM: delta = 1/2 + 1/(4u) (spec 1.2), V = K / (2u) and the S >= K branch formula gives the same delta.
    function test_atmDeltaMatchesSpec() public view {
        uint256 k = 100e18;
        uint256 u = h.uWad(5000, DAILY);
        EverlastingGreeks.G memory g = h.callGreeks(k, k, 5000, DAILY);
        uint256 want = WAD / 2 + WAD * WAD / (4 * u);
        assertApproxEqAbs(uint256(g.delta), want, 2);
        // Spec 1.2: S = K = 100, sigma = 50%, Daily: V = 0.92525.
        assertApproxEqAbs(g.v, 0.92525e18, 0.00001e18);
        // vega at the money = V / sigma per unit sigma (V is proportional to 1/(2u) ~ sigma sqrt(tau)/sqrt(8)), / 100.
        assertApproxEqRel(g.vega, g.v * 2 / 100, 1e15); // sigma = 0.5, within 0.1% (1/(2u) is not exactly linear)
    }

    /// Out-of-domain inputs revert like EverlastingMath.
    function test_domainReverts() public {
        vm.expectRevert(EverlastingMath.OutOfDomain.selector);
        h.callGreeks(1e11, 100e18, 5000, DAILY);
        vm.expectRevert(EverlastingMath.OutOfDomain.selector);
        h.putGreeks(100e18, 1e31, 5000, DAILY);
        vm.expectRevert(EverlastingMath.OutOfDomain.selector);
        h.callGreeks(100e18, 100e18, 999, DAILY);
        vm.expectRevert(EverlastingMath.OutOfDomain.selector);
        h.callGreeks(100e18, 100e18, 5000, 3599);
    }

    /// Extreme corners of the domain do not overflow and stay in range.
    function test_extremeCorners() public view {
        uint64[2] memory sigs = [uint64(1000), uint64(30_000)];
        uint32[2] memory taus = [uint32(3600), uint32(30 days)];
        uint256[3] memory prices = [uint256(1e12), uint256(1e21), uint256(1e30)];
        for (uint256 a = 0; a < 2; ++a) {
            for (uint256 b = 0; b < 2; ++b) {
                for (uint256 i = 0; i < 3; ++i) {
                    for (uint256 j = 0; j < 3; ++j) {
                        EverlastingGreeks.G memory g = h.callGreeks(prices[i], prices[j], sigs[a], taus[b]);
                        assertGe(g.delta, 0);
                        assertLe(g.delta, int256(WAD));
                    }
                }
            }
        }
    }

    // ------------------------------------------------------------------------------------------------- R6

    /// R6 solMatchesTs: the first 500 vectors (fixed edge cases first), call delta, gamma and vega within 1e-8 relative
    /// of the TypeScript values (plus 2 wei for the rounding of each side to an integer).
    function test_R6_solMatchesTs() public view {
        string memory json = vm.readFile(string.concat(vm.projectRoot(), "/test/vectors/pricing-vectors.json"));
        GreeksCase[] memory c = abi.decode(
            vm.parseJsonTypeArray(
                json,
                ".cases",
                "GreeksCase(uint256 K,uint256 S,uint256 delta,uint256 gamma,uint256 sigmaBps,uint256 tauSeconds,uint256 vega)"
            ),
            (GreeksCase[])
        );
        assertEq(c.length, 2000);
        uint256 worstDelta;
        uint256 worstGamma;
        uint256 worstVega;
        for (uint256 i = 0; i < 500; ++i) {
            uint64 sig = uint64(c[i].sigmaBps);
            uint32 tau = uint32(c[i].tauSeconds);
            EverlastingGreeks.G memory g = h.callGreeks(c[i].S, c[i].K, sig, tau);
            string memory id = vm.toString(i);
            assertTrue(_near(g.delta, int256(c[i].delta), REL_TS, 2), string.concat("delta case ", id));
            assertTrue(_near(int256(g.gamma), int256(c[i].gamma), REL_TS, 2), string.concat("gamma case ", id));
            assertTrue(_near(int256(g.vega), int256(c[i].vega), REL_TS, 2), string.concat("vega case ", id));
            // Put delta from the TS call delta: near 1 a double carries ~1e-16 absolute (~111 wei per ulp), so the
            // small put delta of a deep in-the-money call gets that absolute slack.
            EverlastingGreeks.G memory p = h.putGreeks(c[i].S, c[i].K, sig, tau);
            assertTrue(_near(p.delta, int256(c[i].delta) - int256(WAD), REL_TS, 256), string.concat("put delta ", id));
            worstDelta = _worst(worstDelta, uint256(g.delta), c[i].delta);
            worstGamma = _worst(worstGamma, g.gamma, c[i].gamma);
            worstVega = _worst(worstVega, g.vega, c[i].vega);
        }
        console2.log("R6 worst rel err on values >= 1e9 wei (1e18 = 100%) delta / gamma / vega:");
        console2.log(worstDelta, worstGamma, worstVega);
    }

    function _worst(uint256 cur, uint256 got, uint256 want) internal pure returns (uint256) {
        if (want < 1e9) return cur;
        uint256 d = got > want ? got - want : want - got;
        uint256 r = d * WAD / want;
        return r > cur ? r : cur;
    }

    /// Gas: call Greeks through the harness (overhead included), logged for the engine's budget.
    function test_gasCallGreeks() public view {
        uint256 g0 = gasleft();
        h.callGreeks(105e18, 100e18, 5000, WEEKLY);
        console2.log("callGreeks gas (external, incl. value):", g0 - gasleft());
    }
}
