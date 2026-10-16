// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @dev First-loss reserve of the Writer Pool (spec 2.6). Funded with a share of spread income until it holds a
/// target share of pool NAV. Its USDG only ever leaves to the pool, to absorb pool losses before LP NAV does.
interface IReserve {
    event Covered(uint256 requested, uint256 sent);
    event ParamsSet(uint16 incomeShareBps, uint16 targetBps);

    error NotPool();
    error InvalidParams();

    /// @dev Pool only. Sends min(amount, balance) USDG to the pool and returns what was sent.
    function cover(uint256 amountUsdg) external returns (uint256 sent);
    function balance() external view returns (uint256 usdg);
    /// @dev Share of spread income routed here (default 1500 = 15%).
    function incomeShareBps() external view returns (uint16);
    /// @dev Funding stops once the balance reaches this share of pool NAV (default 500 = 5%).
    function targetBps() external view returns (uint16);
    function pool() external view returns (address);
}
