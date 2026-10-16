// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {SessionKind, Speed} from "../libs/OptionTypes.sol";

interface IOptionEngine {
    event Bought(bytes32 indexed id, address indexed account, address recipient, uint256 units, uint256 tokens, uint256 usdgPaid, uint256 vMarkWad, uint64 sigmaBps, SessionKind session);
    event Sold(bytes32 indexed id, address indexed account, address recipient, uint256 units, uint256 tokens, uint256 usdgReceived, uint256 vMarkWad, uint64 sigmaBps, SessionKind session);
    event Accrued(bytes32 indexed id, uint128 norm, uint256 vMarkWad, uint256 payoffWad, SessionKind session);
    event ShieldBought(address indexed account, address indexed stock, bytes32 indexed id, uint256 tokenUnits, uint256 usdgPaid);
    event BuysPaused(bool global, bytes32 indexed id, bool paused);
    event AutoPaused(bytes32 indexed reason);

    error Expired();
    error Slippage(uint256 got, uint256 limit);
    error SeriesNotBuyable(bytes32 id);
    error SessionBlocksBuys(SessionKind session);
    error EarningsBlock(address stock);
    error StalePrice();
    error StaleVol();
    error CapExceeded(bytes32 kind);
    error StressBudget(uint256 lossBps);
    error BelowMinimum();

    /// @dev Pays `cost` USDG (6 dp) pulled from msg.sender (approve first), mints tokens to `recipient`.
    function buy(bytes32 id, uint128 units, uint128 maxCostUsdg, uint64 deadline, address recipient)
        external
        returns (uint256 costUsdg, uint256 tokensMinted);
    /// @dev Burns `tokens` of msg.sender, pays proceeds in USDG to `recipient`. Never blocked by pauses.
    function sell(bytes32 id, uint128 tokens, uint128 minProceedsUsdg, uint64 deadline, address recipient)
        external
        returns (uint256 proceedsUsdg);
    /// @dev Buys a Down option (Speed.WEEKLY by default) with strike = S * (10000 - strikePctBelowBps) / 10000 rounded to
    /// the strike step, for `tokenUnits` raw Stock Token units held by msg.sender. Selects an existing listed series.
    function shield(address stockToken, uint128 tokenUnits, uint16 strikePctBelowBps, uint128 maxCostUsdg, uint64 deadline)
        external
        returns (bytes32 id, uint256 costUsdg);
    function accrue(bytes32 id) external;
    function accrueMany(bytes32[] calldata ids) external;

    struct Quote {
        uint256 usdg; // 6 dp, ask for buys (rounded up), bid for sells (rounded down)
        uint256 vMarkWad; // per unit, before spread
        uint256 spreadBps;
        uint256 feeUsdg; // the 3 bps notional fee, included in usdg
        uint256 dailyCostUsdg; // today's holding cost for these units, 6 dp
        uint256 breakevenWad; // underlying price at which the option has paid for itself, WAD
        uint64 sigmaBps;
        SessionKind session;
        bool buyable;
    }

    function quote(bytes32 id, uint256 units, bool isBuy) external view returns (Quote memory);
    function vMark(bytes32 id) external view returns (uint256 vWad, uint256 payoffWad, uint64 sigmaBps, SessionKind session);
    function totalLiability() external view returns (uint256 liabilityWad); // sum over series: supply * norm * vMark
    function netGreeks(address stock) external view returns (int256 deltaWad, int256 gammaWad, int256 vegaWad);
    function setBuysPaused(bool globalPaused) external; // GUARDIAN
    function setSeriesBuysPaused(bytes32 id, bool paused) external; // GUARDIAN

    // ---- added by todo 07 (HALTED sell queue, auto-pause clearing), additive only

    /// @dev A sell in a HALTED session, or one whose payout transfer failed (issuer pause/freeze), escrows the tokens in
    /// the engine (they keep paying funding) and opens a ticket.
    event SellQueued(uint256 indexed ticket, bytes32 indexed id, address indexed seller, address recipient, uint128 tokens, uint64 queuedAt);
    event QueuedSellFilled(uint256 indexed ticket, address filler, uint256 usdgOut);
    event QueuedSellCancelled(uint256 indexed ticket);
    /// @dev An automatic buy pause (`AutoPaused` reason "STRESS" or "DRAWDOWN") cleared by itself.
    event AutoResumed(bytes32 indexed reason);

    /// @dev The pool rejected a funding report; the amount is carried into the next report.
    event FundingReportFailed(bytes32 indexed id, uint256 fundingUsdg);

    error UnknownSeries(bytes32 id);
    error NotTicketSeller(uint256 ticket);
    error ShieldExceedsHolding(uint256 held, uint256 wanted);

    /// @dev Buys refused by a pause: "GLOBAL", "SERIES", "PRICE", "STRESS", "DRAWDOWN", "HEDGE".
    error BuysArePaused(bytes32 reason);
    error QueueNotFillable(uint256 ticket);

    /// @dev Fills a queued sell at the current price (any session but HALTED); anyone may call, proceeds go to the
    /// ticket's recipient.
    function fillQueued(uint256 ticket) external returns (uint256 usdgOut);
    /// @dev The seller takes the escrowed tokens back before the ticket is filled.
    function cancelQueued(uint256 ticket) external;

    // ---- added by todo 07b (O(1) liability, decision 26; one source of truth for the outstanding caps)

    /// @dev Sum of every series' liability at its last touch (supply x norm x V_mark at the price and vol of that
    /// buy, sell or accrual), WAD USDG, kept incrementally. The pool's NAV, deposits, claims, payouts and the engine's
    /// caps use it (O(1)); `totalLiability()` is the full recomputation, for monitoring and tests only. Staleness bound:
    /// every live series is re-marked by the keeper's accrueMany at least hourly, so it lags the exact liability by at
    /// most one hour of price and vol moves (the pool's NAV guard band covers the first part of that move).
    function bookValue() external view returns (uint256 bookValueWad);
    /// @dev The outstanding-value caps the engine enforces on buys, in bps of NAV (total, per name). The engine's
    /// parameters are the only source; the pool's `maxOutstandingBps` / `maxPerNameBps` / `capsFor` read these.
    function capBps() external view returns (uint16 totalCapNavBps, uint16 nameCapNavBps);
}
