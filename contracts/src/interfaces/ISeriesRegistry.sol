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

    /// @dev id = keccak256(abi.encode(stock, isCall, strike, tauSeconds)). Deploys an OptionToken clone (EIP-1167).
    function listSeries(address stock, bool isCall, uint128 strike, uint32 tauSeconds) external returns (bytes32 id);
    function setBuyable(bytes32 id, bool buyable) external;
    function archive(bytes32 id) external;
    /// @dev Only the engine. Persists the new norm and accrual timestamp.
    function storeAccrual(bytes32 id, uint128 norm, uint64 lastAccrual) external;

    function seriesOf(bytes32 id) external view returns (Series memory);
    function idOf(address stock, bool isCall, uint128 strike, uint32 tauSeconds) external pure returns (bytes32);
    function seriesCount() external view returns (uint256);
    function seriesIdAt(uint256 index) external view returns (bytes32);
    function allowedStock(address stock) external view returns (bool);
}
