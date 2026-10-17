// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {WriterVault} from "./WriterVault.sol";

/// @title CashDownVault
/// @notice Writer vault for short puts (spec 2.7, phase 2): holds USDG, strike x units for the puts it covers. Funding
/// and spread received in USDG join its collateral; on a loss event it pays the slice's intrinsic value (strike - S) x
/// units to the pool in USDG, never more than strike x units, so it can never lose more than its collateral and is
/// never liquidated. Closed by default.
contract CashDownVault is WriterVault {
    /// @param p `p.asset` must be `p.usdg` (6 decimals); the moneyness band lies at or below 10000 bps.
    constructor(Params memory p) WriterVault(p, false, 6) {
        if (p.asset != p.usdg) revert InvalidParams();
    }
}
