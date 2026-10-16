// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IHedgeAdapter} from "./interfaces/IHedgeAdapter.sol";
import {ISwapRouter02} from "./interfaces/ISwapRouter02.sol";

/// @title UniswapV3HedgeAdapter
/// @notice Stateless exact-input adapter for the Uniswap v3 SwapRouter02.
contract UniswapV3HedgeAdapter is IHedgeAdapter {
    using SafeERC20 for IERC20;

    error InvalidRouter();
    error InvalidSwap();

    ISwapRouter02 private immutable ROUTER;

    constructor(ISwapRouter02 router_) {
        if (address(router_) == address(0) || address(router_).code.length == 0) revert InvalidRouter();
        ROUTER = router_;
    }

    /// @notice Swaps caller-funded tokens through one Uniswap v3 pool and sends output to `recipient`.
    function swapExactIn(
        address tokenIn,
        address tokenOut,
        uint24 fee,
        uint256 amountIn,
        uint256 minOut,
        address recipient
    ) external override returns (uint256 out) {
        if (
            tokenIn == address(0) || tokenOut == address(0) || tokenIn == tokenOut || recipient == address(0)
                || fee == 0 || amountIn == 0
        ) revert InvalidSwap();

        IERC20 input = IERC20(tokenIn);
        input.safeTransferFrom(msg.sender, address(this), amountIn);
        input.forceApprove(address(ROUTER), amountIn);
        out = ROUTER.exactInputSingle(
            ISwapRouter02.ExactInputSingleParams({
                tokenIn: tokenIn,
                tokenOut: tokenOut,
                fee: fee,
                recipient: recipient,
                amountIn: amountIn,
                amountOutMinimum: minOut,
                sqrtPriceLimitX96: 0
            })
        );
        input.forceApprove(address(ROUTER), 0);
    }
}
