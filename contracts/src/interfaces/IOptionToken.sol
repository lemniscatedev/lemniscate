// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

/// @dev ERC-20 clone per series, e.g. symbol "eNVDA-C-110-W". Only the engine mints and burns. Every balance change
/// (mint, burn, transfer) first calls engine.accrue(seriesId) so the norm is current.
interface IOptionToken is IERC20Metadata {
    function initialize(address engine, bytes32 seriesId, string calldata name_, string calldata symbol_) external;
    function seriesId() external view returns (bytes32);
    function engine() external view returns (address);
    function mint(address to, uint256 amount) external;
    function burn(address from, uint256 amount) external;
}
