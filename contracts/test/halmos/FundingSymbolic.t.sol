// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {Funding} from "../../src/libs/Funding.sol";
import {FixedMath} from "../../src/libs/FixedMath.sol";

/// @title FundingSymbolic
/// @notice Halmos symbolic checks (functions named `check_*`, run with `halmos --contract FundingSymbolic`; forge test
/// ignores them). Each property holds for EVERY input, not a sample. Audit 2026-10-29 (formal checks on the maths).
/// @dev Proved: every early-exit branch of the funding step, and expWad's low saturation. Not provable here: anything
/// through OpenZeppelin's 512-bit mulDiv or the exp/ln series loops (the SMT solver times out at 600 s per query even
/// with inputs bounded to realistic ranges). Those properties stay covered by fuzz, vector and invariant tests
/// (Funding.t.sol, EverlastingMath.t.sol, the R1/R7/R9 references). See .audit-grade/halmos-2026-10-29.md.
contract FundingSymbolic is Test {
    uint256 internal constant WAD = 1e18;

    /// @notice Every early-exit branch of stepAtRate: zero dt, zero rate, norm at the floor, or an exponent past
    /// e^-42 leave the norm unchanged or set exactly the floor; never a larger norm.
    function check_stepAtRateEarlyExits(uint256 norm, uint256 r, uint256 dt, uint256 tau) public pure {
        vm.assume(tau != 0 && tau <= 4 weeks);
        vm.assume(dt < 2 ** 128);
        vm.assume(r > WAD ? true : r <= WAD);
        uint256 rc = r > WAD ? WAD : r;
        bool earlyNoChange = norm <= Funding.MIN_NORM || dt == 0 || rc == 0;
        bool floor = !earlyNoChange && Math.mulDiv(rc, dt, tau) >= 42e18;
        vm.assume(earlyNoChange || floor);
        uint256 n = Funding.stepAtRate(norm, r, dt, tau);
        if (earlyNoChange) assert(n == norm);
        else assert(n == Funding.MIN_NORM && n <= norm);
    }

    /// @notice expWad saturates to 0 below -42e18.
    function check_expWadSaturatesLow(int256 x) public pure {
        vm.assume(x < -42e18);
        assert(FixedMath.expWad(x) == 0);
    }
}
