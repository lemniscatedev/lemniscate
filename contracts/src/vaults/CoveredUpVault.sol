// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {WriterVault} from "./WriterVault.sol";

/// @title CoveredUpVault
/// @notice Writer vault for short calls (spec 2.7, phase 2): holds Stock Tokens, one raw unit per call unit it covers
/// (Stock Tokens have 18 decimals, like option units). Receives its slices' funding and spread in USDG; on a loss event
/// pays the slice's intrinsic value to the pool in Stock Tokens at the PriceGuard price, which is always less than one
/// raw unit per unit, so it can never lose more than its collateral and is never liquidated. Closed by default.
contract CoveredUpVault is WriterVault {
    /// @param p `p.asset` must be `p.stock`; the moneyness band lies at or above 10000 bps (out-of-the-money calls).
    constructor(Params memory p) WriterVault(p, true, 18) {
        if (address(p.asset) != p.stock) revert InvalidParams();
    }
}
