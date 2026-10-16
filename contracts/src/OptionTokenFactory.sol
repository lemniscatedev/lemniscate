// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {OptionToken} from "./OptionToken.sol";

/// @title OptionTokenFactory
/// @notice Deploys one EIP-1167 clone of OptionToken per series at a deterministic address (salt = series id).
/// @dev Only its owner (the SeriesRegistry that created it) may deploy, so nobody can squat a series' address first.
contract OptionTokenFactory {
    error NotOwner();

    address public immutable implementation;
    address public immutable owner;

    constructor() {
        implementation = address(new OptionToken());
        owner = msg.sender;
    }

    /// @notice Deploys and initializes the clone of `seriesId` in one call.
    function deploy(bytes32 seriesId, address engine, string calldata name, string calldata symbol)
        external
        returns (address token)
    {
        if (msg.sender != owner) revert NotOwner();
        token = Clones.cloneDeterministic(implementation, seriesId);
        OptionToken(token).initialize(engine, seriesId, name, symbol);
    }

    /// @notice The address the clone of `seriesId` has (or will have).
    function predict(bytes32 seriesId) external view returns (address) {
        return Clones.predictDeterministicAddress(implementation, seriesId);
    }
}
