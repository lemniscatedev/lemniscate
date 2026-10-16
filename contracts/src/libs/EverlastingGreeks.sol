// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {FixedMath} from "./FixedMath.sol";
import {EverlastingMath} from "./EverlastingMath.sol";

/// @title EverlastingGreeks
/// @notice Greeks of the everlasting option (r = 0), spec 1.3. With u = sqrt(1/4 + 2/(sigma^2 tau)), x = S/K and TV the
/// time value (C if S <= K, else C - (S - K)):
///   delta  (1/2 + u) C / S            (S <= K)     1 + (1/2 - u) TV / S     (S >= K)
///   gamma  (u^2 - 1/4) C / S^2        (S <= K)     (u^2 - 1/4) TV / S^2     (S >= K)
///   vega   dV/du * du/dsigma with dV/du = C (ln x - 1/u) below, TV (-ln x - 1/u) above, du/dsigma = -2/(sigma^3 tau u)
/// Put Greeks follow from parity: put delta = call delta - 1, same gamma and vega (exactly, in WAD).
/// @dev Computed form (the same algebra, no cancellation): q = x^(u - 1/2) when S <= K, q = x^(-(u + 1/2)) when S > K,
/// so the exponent is never positive and q <= 1; then C = TV = S q / (2u) on either side and
///   delta = (u + 1/2)/(2u) q  below,  1 - (u - 1/2)/(2u) q  above
///   gamma = (u^2 - 1/4) q / (2u S)
///   vega  = S q (1/u + |ln x|) (u^2 - 1/4) / (2 u^2 sigma) / 100            (per vol point)
/// u^2 - 1/4 = 2/(sigma^2 tau) is taken from sigma and tau directly (the same integer EverlastingMath.uWad takes the
/// root of), q is taken in log space at 1e36 like EverlastingMath.timeValueU. Every result is floored except delta
/// above the strike, which is 1 minus a floored term.
/// Units: S, K and v in WAD (USDG per whole Stock Token); delta in WAD per unit; gamma in WAD per 1 USDG move per unit;
/// vega in WAD USDG per vol point (sigma + 1% = 100 bps) per unit. Same domain as EverlastingMath (reverts OutOfDomain).
/// Mirrors app/src/pricing/greeks.ts.
library EverlastingGreeks {
    struct G {
        int256 delta;
        uint256 gamma;
        uint256 vega;
        uint256 v;
    }

    uint256 private constant WAD = 1e18;
    uint256 private constant R36 = 1e36;
    uint256 private constant BPS = 10_000;
    /// @dev 1 vol point in bps.
    uint256 private constant VOL_POINT_BPS = 100;

    /// @notice Call Greeks and value.
    function call(uint256 s, uint256 k, uint64 sigmaBps, uint32 tauSeconds) internal pure returns (G memory g) {
        g = _core(s, k, sigmaBps, tauSeconds);
        g.v = EverlastingMath.callValue(s, k, sigmaBps, tauSeconds);
    }

    /// @notice Put Greeks and value: delta = call delta - 1, same gamma and vega.
    function put(uint256 s, uint256 k, uint64 sigmaBps, uint32 tauSeconds) internal pure returns (G memory g) {
        g = _core(s, k, sigmaBps, tauSeconds);
        g.delta -= int256(WAD);
        g.v = EverlastingMath.putValue(s, k, sigmaBps, tauSeconds);
    }

    // ------------------------------------------------------------------------------------------------------- core

    /// @dev Call delta, gamma and vega (v left 0).
    function _core(uint256 s, uint256 k, uint64 sigmaBps, uint32 tauSeconds) private pure returns (G memory g) {
        if (s < EverlastingMath.MIN_PRICE_WAD || s > EverlastingMath.MAX_PRICE_WAD) {
            revert EverlastingMath.OutOfDomain();
        }
        if (k < EverlastingMath.MIN_PRICE_WAD || k > EverlastingMath.MAX_PRICE_WAD) {
            revert EverlastingMath.OutOfDomain();
        }
        uint256 u = EverlastingMath.uWad(sigmaBps, tauSeconds); // checks sigma and tau; u <= ~1323e18
        // a = u^2 - 1/4 = 2 / (sigma^2 tau) at 1e36, the exact integer uWad adds 1/4 to: <= 1.8e42.
        uint256 a36 = (2 * R36 * BPS * BPS * EverlastingMath.YEAR_SECONDS)
            / (uint256(sigmaBps) * uint256(sigmaBps) * uint256(tauSeconds));

        int256 lnx = FixedMath.ln36(s) - FixedMath.ln36(k); // ln(S/K) at 1e36, |lnx| <= 84e36 on the domain
        bool below = s <= k;
        // Exponent of q at 1e36, never positive: (u - 1/2) lnx with lnx <= 0, or -(u + 1/2) lnx with lnx > 0.
        // |e| <= 1.4e21 and |lnx| <= 84e36, so the product is <= 1.2e59: no overflow.
        int256 e = below ? int256(u - WAD / 2) : -int256(u + WAD / 2);
        int256 expo = (e * lnx) / FixedMath.IWAD;

        if (expo < EverlastingMath.MIN_EXPONENT_36) {
            // q < e^-84 < 1e-36: the q terms are below one wei of every output on the domain.
            g.delta = below ? int256(0) : int256(WAD);
            return g;
        }
        (uint256 qs, int256 qk) = FixedMath.expReduced36(expo); // q = qs / 1e36 * 2^qk, qk <= 0
        uint256 shift = uint256(-qk);

        // delta: (u +/- 1/2)/(2u) * q in WAD = (u +/- 1/2) * qs / (2u * 1e18) >> shift.
        if (below) {
            g.delta = int256(Math.mulDiv(u + WAD / 2, qs, 2 * u * WAD) >> shift);
        } else {
            g.delta = int256(WAD) - int256(Math.mulDiv(u - WAD / 2, qs, 2 * u * WAD) >> shift);
        }

        // gamma in WAD: (a36 / 1e36) * (qs / 1e36) / (2 (u / 1e18) (S / 1e18)) * 1e18 = a36 * qs / (2 u S 1e18).
        // 2 u S 1e18 <= 2.7e21 * 1e30 * 1e18 = 2.7e69 fits; the 512-bit mulDiv takes a36 * qs <= 2.6e78.
        g.gamma = Math.mulDiv(a36, qs, 2 * u * s * WAD) >> shift;

        // vega: f = (1/u + |ln x|) (u^2 - 1/4) / (2 u^2 sigma) / 100 at 1e36, then S q f.
        // m36 = 1/u + |ln x| at 1e36 <= 2e36 + 84e36; sigma = sigmaBps / 1e4 and 1/100 per vol point give
        // f36 = m36 * a36 * 1e36 / (1e36 * 1e36) * 1e36 / (2 (u^2 / 1e36) sigmaBps / 1e4 * 100)
        //     = m36 * a36 * (1e4 / 100) / (2 u^2 sigmaBps),   u^2 <= 1.8e42, the divisor <= 1.1e47.
        uint256 m36 = R36 * WAD / u + uint256(lnx >= 0 ? lnx : -lnx);
        uint256 f36 = Math.mulDiv(m36 * (BPS / VOL_POINT_BPS), a36, 2 * u * u * uint256(sigmaBps));
        // vega WAD = S * (qs / 1e36) * (f36 / 1e36) >> shift; S * qs <= 1e30 * 1.42e36 fits.
        g.vega = Math.mulDiv(s * qs, f36, R36 * R36) >> shift;
    }
}
