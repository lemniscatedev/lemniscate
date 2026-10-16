// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {FixedMath} from "./FixedMath.sol";

/// @title Funding
/// @notice In-kind funding: a series' normalization factor `norm` (WAD, starts at 1e18) shrinks as funding accrues, so
/// holders pay by holding fewer units (units = balance * norm / 1e18) and are never billed.
/// @dev Design decision "Funding correction" (the spec's linear step goes negative once dt >= tau):
///
///     norm <- norm * exp(-r * dt / tau),   r = (V - payoff) / V clamped to [0, 1],   V <= 0 counts as r = 1,
///
/// with V and payoff taken at the start of the step. A gap longer than tau is defined as tau-sized chunks with V frozen
/// at the start value; with V frozen r is constant, so the chunks multiply to exactly exp(-r * dt / tau) and one exp
/// covers any dt (no loop, constant gas). The TypeScript reference (app/src/pricing/funding.ts) multiplies the chunks;
/// test R7/R9 check both agree within 1e-9. The result is rounded down (in the pool's favour, by at most 1 wei of norm),
/// never above the input, and never below MIN_NORM.
library Funding {
    uint256 internal constant WAD = 1e18;
    /// @notice Floor of the normalization factor: 1e-6 of the starting norm.
    uint256 internal constant MIN_NORM = 1e12;
    /// @dev Exponents beyond this make exp() smaller than MIN_NORM / 1e18 (e^-42 < 1e-18), so the floor applies.
    uint256 private constant MAX_EXPONENT = 42e18;

    error TauZero();

    /// @notice Funding rate as a WAD fraction of the mark: (V - payoff) / V clamped to [0, 1e18]; V == 0 gives 1e18.
    function rate(uint256 vWad, uint256 payoffWad) internal pure returns (uint256) {
        if (vWad == 0) return WAD;
        if (payoffWad >= vWad) return 0;
        // (V - payoff) / V, rounded up so that a tiny time value never rounds to a free step.
        return Math.mulDiv(vWad - payoffWad, WAD, vWad, Math.Rounding.Ceil);
    }

    /// @notice Applies funding over `dt` seconds.
    /// @param norm current normalization factor (WAD)
    /// @param vWad option value per unit at the start of the step (WAD USDG per whole Stock Token)
    /// @param payoffWad intrinsic value per unit at the start of the step (WAD)
    /// @param dt elapsed seconds
    /// @param tauSeconds the series funding period (86400 Daily, 604800 Weekly)
    /// @return newNorm the shrunk factor, <= norm and >= min(norm, MIN_NORM)
    function step(uint256 norm, uint256 vWad, uint256 payoffWad, uint256 dt, uint256 tauSeconds)
        internal
        pure
        returns (uint256 newNorm)
    {
        if (tauSeconds == 0) revert TauZero();
        if (norm <= MIN_NORM || dt == 0) return norm;
        uint256 r = rate(vWad, payoffWad);
        if (r == 0) return norm;
        // x = r * dt / tau in WAD. r <= 1e18 and dt < 2^128 keep r * dt far inside 256 bits.
        uint256 x = Math.mulDiv(r, dt, tauSeconds);
        if (x >= MAX_EXPONENT) return MIN_NORM;
        uint256 factor = FixedMath.expWad(-int256(x));
        if (factor >= WAD) return norm; // exp of a tiny negative number may round to 1
        newNorm = Math.mulDiv(norm, factor, WAD);
        if (newNorm < MIN_NORM) newNorm = MIN_NORM;
    }
}
