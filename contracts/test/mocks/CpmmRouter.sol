// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ISwapRouter02} from "../../src/interfaces/ISwapRouter02.sol";

/// @dev Constant-product pool behind a SwapRouter02-shaped interface (local model of a v3 pool's active range).
/// Reserves are virtual; the router is pre-funded so `setReserves` can model arbitrage back to a reference price.
contract CpmmRouter is ISwapRouter02 {
    address public immutable tokenA; // USDG
    address public immutable tokenB; // stock
    uint256 public rA;
    uint256 public rB;
    uint256 public constant FEE_PIPS = 500; // 0.05%

    constructor(address a, address b) {
        tokenA = a;
        tokenB = b;
    }

    function setReserves(uint256 a, uint256 b) external {
        rA = a;
        rB = b;
    }

    function _reserves(address tIn) private view returns (uint256 rin, uint256 rout) {
        return tIn == tokenA ? (rA, rB) : (rB, rA);
    }

    function _set(address tIn, uint256 rin, uint256 rout) private {
        if (tIn == tokenA) (rA, rB) = (rin, rout);
        else (rB, rA) = (rin, rout);
    }

    function getAmountOut(address tIn, uint256 amountIn) public view returns (uint256) {
        (uint256 rin, uint256 rout) = _reserves(tIn);
        uint256 inFee = amountIn * (1e6 - FEE_PIPS) / 1e6;
        return rout * inFee / (rin + inFee);
    }

    function getAmountIn(address tIn, uint256 amountOut) public view returns (uint256) {
        (uint256 rin, uint256 rout) = _reserves(tIn);
        uint256 inFee = rin * amountOut / (rout - amountOut) + 1;
        return inFee * 1e6 / (1e6 - FEE_PIPS) + 1;
    }

    function swap(address tIn, address tOut, uint256 amountIn, uint256 minOut, address to) public returns (uint256 out) {
        out = getAmountOut(tIn, amountIn);
        require(out >= minOut, "minOut");
        IERC20(tIn).transferFrom(msg.sender, address(this), amountIn);
        (uint256 rin, uint256 rout) = _reserves(tIn);
        _set(tIn, rin + amountIn, rout - out);
        IERC20(tOut).transfer(to, out);
    }

    function swapExactOut(address tIn, address tOut, uint256 amountOut, address to) external returns (uint256 amountIn) {
        amountIn = getAmountIn(tIn, amountOut);
        IERC20(tIn).transferFrom(msg.sender, address(this), amountIn);
        (uint256 rin, uint256 rout) = _reserves(tIn);
        _set(tIn, rin + amountIn, rout - amountOut);
        IERC20(tOut).transfer(to, amountOut);
    }

    function exactInputSingle(ExactInputSingleParams calldata p) external payable override returns (uint256) {
        return swap(p.tokenIn, p.tokenOut, p.amountIn, p.amountOutMinimum, p.recipient);
    }
}
