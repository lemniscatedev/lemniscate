// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {OptionToken} from "./OptionToken.sol";

/// @notice Deploys per-market tokens without embedding their creation bytecode in LemniscateEngine.
contract OptionTokenFactory {
    function deployToken(string calldata name, string calldata symbol, address engine) external returns (OptionToken) {
        return new OptionToken(name, symbol, engine);
    }
}
