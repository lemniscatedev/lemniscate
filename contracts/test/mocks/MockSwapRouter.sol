// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ISwapRouter02} from "../../src/interfaces/ISwapRouter02.sol";

contract MockSwapRouter is ISwapRouter02 {
    using SafeERC20 for IERC20;

    error InvalidRate();
    error InsufficientOutput();

    uint256 public constant WAD = 1e18;
    mapping(bytes32 => uint256) public rateWad;

    event SwapExecuted(address indexed tokenIn, address indexed tokenOut, uint256 amountIn, uint256 amountOut);

    function setRate(address tokenIn, address tokenOut, uint24 fee, uint256 rate) external {
        if (rate == 0) revert InvalidRate();
        rateWad[_key(tokenIn, tokenOut, fee)] = rate;
    }

    function exactInputSingle(ExactInputSingleParams calldata params)
        external
        payable
        override
        returns (uint256 amountOut)
    {
        uint256 rate = rateWad[_key(params.tokenIn, params.tokenOut, params.fee)];
        if (rate == 0) rate = WAD;
        amountOut = params.amountIn * rate / WAD;
        if (amountOut < params.amountOutMinimum) revert InsufficientOutput();

        IERC20(params.tokenIn).safeTransferFrom(msg.sender, address(this), params.amountIn);
        IERC20(params.tokenOut).safeTransfer(params.recipient, amountOut);
        emit SwapExecuted(params.tokenIn, params.tokenOut, params.amountIn, amountOut);
    }

    function _key(address tokenIn, address tokenOut, uint24 fee) private pure returns (bytes32) {
        return keccak256(abi.encode(tokenIn, tokenOut, fee));
    }
}
