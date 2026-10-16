// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @title FixedMath
/// @notice exp, ln, pow and sqrt in WAD (1e18) fixed point, computed internally at 1e36 so that the results are accurate
/// to about 1e-17 relative (exp, pow) or 1e-18 absolute (ln) and are smooth enough for pricing to be monotone.
/// @dev Method (no tables of magic coefficients, so every step is checkable):
///  - exp: a = k ln2 + r with k = round(a / ln2) and |r| <= ln2 / 2, then e^r by its Taylor series at 1e36 and
///    e^a = e^r * 2^k. The series terms shrink by at least a factor 0.35 / n, so it stops after about 25 terms.
///  - ln: x = m * 2^n with m in [1/sqrt2, sqrt2), then ln m = 2 atanh(s) = 2 (s + s^3/3 + s^5/5 + ...) with
///    s = (m - 1)/(m + 1), |s| <= 0.1716, so s^2 <= 0.0295 and the series stops after about 25 terms.
/// No `unchecked` blocks: every operation is checked arithmetic.
library FixedMath {
    uint256 internal constant WAD = 1e18;
    int256 internal constant IWAD = 1e18;
    /// @dev Internal precision of the series.
    int256 internal constant R36 = 1e36;
    /// @dev ln 2 * 1e36, rounded to nearest.
    int256 internal constant LN2_36 = 693147180559945309417232121458176568;
    /// @dev ln(1e18) * 1e36, rounded to nearest (converts ln of a raw WAD integer to ln of its value).
    int256 internal constant LN_WAD_36 = 41446531673892822312323846184318555737;
    /// @dev sqrt 2 * 1e36, rounded to nearest.
    uint256 internal constant SQRT2_36 = 1414213562373095048801688724209698079;

    /// @dev expWad returns 0 below this (e^-42 < 1e-18, so the WAD result is at most 1 wei there anyway).
    int256 internal constant EXP_MIN_WAD = -42e18;
    /// @dev expWad reverts above this (e^135 * 1e18 ~ 4.3e76 still fits in uint256; e^136 would not).
    int256 internal constant EXP_MAX_WAD = 135e18;

    error ExpOverflow(int256 x);
    error LnUndefined();
    error PowUndefined();

    /// @notice e^(x / 1e18) * 1e18. Saturates to 0 below -42e18, reverts above 135e18.
    function expWad(int256 x) internal pure returns (uint256) {
        if (x < EXP_MIN_WAD) return 0;
        if (x > EXP_MAX_WAD) revert ExpOverflow(x);
        // |x| <= 135e18, so x * 1e18 <= 1.35e38: no overflow.
        (uint256 s, int256 k) = expReduced36(x * IWAD);
        // e^x = s / 1e36 * 2^k  ->  WAD result = s * 2^k / 1e18.
        if (k >= 0) {
            // k <= 195 (135 / ln2 rounded), s * 2^k / 1e18 <= 4.3e76: mulDiv does it in 512 bits without overflow.
            return Math.mulDiv(s, uint256(1) << uint256(k), WAD);
        }
        // k >= -61 (x >= -42e18), so 1e18 << 61 ~ 2.3e36 fits.
        return s / (WAD << uint256(-k));
    }

    /// @notice ln(x / 1e18) * 1e18, rounded to nearest. Reverts for x == 0.
    function lnWad(uint256 x) internal pure returns (int256) {
        int256 l = ln36(x);
        // Round half away from zero when dropping 18 digits.
        return l >= 0 ? (l + IWAD / 2) / IWAD : (l - IWAD / 2) / IWAD;
    }

    /// @notice (x / 1e18)^(e / 1e18) * 1e18, computed as exp(e * ln x) with ln x kept at 1e36.
    /// @dev x == 0: returns 0 for e > 0, reverts otherwise. Reverts like expWad when the result exceeds e^135.
    function powWad(uint256 x, int256 e) internal pure returns (uint256) {
        if (x == 0) {
            if (e > 0) return 0;
            revert PowUndefined();
        }
        if (e == 0) return WAD;
        int256 l = ln36(x); // |l| <= 136e36 (x < 2^256)
        // Saturate / revert on the 1e36-scaled product before forming it, so e * l cannot overflow:
        // |e * l| < 2^255 needs |e| < 5.7e76 / 1.36e38 ~ 4.2e38, checked by the guard below.
        if (l != 0 && (e > 4e38 || e < -4e38)) {
            // |e| >= 400 and |ln x| >= 1e-36: the result is 0 or overflows; let the sign decide.
            if ((e > 0) == (l > 0)) revert ExpOverflow(type(int256).max);
            return 0;
        }
        int256 a36 = (e * l) / IWAD; // exponent of e at 1e36
        if (a36 < EXP_MIN_WAD * IWAD) return 0;
        if (a36 > EXP_MAX_WAD * IWAD) revert ExpOverflow(a36 / IWAD);
        (uint256 s, int256 k) = expReduced36(a36);
        if (k >= 0) return Math.mulDiv(s, uint256(1) << uint256(k), WAD);
        return s / (WAD << uint256(-k));
    }

    /// @notice sqrt(x / 1e18) * 1e18, rounded down.
    function sqrtWad(uint256 x) internal pure returns (uint256) {
        if (x <= type(uint256).max / WAD) return Math.sqrt(x * WAD);
        // Large x: sqrt(x) * 1e9 loses only the fractional part of sqrt(x), relative error < 1e-29 here.
        return Math.sqrt(x) * 1e9;
    }

    // ---------------------------------------------------------------------------------------------------------- core

    /// @notice ln(x / 1e18) * 1e36 for a WAD x > 0. Absolute error about 1e-34.
    function ln36(uint256 x) internal pure returns (int256) {
        if (x == 0) revert LnUndefined();
        uint256 n = Math.log2(x); // x in [2^n, 2^(n+1))
        // m = x / 2^n in [1, 2) at 1e36 (mulDiv is exact up to its floor; x * 1e36 may exceed 256 bits).
        uint256 m = Math.mulDiv(x, uint256(R36), uint256(1) << n);
        int256 twoPow = int256(n);
        if (m > SQRT2_36) {
            // Use x / 2^(n+1) instead, in [1/sqrt2, 1): written as x * (1e36 / 2) / 2^n so 2^(n+1) never overflows.
            m = Math.mulDiv(x, uint256(R36) / 2, uint256(1) << n);
            twoPow += 1;
        }
        // m <= sqrt2 * 1e36 < 2^121, so the casts and the arithmetic below are far from int256 limits.
        int256 mi = int256(m);
        int256 s = ((mi - R36) * R36) / (mi + R36); // |s| <= 0.1716e36
        int256 s2 = (s * s) / R36; // <= 0.0295e36
        int256 term = s;
        int256 sum = s;
        for (int256 i = 3;; i += 2) {
            term = (term * s2) / R36;
            int256 t = term / i;
            if (t == 0) break;
            sum += t;
        }
        // n <= 255, so twoPow * LN2_36 <= 1.8e38 and the sum stays far below 2^255.
        return twoPow * LN2_36 + 2 * sum - LN_WAD_36;
    }

    /// @notice Splits e^(a / 1e36) into s / 1e36 * 2^k with s in [0.70e36, 1.42e36]. Requires |a| <= 1e40.
    /// @dev Error of s: about 30 units of 1e-36 from the series plus |k| * 0.5e-36 from the rounded ln 2.
    function expReduced36(int256 a) internal pure returns (uint256 s, int256 k) {
        // k = round(a / ln2); Solidity division truncates toward zero, so add half of ln2 with the sign of a.
        k = a >= 0 ? (a + LN2_36 / 2) / LN2_36 : (a - LN2_36 / 2) / LN2_36;
        int256 r = a - k * LN2_36; // |r| <= ln2 / 2 * 1e36 (+ rounding of a few units)
        int256 sum = R36;
        int256 term = R36;
        for (int256 i = 1;; ++i) {
            // |term| <= 1e36 and |r| <= 0.35e36: the product is < 4e71, far below 2^255.
            term = (term * r) / (R36 * i);
            if (term == 0) break;
            sum += term;
        }
        s = uint256(sum); // sum >= e^-0.35 * 1e36 > 0
    }
}
