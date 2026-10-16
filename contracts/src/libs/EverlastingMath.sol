// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {FixedMath} from "./FixedMath.sol";

/// @title EverlastingMath
/// @notice Closed-form value of an everlasting option (r = 0): a Black-Scholes option with an exponentially distributed
/// expiry of mean tau. With u = sqrt(1/4 + 2/(sigma^2 tau)) and x = S/K:
///   S <= K:  C = K/(2u) x^(1/2 + u)
///   S >= K:  C = (S - K) + K/(2u) x^(1/2 - u)
///   P = C - (S - K), computed as (K - S)+ + the same time value, so parity holds exactly and a far out-of-the-money
///   put keeps full relative precision.
/// @dev Units: S, K and values in WAD (USDG per one whole Stock Token), sigma in bps (5000 = 50%), tau in seconds
/// (year = 365 days). The power is taken in log space at 1e36, exp((1/2 +/- u) ln x), and the exponent is never
/// positive (ln x <= 0 when S <= K, and 1/2 - u <= 0 when S > K), so u in the thousands cannot overflow: the time value
/// only underflows to 0, which is its correct value to the wei. Mirrors app/src/pricing/everlasting.ts.
library EverlastingMath {
    uint256 internal constant WAD = 1e18;
    uint256 internal constant BPS = 10_000;
    uint256 internal constant YEAR_SECONDS = 31_536_000;

    uint64 internal constant MIN_SIGMA_BPS = 1_000;
    uint64 internal constant MAX_SIGMA_BPS = 30_000;
    uint32 internal constant MIN_TAU_SECONDS = 3_600;
    uint32 internal constant MAX_TAU_SECONDS = 30 days;
    uint256 internal constant MIN_PRICE_WAD = 1e12;
    uint256 internal constant MAX_PRICE_WAD = 1e30;

    /// @dev Below e^-84 the time value is under 1e-36 of K, i.e. below 1 wei for any K <= 1e30: return 0.
    int256 internal constant MIN_EXPONENT_36 = -84e36;

    error OutOfDomain();

    /// @notice u = sqrt(1/4 + 2 / (sigma^2 tau)) in WAD, rounded down. Always >= 1/2.
    function uWad(uint64 sigmaBps, uint32 tauSeconds) internal pure returns (uint256) {
        _checkSigmaTau(sigmaBps, tauSeconds);
        return _u(sigmaBps, tauSeconds);
    }

    /// @notice Everlasting call value in WAD.
    function callValue(uint256 sWad, uint256 kWad, uint64 sigmaBps, uint32 tauSeconds) internal pure returns (uint256) {
        _checkPrices(sWad, kWad);
        _checkSigmaTau(sigmaBps, tauSeconds);
        uint256 tv = timeValueU(sWad, kWad, _u(sigmaBps, tauSeconds));
        return sWad > kWad ? sWad - kWad + tv : tv;
    }

    /// @notice Everlasting put value in WAD.
    function putValue(uint256 sWad, uint256 kWad, uint64 sigmaBps, uint32 tauSeconds) internal pure returns (uint256) {
        _checkPrices(sWad, kWad);
        _checkSigmaTau(sigmaBps, tauSeconds);
        uint256 tv = timeValueU(sWad, kWad, _u(sigmaBps, tauSeconds));
        return sWad < kWad ? kWad - sWad + tv : tv;
    }

    /// @notice Time value K/(2u) x^(1/2 +/- u) in WAD for a given u (WAD, >= 1/2). Shared by call and put.
    /// @dev No domain check on S, K beyond S, K > 0 (callers check); S, K < 2^127 keeps every product below.
    function timeValueU(uint256 sWad, uint256 kWad, uint256 u) internal pure returns (uint256) {
        if (sWad == 0 || kWad == 0 || u < WAD / 2 || sWad > type(uint128).max || kWad > type(uint128).max || u > 1e24) {
            revert OutOfDomain();
        }
        // ln x at 1e36 as a difference of logs: no rounding of the ratio S/K, and exactly 0 when S == K.
        int256 lnx = FixedMath.ln36(sWad) - FixedMath.ln36(kWad); // |lnx| <= 89e36 for S, K < 2^128
        // exponent (1/2 + u) when S <= K (lnx <= 0), (1/2 - u) when S > K (lnx > 0): the product is <= 0 either way.
        int256 e = sWad <= kWad ? int256(WAD / 2 + u) : int256(WAD / 2) - int256(u); // |e| <= 1e24
        int256 a = (e * lnx) / FixedMath.IWAD; // |e * lnx| <= 1e24 * 89e36 ~ 9e61: no overflow. a <= 0.
        if (a < MIN_EXPONENT_36) return 0;
        (uint256 s, int256 k) = FixedMath.expReduced36(a); // x^(...) = s / 1e36 * 2^k, k in [-122, 0]
        // tv = K * s / 1e36 / (2u / 1e18) = K * s / (2u * 1e18); K * s < 2^128 * 2^121 fits, mulDiv for safety.
        uint256 tv = Math.mulDiv(kWad, s, 2 * u * WAD);
        // k <= 0 because a <= 0 (round(a / ln2) of a non-positive number).
        return tv >> uint256(-k);
    }

    // --------------------------------------------------------------------------------------------------- internal

    function _u(uint64 sigmaBps, uint32 tauSeconds) private pure returns (uint256) {
        // u^2 * 1e36 = 0.25e36 + 2e36 / (sigma^2 tau_years), sigma = sigmaBps / 1e4, tau_years = tauSeconds / YEAR.
        //            = 0.25e36 + 2e36 * 1e8 * YEAR / (sigmaBps^2 * tauSeconds)
        // Numerator 2e44 * 3.15e7 = 6.3e51; the result is <= 1.8e42: no overflow. sqrt of it is u in WAD.
        uint256 u2 = WAD * WAD / 4 + (2 * WAD * WAD * BPS * BPS * YEAR_SECONDS)
            / (uint256(sigmaBps) * uint256(sigmaBps) * uint256(tauSeconds));
        return Math.sqrt(u2);
    }

    function _checkSigmaTau(uint64 sigmaBps, uint32 tauSeconds) private pure {
        if (sigmaBps < MIN_SIGMA_BPS || sigmaBps > MAX_SIGMA_BPS) revert OutOfDomain();
        if (tauSeconds < MIN_TAU_SECONDS || tauSeconds > MAX_TAU_SECONDS) revert OutOfDomain();
    }

    function _checkPrices(uint256 sWad, uint256 kWad) private pure {
        if (sWad < MIN_PRICE_WAD || sWad > MAX_PRICE_WAD) revert OutOfDomain();
        if (kWad < MIN_PRICE_WAD || kWad > MAX_PRICE_WAD) revert OutOfDomain();
    }
}
