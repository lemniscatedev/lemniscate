// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

interface IAggregatorV3 {
    event AnswerUpdated(int256 indexed current, uint256 indexed roundId, uint256 updatedAt);

    function aggregator() external view returns (address);

    function decimals() external view returns (uint8);

    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
}
