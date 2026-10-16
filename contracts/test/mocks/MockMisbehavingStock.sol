// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @dev Stock token whose `oraclePaused()` / `paused()` views can be made to revert (broken or upgraded beacon).
contract MockMisbehavingStock is ERC20 {
    bool public revertOraclePaused;
    bool public revertPaused;

    constructor() ERC20("Bad Stock", "BAD") {}

    function setReverts(bool oraclePaused_, bool paused_) external {
        revertOraclePaused = oraclePaused_;
        revertPaused = paused_;
    }

    function oraclePaused() external view returns (bool) {
        require(!revertOraclePaused, "oraclePaused down");
        return false;
    }

    function paused() external view returns (bool) {
        require(!revertPaused, "paused down");
        return false;
    }

    function uiMultiplier() external pure returns (uint256) {
        return 1e18;
    }

    function newUIMultiplier() external pure returns (uint256) {
        return 1e18;
    }

    function effectiveAt() external pure returns (uint256) {
        return 0;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
