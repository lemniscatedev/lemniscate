// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Manipulation-resistant reference price for a stock token, used to floor the vault's forced hedge sales.
interface IPriceReference {
    /// @notice WAD USD per whole stock token (the engine's spot units), or zero when no reference is available.
    function referencePrice(address stock, uint24 fee) external view returns (uint256 priceWad);
}
