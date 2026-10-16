// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

interface IStockToken is IERC20Metadata {
    event UIMultiplierUpdated(uint256 oldMultiplier, uint256 newMultiplier, uint256 effectiveAt);

    function oraclePaused() external view returns (bool);

    function paused() external view returns (bool);

    function uiMultiplier() external view returns (uint256);

    function newUIMultiplier() external view returns (uint256);

    function effectiveAt() external view returns (uint256);
}
