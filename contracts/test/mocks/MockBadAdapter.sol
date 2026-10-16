// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IHedgeAdapter} from "../../src/interfaces/IHedgeAdapter.sol";

interface IMintable {
    function mint(address to, uint256 amount) external;
}

/// @dev Hedge adapter that misreports or misexecutes swaps, to exercise the vault's balance-delta checks.
contract MockBadAdapter is IHedgeAdapter {
    enum Mode {
        Honest, // pulls amountIn, delivers minOut
        UnderPull, // pulls one wei less than amountIn
        ShortDelivery, // reports minOut but delivers one wei less
        Reverts
    }

    Mode public mode;

    function setMode(Mode mode_) external {
        mode = mode_;
    }

    function swapExactIn(address tokenIn, address tokenOut, uint24, uint256 amountIn, uint256 minOut, address recipient)
        external
        override
        returns (uint256)
    {
        require(mode != Mode.Reverts, "adapter down");
        uint256 pull = mode == Mode.UnderPull ? amountIn - 1 : amountIn;
        IERC20(tokenIn).transferFrom(msg.sender, address(this), pull);
        uint256 deliver = mode == Mode.ShortDelivery ? minOut - 1 : minOut;
        IMintable(tokenOut).mint(recipient, deliver);
        return minOut;
    }
}
