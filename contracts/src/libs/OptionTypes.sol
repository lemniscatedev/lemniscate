// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Market session as seen by PriceGuard. HALTED = in-session but the feed is stale or the issuer oracle is paused.
enum SessionKind {
    REGULAR,
    EXTENDED,
    CLOSED,
    UNKNOWN,
    HALTED
}

/// @notice Decay speed. DAILY tau = 1 day, WEEKLY tau = 7 days (calendar time).
enum Speed {
    DAILY,
    WEEKLY
}

/// @dev Units used everywhere (see docs/plans/01-contract-interfaces.md, section "Units"):
/// - USDG amounts: 6 decimals.
/// - S (underlying), K (strike), V (option value), prices: WAD (1e18) USDG per ONE WHOLE Stock Token (1e18 raw units),
///   multiplier applied exactly once.
/// - Option "units": WAD. 1e18 units = one option on one whole Stock Token.
/// - OptionToken has 18 decimals. Holder units = balance * norm / 1e18. norm starts at 1e18 and only decreases.
/// - sigma: basis points of annualised volatility (5000 = 50%). tau: seconds.
struct Series {
    address stock;
    bool isCall;
    Speed speed;
    uint32 tauSeconds;
    uint128 strike;
    address token;
    uint128 norm;
    uint64 lastAccrual;
    uint64 listedAt;
    bool buyable;
    bool archived;
}

struct PriceReading {
    uint256 s; // WAD USDG per whole Stock Token
    SessionKind session;
    bool fresh; // feed within its max age for the session, issuer oracle not paused
    bool buysPaused; // PriceGuard pause (pending split-class multiplier change, continuity failure, feed pause)
    uint256 updatedAt;
}

struct VolReading {
    uint64 sigmaBps; // includes skew, earnings and weekend bumps as posted
    uint64 skewK;
    uint64 eventBumpBps;
    uint64 buyBlockFrom; // earnings block window, unix seconds (0 = none)
    uint64 buyBlockTo;
    uint64 validUntil;
    bool stale; // block.timestamp > validUntil
}
