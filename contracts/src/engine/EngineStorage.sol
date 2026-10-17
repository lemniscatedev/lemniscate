// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPool} from "../interfaces/IPool.sol";
import {IPriceGuard} from "../interfaces/IPriceGuard.sol";
import {ISeriesRegistry} from "../interfaces/ISeriesRegistry.sol";
import {IVolOracle} from "../interfaces/IVolOracle.sol";
import {EngineHelper} from "../EngineHelper.sol";

/// @title EngineStorage
/// @notice The LemniscateEngine state in one ERC-7201 namespace ("lemniscate.storage.Engine"), shared by the engine
/// proxy's implementation and the external libraries it delegatecalls (EngineTradeLib, EngineOpsLib).
library EngineStorage {
    /// @dev Engine copy of a series (three slots). The engine is the only writer of norm and lastAccrual; the
    /// registry copy is kept equal through `storeAccrual`.
    struct SeriesInfo {
        address stock;
        uint32 tau;
        bool isCall;
        bool known;
        address token;
        uint64 lastAccrual;
        /// @dev 1-based position in `live[stock]` (0 = no tokens outstanding), packed with lastAccrual (todo 07b R2).
        uint32 liveIdx;
        uint128 strike;
        uint128 norm;
    }

    /// @dev One series' contribution to its name's book at its last touch (four slots): units x the per-unit value,
    /// delta, gamma, vega and the value changes in the four stress scenarios.
    struct SeriesRisk {
        uint128 value;
        int128 delta;
        uint128 gamma;
        uint128 vega;
        int128 sc0;
        int128 sc1;
        int128 sc2;
        int128 sc3;
    }

    /// @dev Per-name sums of its series' contributions, long side (the pool is short all of it), and the S they were
    /// last refreshed at.
    struct NameBook {
        uint256 value;
        int256 delta;
        uint256 gamma;
        uint256 vega;
        int256[4] sc;
        uint256 lastS;
        bool known;
    }

    /// @dev A queued sell: `tokens` escrowed in the engine until filled or cancelled.
    struct Ticket {
        address seller;
        uint64 queuedAt;
        bool open;
        address recipient;
        bytes32 id;
        uint128 tokens;
    }

    /// @custom:storage-location erc7201:lemniscate.storage.Engine
    struct Layout {
        IERC20 usdg;
        IPool pool;
        ISeriesRegistry registry;
        IPriceGuard priceGuard;
        IVolOracle volOracle;
        EngineHelper.Params p;
        bool globalBuysPaused;
        bool stressPaused;
        bool drawdownPaused;
        bool upgradesFrozen;
        /// @dev Sum of every series' last-touch value (WAD USDG): the liability the caps and the stress budget use.
        uint256 bookValue;
        uint256 ticketCount;
        uint256 syncedCount;
        uint256 fundingDustWad;
        uint256 fundingBacklogUsdg;
        mapping(bytes32 id => SeriesInfo) info;
        mapping(bytes32 id => SeriesRisk) risk;
        mapping(bytes32 id => bool) seriesBuysPaused;
        mapping(address stock => NameBook) book;
        mapping(address stock => bytes32[]) byStock;
        mapping(address stock => bytes32[]) weeklyPuts;
        mapping(address stock => uint256) hedgeDepthCapWad;
        mapping(uint256 ticket => Ticket) tickets;
        /// @dev Daily NAV/share peaks: (day << 224) | navPerShare, ring of 31 slots.
        mapping(uint256 slot => uint256) navPeaks;
        address[] stocks;
        /// @dev Series with a non-zero token supply, per stock (todo 07b R2): the only series any loop visits.
        mapping(address stock => bytes32[]) live;
        /// @dev $LMNS staking read for fee tiers (todo 20 R4); zero = no discounts. Appended (namespaced layout).
        address feeTiers;
    }

    /// @dev keccak256(abi.encode(uint256(keccak256("lemniscate.storage.Engine")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 internal constant SLOT = 0xb5f0e3dfa5c5f6c3b52e8dd8b159b6dbf0474bd4b0fadb6ac62bee348f97c000; // not-a-key

    function layout() internal pure returns (Layout storage $) {
        assembly ("memory-safe") {
            $.slot := SLOT
        }
    }
}
