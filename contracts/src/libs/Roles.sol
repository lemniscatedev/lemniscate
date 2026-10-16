// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

library Roles {
    bytes32 internal constant KEEPER_ROLE = keccak256("KEEPER_ROLE");
    bytes32 internal constant GUARDIAN_ROLE = keccak256("GUARDIAN_ROLE");
}
