// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract MockVault {
    IERC20 public immutable usdg;
    address public engine;
    int256 public navWad;

    error OnlyEngine();

    constructor(IERC20 usdg_) {
        usdg = usdg_;
    }

    function setEngine(address engine_) external {
        engine = engine_;
    }

    function setNavWad(int256 navWad_) external {
        navWad = navWad_;
    }

    function navView() external view returns (int256) {
        return navWad;
    }

    function navFor(uint256, uint256[] memory) external view returns (int256) {
        return navWad;
    }

    function pay(address to, uint256 amount, uint8) external returns (uint256) {
        if (msg.sender != engine) revert OnlyEngine();
        require(usdg.transfer(to, amount));
        return amount;
    }
}
