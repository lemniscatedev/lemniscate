// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice One market session [open, close) as pushed to MarketHours by the keeper (unix seconds).
struct Session {
    uint64 open;
    uint64 close;
}
