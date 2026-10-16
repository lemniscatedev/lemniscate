// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IAggregatorV3} from "../../src/interfaces/IAggregatorV3.sol";

contract MockFeed is IAggregatorV3 {
    uint8 public override decimals;
    uint80 public roundId;
    int256 public answer;
    uint256 public updatedAt;

    constructor(uint8 decimals_, int256 answer_) {
        decimals = decimals_;
        answer = answer_;
        updatedAt = block.timestamp;
        roundId = 1;
    }

    function aggregator() external view override returns (address) {
        return address(this);
    }

    function setAnswer(int256 answer_) external {
        answer = answer_;
        updatedAt = block.timestamp;
        ++roundId;
        emit AnswerUpdated(answer_, roundId, updatedAt);
    }

    function setUpdatedAt(uint256 updatedAt_) external {
        updatedAt = updatedAt_;
    }

    function setDecimals(uint8 decimals_) external {
        decimals = decimals_;
    }

    function latestRoundData()
        external
        view
        override
        returns (uint80, int256, uint256 startedAt, uint256 updatedAt_, uint80 answeredInRound)
    {
        return (roundId, answer, updatedAt, updatedAt, roundId);
    }
}
