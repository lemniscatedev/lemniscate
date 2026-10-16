// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Series, Speed} from "../libs/OptionTypes.sol";

interface ISeriesRegistry {
    event SeriesListed(bytes32 indexed id, address indexed stock, bool isCall, Speed speed, uint128 strike, address token);
    event SeriesBuyableSet(bytes32 indexed id, bool buyable);
    event SeriesArchived(bytes32 indexed id);

    error SeriesExists(bytes32 id);
    error SeriesUnknown(bytes32 id);
    error StockNotAllowed(address stock);
    error StrikeInvalid(uint128 strike);

    /// @dev Lists the CURRENT epoch of (stock, isCall, strike, tau) (decision 27, todo 07b): epoch 0 if none is listed,
    /// else the next epoch when the current one's norm is below `relistNormThreshold` or it is archived (the previous
    /// epoch is then archived: sell-only forever). id = keccak256(abi.encode(stock, isCall, strike, tauSeconds, epoch)).
    /// Deploys an OptionToken clone (EIP-1167).
    function listSeries(address stock, bool isCall, uint128 strike, uint32 tauSeconds) external returns (bytes32 id);
    function setBuyable(bytes32 id, bool buyable) external;
    function archive(bytes32 id) external;
    /// @dev Only the engine. Persists the new norm and accrual timestamp.
    function storeAccrual(bytes32 id, uint128 norm, uint64 lastAccrual) external;

    function seriesOf(bytes32 id) external view returns (Series memory);
    /// @dev The current epoch's id (the epoch-0 id before any listing). View since todo 07b (was pure): the id depends on
    /// the epoch counter; name, parameters and selector are unchanged.
    function idOf(address stock, bool isCall, uint128 strike, uint32 tauSeconds) external view returns (bytes32);
    function seriesCount() external view returns (uint256);
    function seriesIdAt(uint256 index) external view returns (bytes32);
    function allowedStock(address stock) external view returns (bool);

    // ---- added by todo 07b (series epochs, decision 27), additive only

    event EpochListed(bytes32 indexed id, bytes32 indexed previousId, uint32 epoch);
    event RelistNormThresholdSet(uint128 threshold);

    /// @dev The epoch the next `listSeries` / `idOf` refer to (0 before the first listing).
    function currentEpoch(address stock, bool isCall, uint128 strike, uint32 tauSeconds) external view returns (uint32);
    function idOfEpoch(address stock, bool isCall, uint128 strike, uint32 tauSeconds, uint32 epoch)
        external
        pure
        returns (bytes32);
    /// @dev Epoch of a listed series.
    function epochOf(bytes32 id) external view returns (uint32);
    /// @dev Norm (WAD) below which the keeper may list a new epoch of the same strike (default 1e15 = 0.001).
    function relistNormThreshold() external view returns (uint128);
}
