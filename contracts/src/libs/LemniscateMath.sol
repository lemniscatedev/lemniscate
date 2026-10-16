// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

library LemniscateMath {
    uint256 internal constant WAD = 1e18;
    uint256 internal constant BPS = 10_000;
    uint256 internal constant FEED_TO_WAD = 1e10;
    uint256 internal constant USDG_TO_WAD = 1e12;

    error DivisionByZero();
    error InvalidFeedAnswer();

    function mulWad(uint256 x, uint256 y) internal pure returns (uint256) {
        return x * y / WAD;
    }

    function divWad(uint256 x, uint256 y) internal pure returns (uint256) {
        if (y == 0) revert DivisionByZero();
        return x * WAD / y;
    }

    function bps(uint256 amount, uint256 rateBps) internal pure returns (uint256) {
        return amount * rateBps / BPS;
    }

    function bpsUp(uint256 amount, uint256 rateBps) internal pure returns (uint256) {
        if (amount == 0 || rateBps == 0) return 0;
        return (amount * rateBps + BPS - 1) / BPS;
    }

    /// @notice Converts a positive Chainlink answer with eight decimals to WAD.
    function feedToWad(int256 answer) internal pure returns (uint256) {
        if (answer <= 0) revert InvalidFeedAnswer();
        return uint256(answer) * FEED_TO_WAD;
    }

    /// @notice Converts USDG's six-decimal amount to WAD.
    function usdgToWad(uint256 amount) internal pure returns (uint256) {
        return amount * USDG_TO_WAD;
    }

    /// @notice Converts a WAD amount to USDG's six-decimal amount, rounding down.
    function wadToUsdg(uint256 amountWad) internal pure returns (uint256) {
        return amountWad / USDG_TO_WAD;
    }
}
