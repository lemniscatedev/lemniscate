// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @dev Writer Pool (USDG, ERC-4626-style). The engine is the only counterparty that moves option risk in and out.
interface IPool {
    event HedgeEquityPosted(uint256 equityUsdg, uint64 asOf, bytes32 ref);
    event WithdrawalQueued(address indexed owner, uint256 indexed ticket, uint256 shares, uint64 claimableAt);
    event WithdrawalClaimed(address indexed owner, uint256 indexed ticket, uint256 usdg);

    /// @dev Engine only. Pool has already received `usdgIn`; records income and liability change.
    function onSale(bytes32 seriesId, uint256 usdgIn, uint256 spreadUsdg) external;
    /// @dev Engine only. Pays `usdgOut` to `to` (sell proceeds). Never reverts for lack of cash if NAV allows: the pool
    /// raises cash from hedge routes if needed (as the reference vault does).
    function pay(address to, uint256 usdgOut, uint256 spreadUsdg) external;

    /// @dev NAV in WAD USDG = usdg cash + hedgeEquity - sum(outstanding units * V_mark) + reserve share. liability comes
    /// from the engine (engine.totalLiability()).
    function nav() external view returns (int256 navWad);
    function navPerShare() external view returns (uint256);
    function navFor(uint256 liabilityWad) external view returns (int256 navWad);
    function postHedgeEquity(uint256 equityUsdg, uint64 asOf, bytes32 ref) external; // HEDGER role
    function hedgeEquity() external view returns (uint256 equityUsdg, uint64 asOf);

    // ERC-4626 style, mint at NAV + 10 bps, 72h withdrawal queue paid at NAV at claim time.
    function deposit(uint256 assets, address receiver) external returns (uint256 shares);
    function requestWithdraw(uint256 shares) external returns (uint256 ticket);
    function claim(uint256 ticket) external returns (uint256 usdg);
    function publicDeposits() external view returns (bool);
}
