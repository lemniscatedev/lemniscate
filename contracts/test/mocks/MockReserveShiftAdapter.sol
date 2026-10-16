// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IHedgeAdapter} from "../../src/interfaces/IHedgeAdapter.sol";
import {Regime} from "../../src/libs/LemniscateTypes.sol";
import {MockUSDG} from "./MockUSDG.sol";
import {MockVaultEngine} from "./MockVaultEngine.sol";

/// @dev Adversarial swap double that changes the engine reserve while a withdrawal raises cash.
contract MockReserveShiftAdapter is IHedgeAdapter {
    using SafeERC20 for IERC20;

    MockVaultEngine private immutable _engine;

    constructor(MockVaultEngine engine_) {
        _engine = engine_;
    }

    function swapExactIn(address tokenIn, address tokenOut, uint24, uint256 amountIn, uint256 minOut, address recipient)
        external
        override
        returns (uint256 out)
    {
        IERC20(tokenIn).safeTransferFrom(msg.sender, address(this), amountIn);
        _engine.setMarket(0, Regime.OPEN, 1e18, true, 1e18, 100e18, 0);
        out = minOut;
        MockUSDG(tokenOut).mint(recipient, out);
    }
}
