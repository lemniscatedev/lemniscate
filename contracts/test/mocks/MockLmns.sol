// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";

/// @dev Stand-in for the launchpad-issued $LMNS (18 decimals, EIP-2612). The protocol never deploys a token: this
/// exists only in tests (todo 20 R1).
contract MockLmns is ERC20, ERC20Permit {
    constructor() ERC20("Mock LMNS", "mLMNS") ERC20Permit("Mock LMNS") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @dev Fee-tier contract that misbehaves, to prove the engine's read never reverts.
contract BadFeeTiers {
    uint256 public mode; // 0 revert, 1 burn all gas, 2 short return, 3 huge values

    function setMode(uint256 m) external {
        mode = m;
    }

    fallback(bytes calldata) external returns (bytes memory) {
        uint256 m = mode;
        if (m == 0) revert("tiers down");
        if (m == 1) {
            uint256 i;
            while (true) {
                ++i;
            }
        }
        if (m == 2) return abi.encode(uint256(1));
        return abi.encode(type(uint256).max, type(uint256).max);
    }
}
