// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {EverlastingMathHarness} from "../harness/EverlastingMathHarness.sol";

/// @notice Fuzz properties of FixedMath and EverlastingMath (todo 02): R1, R2, R4, R5.
contract EverlastingMathFuzzTest is Test {
    uint256 internal constant WAD = 1e18;
    uint256 internal constant REL_1E9 = 1e9; // 1e-9 in 1e18-scaled ratios

    EverlastingMathHarness internal h;

    function setUp() public {
        h = new EverlastingMathHarness();
    }

    // ------------------------------------------------------------------ helpers

    /// @dev Log-uniform integer in [lo, hi] (lo >= 1): a uniform exponent plus a uniform mantissa.
    function _logUniform(uint256 seed, uint256 lo, uint256 hi) internal pure returns (uint256) {
        uint256 decades = Math.log10(hi / lo);
        uint256 d = seed % (decades + 1);
        uint256 base = lo * 10 ** d;
        uint256 top = base * 10 > hi ? hi : base * 10;
        return bound(uint256(keccak256(abi.encode(seed))), base, top);
    }

    function _relClose(uint256 got, uint256 want, uint256 rel) internal pure returns (bool) {
        uint256 d = got > want ? got - want : want - got;
        return d <= Math.mulDiv(rel, want, WAD); // no overflow for results up to e^135
    }

    function _domain(uint256 sSeed, uint256 kSeed, uint256 sigSeed, uint256 tauSeed)
        internal
        pure
        returns (uint256 s, uint256 k, uint64 sig, uint32 tau)
    {
        k = _logUniform(kSeed, 1e12, 1e30);
        // S within a factor 1000 of K so most cases have a non-trivial time value; still clamped to the domain.
        uint256 lo = k / 1000 < 1e12 ? 1e12 : k / 1000;
        uint256 hi = k > 1e30 / 1000 ? 1e30 : k * 1000;
        s = _logUniform(sSeed, lo, hi);
        sig = uint64(bound(sigSeed, 1000, 30_000));
        tau = uint32(bound(tauSeed, 3600, 30 days));
    }

    // ------------------------------------------------------------------ R1

    /// R1: exp, ln and pow against independent identities, relative error < 1e-9.
    function testFuzz_R1_expLnPowAccuracy(uint256 xSeed, int256 aRaw, int256 bRaw, uint256 nRaw, uint256 ySeed)
        public
        view
    {
        // exp(ln x) = x for x in [1e12, 1e36] (results >= 1e12 wei, so output rounding is <= 1e-12).
        uint256 x = _logUniform(xSeed, 1e12, 1e36);
        assertTrue(_relClose(h.expWad(h.lnWad(x)), x, REL_1E9), "exp(ln x)");

        // ln(exp a) = a, absolute 1e-9, for a in [-20, 130] (exp(a) >= 2e9 wei).
        int256 a = bound(aRaw, -20e18, 130e18);
        assertApproxEqAbs(h.lnWad(h.expWad(a)), a, 1e9, "ln(exp a)");

        // exp(a) exp(b) = exp(a + b) for a, b in [-20, 60].
        int256 a2 = bound(aRaw, -20e18, 60e18);
        int256 b2 = bound(bRaw, -20e18, 60e18);
        uint256 lhs = Math.mulDiv(h.expWad(a2), h.expWad(b2), WAD);
        assertTrue(_relClose(lhs, h.expWad(a2 + b2), REL_1E9), "exp(a)exp(b)");

        // ln(x y) = ln x + ln y, absolute 2e-18.
        uint256 y = _logUniform(ySeed, 1e12, 1e36);
        // The raw product x * y (<= 1e72, exact) read as a WAD is xy * 1e18, so its ln is ln x + ln y + ln 1e18.
        assertApproxEqAbs(h.lnWad(x * y), h.lnWad(x) + h.lnWad(y) + 41446531673892822312, 2, "ln(xy)");

        // pow(z, n) = z * z * ... * z (repeated WAD multiplication, error ~ n wei) for z in [0.5, 2], n in 1..30.
        uint256 z = bound(xSeed, 0.5e18, 2e18);
        uint256 n = bound(nRaw, 1, 30);
        uint256 prod = WAD;
        for (uint256 i = 0; i < n; ++i) {
            prod = prod * z / WAD;
        }
        assertTrue(_relClose(h.powWad(z, int256(n) * 1e18), prod, REL_1E9), "pow(z, n)");
        // pow(x, 1/2) = sqrt(x), pow(x, -1) = 1/x.
        assertTrue(_relClose(h.powWad(x, 0.5e18), h.sqrtWad(x), REL_1E9), "pow(x, 1/2)");
        uint256 xs = _logUniform(ySeed, 1e12, 1e24); // 1/x >= 1e12 wei
        assertTrue(_relClose(h.powWad(xs, -1e18), 1e36 / xs, REL_1E9), "pow(x, -1)");
    }

    // ------------------------------------------------------------------ R2

    /// R2: u up to 200, x in [0.1, 10]: never reverts, result in [0, K], equals K/(2u) pow(x, 1/2 +/- u) within 1e-9
    /// relative (or 2 wei), and 0 when that is below 1 wei.
    function testFuzz_R2_highUNoOverflow(uint256 uRaw, uint256 xRaw, uint256 kSeed) public view {
        uint256 u = bound(uRaw, 0.5e18, 200e18);
        uint256 k = _logUniform(kSeed, 1e12, 1e30);
        uint256 s = Math.mulDiv(k, bound(xRaw, 0.1e18, 10e18), WAD);
        if (s == 0) s = 1;
        uint256 tv = h.timeValueU(s, k, u);
        assertLe(tv, k, "tv <= K");
        int256 e = s <= k ? int256(u + 0.5e18) : int256(0.5e18) - int256(u);
        // Reference from the WAD API: pow of the rounded ratio, so allow its 1e-18 ratio rounding times |e|.
        uint256 ref = Math.mulDiv(k, h.powWad(Math.mulDiv(s, WAD, k), e), 2 * u);
        uint256 d = tv > ref ? tv - ref : ref - tv;
        // ratio rounding: |d ln x| <= 1e-18 / x <= 1e-17, times |e| <= 201 -> 2e-15 relative; pow rounding 1 wei of 1e18
        // scaled by K/(2u) -> K/1e18 wei.
        assertLe(d, ref / 1e9 + k / 1e18 + 2, "tv vs pow reference");
    }

    // ------------------------------------------------------------------ R4

    /// R4: |C - P - (S - K)| <= 4 wei + 1e-12 relative.
    function testFuzz_R4_parityOnChain(uint256 sSeed, uint256 kSeed, uint256 sigSeed, uint256 tauSeed) public view {
        (uint256 s, uint256 k, uint64 sig, uint32 tau) = _domain(sSeed, kSeed, sigSeed, tauSeed);
        int256 c = int256(h.callValue(s, k, sig, tau));
        int256 p = int256(h.putValue(s, k, sig, tau));
        int256 gap = c - p - (int256(s) - int256(k));
        uint256 tol = 4 + (s > k ? s : k) / 1e12;
        assertLe(gap >= 0 ? uint256(gap) : uint256(-gap), tol, "parity");
    }

    // ------------------------------------------------------------------ R5

    /// R5: V >= intrinsic, call <= S, put <= K, call non-decreasing and put non-increasing in S within 2 wei.
    function testFuzz_R5_boundsAndMonotoneOnChain(
        uint256 sSeed,
        uint256 kSeed,
        uint256 sigSeed,
        uint256 tauSeed,
        uint256 stepSeed
    ) public view {
        (uint256 s, uint256 k, uint64 sig, uint32 tau) = _domain(sSeed, kSeed, sigSeed, tauSeed);
        uint256 c = h.callValue(s, k, sig, tau);
        uint256 p = h.putValue(s, k, sig, tau);
        assertGe(c, s > k ? s - k : 0, "call >= intrinsic");
        assertGe(p, k > s ? k - s : 0, "put >= intrinsic");
        assertLe(c, s, "call <= S");
        assertLe(p, k, "put <= K");

        // A step from 1 wei up to 10% of S (log-uniform), kept inside the domain.
        uint256 step = _logUniform(stepSeed, 1, s / 10 + 1);
        uint256 s2 = s + step > 1e30 ? 1e30 : s + step;
        if (s2 <= s) return;
        uint256 c2 = h.callValue(s2, k, sig, tau);
        uint256 p2 = h.putValue(s2, k, sig, tau);
        assertGe(c2 + 2, c, "call monotone in S");
        assertLe(p2, p + 2, "put monotone in S");
    }

    /// R5 at the strike: one wei either side of S = K stays monotone across the branch switch.
    function testFuzz_R5_monotoneAcrossStrike(uint256 kSeed, uint256 sigSeed, uint256 tauSeed) public view {
        uint256 k = _logUniform(kSeed, 1e12 + 1, 1e30 - 1);
        uint64 sig = uint64(bound(sigSeed, 1000, 30_000));
        uint32 tau = uint32(bound(tauSeed, 3600, 30 days));
        uint256 cLo = h.callValue(k - 1, k, sig, tau);
        uint256 cAt = h.callValue(k, k, sig, tau);
        uint256 cHi = h.callValue(k + 1, k, sig, tau);
        assertGe(cAt + 2, cLo, "call at K");
        assertGe(cHi + 2, cAt, "call above K");
        uint256 pLo = h.putValue(k - 1, k, sig, tau);
        uint256 pAt = h.putValue(k, k, sig, tau);
        uint256 pHi = h.putValue(k + 1, k, sig, tau);
        assertLe(pAt, pLo + 2, "put at K");
        assertLe(pHi, pAt + 2, "put above K");
    }
}
