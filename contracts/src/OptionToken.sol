// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";

/// @title OptionToken
/// @notice ERC-20 position token controlled only by its market's LemniscateEngine.
/// @dev No function can move a holder's balance except transfer by the holder/approved spender and engine burn during that holder's own sell.
contract OptionToken is ERC20, ERC20Permit {
    error NotEngine();
    error InvalidEngine();

    address public immutable engine;

    constructor(string memory name_, string memory symbol_, address engine_) ERC20(name_, symbol_) ERC20Permit(name_) {
        if (engine_ == address(0)) revert InvalidEngine();
        engine = engine_;
    }

    /// @notice Mints tokens to a trade recipient. Only the immutable engine may mint.
    function mint(address to, uint256 amount) external onlyEngine {
        _mint(to, amount);
    }

    /// @notice Burns the supplied balance. The engine calls this only for the seller's own sell.
    function burn(address from, uint256 amount) external onlyEngine {
        _burn(from, amount);
    }

    modifier onlyEngine() {
        if (msg.sender != engine) revert NotEngine();
        _;
    }
}
