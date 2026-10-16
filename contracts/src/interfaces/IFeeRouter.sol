// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @dev Protocol fee router (spec 2.8). Receives the protocol share of pool spread and funding income in USDG and
/// distributes it at most once per 7 days: workers / treasury / stakers / burn = 80 / 10 / 5 / 5. The workers part
/// is split again between the pool (back to writers through NAV), the keepers pot and the hedger pot. A bucket whose
/// recipient is not set yet (stakers and burn until phase 2) is held in the router and paid once it is set.
interface IFeeRouter {
    event Distributed(uint256 amount, uint256 toPool, uint256 toKeepers, uint256 toHedger, uint256 toTreasury, uint256 toStakers, uint256 toBurn);
    event Held(bytes32 indexed bucket, uint256 amount);
    event RecipientSet(bytes32 indexed bucket, address recipient);
    event SplitSet(uint16 workersBps, uint16 treasuryBps, uint16 stakersBps, uint16 burnBps);
    event WorkerSplitSet(uint16 poolBps, uint16 keepersBps, uint16 hedgerBps);
    event ProtocolFeeSet(uint16 bps);

    error TooEarly(uint256 nextAt);
    error InvalidParams();

    /// @dev Share of pool spread and funding income charged as protocol fee (default 1000 = 10%).
    function protocolFeeBps() external view returns (uint16);
    /// @dev Anyone, once 7 days have passed since the last distribution. Rounding dust stays in the router.
    function distribute() external returns (uint256 amount);
    /// @dev USDG that the next distribute() would split (balance minus held buckets).
    function distributable() external view returns (uint256);
    function nextDistributionAt() external view returns (uint256);
    function heldStakers() external view returns (uint256);
    function heldBurn() external view returns (uint256);
}
