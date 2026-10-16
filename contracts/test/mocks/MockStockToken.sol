// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IStockToken} from "../../src/interfaces/IStockToken.sol";

contract MockStockToken is ERC20, IStockToken {
    event OraclePaused();
    event OracleUnpaused();
    bool public override oraclePaused;
    bool public override paused;
    uint256 public override uiMultiplier = 1e18;
    uint256 public override newUIMultiplier = 1e18;
    uint256 public override effectiveAt;

    constructor() ERC20("Mock Stock", "MOCK") {}

    function setOraclePaused(bool paused) external {
        oraclePaused = paused;
        if (paused) emit OraclePaused();
        else emit OracleUnpaused();
    }

    function setPaused(bool paused_) external {
        paused = paused_;
    }

    function setMultipliers(uint256 current, uint256 pending, uint256 effectiveAt_) external {
        uint256 previous = uiMultiplier;
        uiMultiplier = current;
        newUIMultiplier = pending;
        effectiveAt = effectiveAt_;
        emit UIMultiplierUpdated(previous, current, effectiveAt_);
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
