// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface IHedgeAdapter {
    function swapExactIn(
        address tokenIn,
        address tokenOut,
        uint24 fee,
        uint256 amountIn,
        uint256 minOut,
        address recipient
    ) external returns (uint256 out);
}
