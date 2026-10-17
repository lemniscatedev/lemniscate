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
        /// @dev Funding rate (V - payoff) / V at the last accrual, in 1e-12 units (WAD / 1e6, rounded up): the start of
        /// the next gap, which is charged at max(start, end) (review F11/F34). Packed into the first slot.
        uint48 rateMicro;
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
        /// @dev The seller's minProceeds, enforced when anyone fills the ticket (review F21).
        uint128 minProceeds;
    }

    /// @dev Deploy-time trade guards (review fixes, todo 27). Zero fields read as the defaults in EngineCore.
    struct Guards {
        uint64 minTradeUsdg; // smallest buy cost / sell value and smallest position left behind (6 dp)
        uint32 holdSeconds; // a sell this soon after the account's buy is priced at the worse of now and the buy S
        uint32 haltSettleDelay; // a stock HALTED this long (PriceGuard.haltedSince) can be settled at its last price
    }

    /// @dev The worse-for-the-seller S of an account's recent buys of a series and when the hold ends (review F01).
    struct Hold {
        uint64 until;
        uint128 s;
    }

    /// @dev One series' contribution to its name's NAV mark (review F12/F15): the S and base sigma it was valued at and
    /// its units then.
    struct SeriesMark {
        uint104 s; // the pricing domain tops out at 1e30 < 2^104
        uint128 units;
        uint24 sigma; // bps, at most 30,000
    }

    /// @dev Per-name sums that bound the liability at today's S from the last-touch book in O(1) per name: delta and
    /// delta x mark S (tangent, a lower bound by convexity), units of calls and puts (|delta| <= 1, an upper bound),
    /// the envelope [lo, hi] of the mark prices, and per speed vega and vega x mark sigma (first-order vol term).
    struct NameMark {
        int256 d;
        int256 ds;
        uint256 uCall;
        uint256 uPut;
        uint128 lo;
        uint128 hi;
        uint256[2] vg;
        uint256[2] vb;
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
        // ---- review fixes (todo 27), appended
        Guards guards;
        mapping(bytes32 id => mapping(address account => Hold)) holds;
        /// @dev ORC-4 settlement price of a stock whose feed stayed HALTED past the settle delay (0 = none).
        mapping(address stock => uint256) settleS;
        mapping(address stock => NameMark) marks;
        mapping(bytes32 id => SeriesMark) seriesMarks;
    }

    /// @dev keccak256(abi.encode(uint256(keccak256("lemniscate.storage.Engine")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 internal constant SLOT = 0xb5f0e3dfa5c5f6c3b52e8dd8b159b6dbf0474bd4b0fadb6ac62bee348f97c000; // not-a-key

    function layout() internal pure returns (Layout storage $) {
        assembly ("memory-safe") {
            $.slot := SLOT
        }
    }
}
