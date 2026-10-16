// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {FixedMath} from "../../src/libs/FixedMath.sol";
import {EverlastingMath} from "../../src/libs/EverlastingMath.sol";

/// @notice External wrappers so tests can expect reverts from the internal libraries and measure their gas.
contract EverlastingMathHarness {
    function expWad(int256 x) external pure returns (uint256) {
        return FixedMath.expWad(x);
    }

    function lnWad(uint256 x) external pure returns (int256) {
        return FixedMath.lnWad(x);
    }

    function ln36(uint256 x) external pure returns (int256) {
        return FixedMath.ln36(x);
    }

    function powWad(uint256 x, int256 e) external pure returns (uint256) {
        return FixedMath.powWad(x, e);
    }

    function sqrtWad(uint256 x) external pure returns (uint256) {
        return FixedMath.sqrtWad(x);
    }

    function uWad(uint64 sigmaBps, uint32 tauSeconds) external pure returns (uint256) {
        return EverlastingMath.uWad(sigmaBps, tauSeconds);
    }

    function callValue(uint256 s, uint256 k, uint64 sigmaBps, uint32 tauSeconds) external pure returns (uint256) {
        return EverlastingMath.callValue(s, k, sigmaBps, tauSeconds);
    }

    function putValue(uint256 s, uint256 k, uint64 sigmaBps, uint32 tauSeconds) external pure returns (uint256) {
        return EverlastingMath.putValue(s, k, sigmaBps, tauSeconds);
    }

    function timeValueU(uint256 s, uint256 k, uint256 u) external pure returns (uint256) {
        return EverlastingMath.timeValueU(s, k, u);
    }
}
