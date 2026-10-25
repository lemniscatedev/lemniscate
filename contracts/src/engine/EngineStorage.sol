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
        /// Review R07: RETIRED (type(uint32).max) = off the live list as dust but with tokens outstanding.
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
    /// Review R02: the hold is bound to the tokens those buys minted (`tokens`, appended): only that many tokens are
    /// priced at `s`, held tokens cannot be transferred while the hold is open, and nobody else can write it.
    struct Hold {
        uint64 until;
        uint128 s;
        uint128 tokens;
    }

    /// @dev One series' contribution to its name's NAV mark (review F12/F15): the S and base sigma it was valued at and
    /// its units then.
    struct SeriesMark {
        uint104 s; // the pricing domain tops out at 1e30 < 2^104
        uint128 units;
        /// @dev Bits 0-22: base sigma in bps (at most 30,000). Bit 23 (review R09/R07): the mark's tier, set when the
        /// series' value at the mark was under the minimum trade (dust, retired series included). The mark's time is
        /// the series' lastAccrual (every mark is made right after an accrual in the same block).
        uint24 sigma;
    }

    /// @dev Review R09/R07: one tier of a name's NAV-mark envelope. A pass ends when every series with units in the tier
    /// has been marked since it began, in any number of transactions; the envelope then becomes the marks of that pass
    /// and `tc` its start, so the bounds tighten after every keeper pass whatever its batching (and at once when the
    /// whole tier is marked in one block). Dust series (tier 1, retired ones included) never collapse with the live
    /// tier: their marks stay in their own envelope until a dust pass re-marks them.
    struct MarkTier {
        uint128 lo; // envelope of the tier's current marks (0 = empty)
        uint128 hi;
        uint128 passLo; // envelope of the marks made in the open pass (after passStart)
        uint128 passHi;
        uint128 nowLo; // envelope of the marks made at nowTs
        uint128 nowHi;
        uint256 uCall;
        uint256 uPut;
        uint256[2] val; // per speed, book value at the marks (WAD USDG)
        uint40 tc; // start of the last completed pass: every current mark is at or after it
        uint40 passStart; // a series marked at or before it is still due in the open pass
        uint40 nowTs;
        uint32 pending; // series with units in the tier marked at or before passStart
        uint32 count; // series with units in the tier
        uint32 nowCount; // series with units in the tier marked at nowTs
    }

    /// @dev Per-name sums that bound the liability at today's S from the last-touch book in O(1) per name: delta and
    /// delta x mark S (tangent, a lower bound by convexity), units of calls and puts (|delta| <= 1, an upper bound),
    /// the envelope [lo, hi] of the mark prices, per speed vega and vega x mark sigma (first-order vol term), and per
    /// speed book value plus the time of the last full re-mark (funding accrued since the marks, follow-up B2).
    /// Review R09/R07: lo, hi, uCall, uPut, val and tc are no longer written (see MarkTier); the tangent and vol sums are.
    struct NameMark {
        int256 d;
        int256 ds;
        uint256 uCall;
        uint256 uPut;
        uint128 lo;
        uint128 hi;
        uint256[2] vg;
        uint256[2] vb;
        uint256[2] val; // B2: per speed, the book value of the name's series at their marks (WAD USDG)
        uint64 tc; // B2: the last time every live series of the name was marked (all marks are at or after it)
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
        // ---- round-2 review fixes (todo 28), appended
        /// @dev The AgentRouter (review R04): the only caller of `sellFor`, and the only account that may buy for
        /// another recipient (R02). Zero = none.
        address agentRouter;
        /// @dev The seller's hold carried by a queued sell (review R02): the held part of the ticket's tokens and its S.
        mapping(uint256 ticket => Hold) ticketHolds;
        /// @dev Review R09/R07: per name, the live tier (0) and the dust tier (1) of the NAV-mark envelope. Replaces
        /// NameMark's lo/hi/uCall/uPut/val/tc (kept in place, no longer written); NameMark keeps the tangent and vol sums.
        mapping(address stock => MarkTier[2]) tiers;
        /// @dev Review R07: every series ever retired as dust, per stock (entries are never removed; readers skip those
        /// back on the live list or without supply), so monitoring still counts retired units.
        mapping(address stock => bytes32[]) retired;
        mapping(bytes32 id => bool) everRetired;
    }

    /// @dev keccak256(abi.encode(uint256(keccak256("lemniscate.storage.Engine")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 internal constant SLOT = 0xb5f0e3dfa5c5f6c3b52e8dd8b159b6dbf0474bd4b0fadb6ac62bee348f97c000; // not-a-key

    function layout() internal pure returns (Layout storage $) {
        assembly ("memory-safe") {
            $.slot := SLOT
        }
    }
}
