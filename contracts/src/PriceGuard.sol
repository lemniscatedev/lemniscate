// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IPriceGuard} from "./interfaces/IPriceGuard.sol";
import {IMarketHours} from "./interfaces/IMarketHours.sol";
import {IAggregatorV3} from "./interfaces/IAggregatorV3.sol";
import {IStockToken} from "./interfaces/IStockToken.sol";
import {PriceReading, SessionKind} from "./libs/OptionTypes.sol";
import {Roles} from "./libs/Roles.sol";
import {TickPrice} from "./libs/TickPrice.sol";
import {IUniswapV3PoolLike} from "./UniswapV3TwapReference.sol";

interface ITwapPoolTokens {
    function token0() external view returns (address);
    function token1() external view returns (address);
}

interface ITokenDecimals {
    function decimals() external view returns (uint8);
}

/// @title PriceGuard
/// @notice The one place an underlying price S is produced. S is WAD USDG per whole Stock Token with the issuer's
/// uiMultiplier applied exactly once (`multiplierEmbedded` per stock), and every reading carries the session kind and
/// whether it is fresh.
/// @dev Rules (see the test names in test/PriceGuard.t.sol):
///  - `read` is a view and never reverts except for an unknown stock. External reads are gas-capped low-level
///    staticcalls with length checks, so a reverting or malformed feed, token, sequencer feed or calendar degrades to HALTED/UNKNOWN.
///  - In REGULAR or EXTENDED the feed must be within that session's max age, answer > 0, updatedAt not in the future,
///    the issuer oracle not paused and the sequencer (when configured) up past its grace period. Otherwise HALTED with
///    S = last good price and fresh = false. Issuer-oracle pause, token read failure and sequencer down are HALTED in
///    every session.
///  - CLOSED/UNKNOWN report the last good price; fresh means a last good price exists.
///  - Buys pause on: admin/guardian pause, disabled stock, a split-class (> 5%) pending multiplier change from 24h
///    before effectiveAt until 1h after, and a one-step jump in S beyond `continuityBps` that no multiplier change
///    explains (latched by `poke`, cleared by admin or two confirming feed rounds).
///  - A jump that exactly matches a multiplier change means the feed and the multiplier moved at different instants:
///    that reading is HALTED (sells queue) until they agree again, so nobody trades at a 4x-off price.
///  - `poke` is the only state writer (besides admin setters). It is permissionless: it only records what the feed
///    and token report, and confirmations need distinct feed rounds.
///  - TWAP cross-check (todo 04b, test/PriceGuardTwap.t.sol). The Robinhood stock feeds print only on a 0.5% move or a
///    24h heartbeat, so a healthy in-session feed can be ~24h old and age alone cannot tell "quiet" from "stopped".
///    When a TWAP source is set, a live REGULAR/EXTENDED reading also compares S with the `window`-second TWAP of the
///    stock/USDG Uniswap v3 pool: |S/TWAP - 1| > bandBps pauses buys ("TWAP"); a TWAP that cannot be read (no pool
///    code, observation history too short, observe reverting or malformed) pauses buys ("TWAP_UNAVAILABLE"). Both are
///    computed in the view, need no keeper, clear by themselves, and never touch the reading's S, session or fresh
///    flag, so sells keep using the feed. maxAgeRegular for heartbeat-24h feeds is therefore set wide
///    (DEFAULT_MAX_AGE_24H_HEARTBEAT = 26h) and the TWAP carries the freshness burden.
///  - Manipulation (R4). The TWAP never prices anything: S always comes from the feed. A manipulated pool can only
///    (a) pause buys (grief) or (b) hide a feed that stopped while the market moved. A price held `d` seconds at `x`
///    ticks off moves the mean by x*d/window ticks, so a one-block (1-2 s) spike of +/-20% (~1,820 ticks) moves a
///    30-minute TWAP by ~1-2 ticks, far inside a 75 bps band (~75 ticks). Shifting it by the band needs about
///    band*window tick-seconds (75 ticks for the full 30 minutes, or 2.25% for 10 minutes) held against arbitrage.
///    With in-range liquidity read on 2026-10-16 a 1% move costs about 372k USDG (NVDA 0.05%), 50k (SPY 0.05%),
///    27k (TSLA 0.3%, QQQ 0.05%), so the thin SPY/TSLA/QQQ pools are cheap to grief but expensive to hold off-market
///    for a full window. Assumption recorded: holding a primary pool off the market for most of the window costs more
///    than a buyer can extract from a stale S under the per-series caps ($40k outstanding). Residual risk: pushing a
///    thin pool through all of its liquidity to an extreme tick for a few seconds can move the mean by hundreds of
///    ticks (that pauses buys; using it to hide a stopped feed also needs the feed to stop, which maxAge bounds).
///  - Review fixes (todo 27):
///    - `tradeTwap` (F01/F02/F10/F22/F23): a short-window TWAP (`tradeTwapWindow`, 5 min by default) of the same pool,
///      in every session. The engine prices each trade at the worse for the trader of S and this TWAP, so a lagging,
///      stopped or weekend-frozen feed cannot be traded against the market, and moving the pool only worsens the
///      mover's own fill. Like `_twapPrice` it never reverts (0 = unavailable).
///    - Halt latch (F07/F21): `poke` records `haltedSince` when a REGULAR/EXTENDED reading is halted, and clears it on
///      the next live good reading. While it is set, CLOSED and UNKNOWN read HALTED (sells queue) instead of the
///      pre-halt price, and the engine's ORC-4 settlement measures the halt from it.
///    - CLOSED/UNKNOWN age bound (F07): a last good price older than `maxAgeClosed` (5 days by default: a 3-day holiday
///      weekend plus a quiet 24h-heartbeat feed fits inside) reads HALTED, so a dead keeper or feed cannot pay out at a
///      frozen price.
contract PriceGuard is AccessControl, IPriceGuard {
    bytes32 public constant GUARDIAN_ROLE = Roles.GUARDIAN_ROLE;

    bytes32 public constant REASON_MANUAL = "MANUAL";
    bytes32 public constant REASON_DISABLED = "DISABLED";
    bytes32 public constant REASON_SPLIT = "SPLIT_PENDING";
    bytes32 public constant REASON_CONTINUITY = "CONTINUITY";
    bytes32 public constant REASON_HALTED = "HALTED";
    bytes32 public constant REASON_TWAP = "TWAP";
    bytes32 public constant REASON_TWAP_UNAVAILABLE = "TWAP_UNAVAILABLE";

    /// @notice Suggested maxAgeRegular/maxAgeExtended for feeds with a 24h heartbeat (all launch names): 24h plus
    /// slack. The TWAP cross-check, not the age, is what detects a stopped feed in session.
    uint32 public constant DEFAULT_MAX_AGE_24H_HEARTBEAT = 26 hours;
    uint32 public constant DEFAULT_TWAP_WINDOW = 30 minutes;
    uint32 public constant MIN_TWAP_WINDOW = 10 minutes;
    uint32 public constant MAX_TWAP_WINDOW = 1 days;
    uint16 public constant DEFAULT_TWAP_BAND_BPS = 75;
    uint16 public constant MAX_TWAP_BAND_BPS = 2000;
    /// @notice Trade TWAP window (review F01): short, so it tracks the market the feed lags; bounds of the setter.
    uint32 public constant DEFAULT_TRADE_TWAP_WINDOW = 5 minutes;
    uint32 public constant MIN_TRADE_TWAP_WINDOW = 1 minutes;
    uint32 public constant MAX_TRADE_TWAP_WINDOW = 30 minutes;
    /// @notice CLOSED/UNKNOWN last-good-price age bound (review F07) and the bounds of its setter.
    uint32 public constant DEFAULT_MAX_AGE_CLOSED = 5 days;
    /// @dev Review R05: probes of the calendar after a stale feed's first stale instant, every DERIVED_HALT_STEP (16 x
    /// 6 h covers any closure up to 4 days; a derived halt starts at most 6 h after the first in-session stale moment).
    uint256 private constant DERIVED_HALT_PROBES = 16;
    uint256 private constant DERIVED_HALT_STEP = 6 hours;
    uint32 public constant MIN_MAX_AGE_CLOSED = 2 days;
    uint32 public constant MAX_MAX_AGE_CLOSED = 14 days;
    /// @dev 10^exp converts the pool's raw quote-per-stock price to WAD per whole token; 18/6 decimals gives 30.
    uint8 private constant MAX_TWAP_SCALE_EXP = 60;

    uint256 private constant WAD = 1e18;
    uint256 private constant BPS = 10_000;

    /// @notice A pending multiplier change larger than this is split class (pauses buys around effectiveAt).
    uint256 public constant SPLIT_CLASS_BPS = 500;
    /// @notice Buy pause window around a split-class multiplier change: from SPLIT_LEAD before effectiveAt to SPLIT_TAIL
    /// after it (24h / 1h on mainnet; deploy-time, bounded below so the pause can never be configured away).
    uint256 public immutable SPLIT_LEAD;
    uint256 public immutable SPLIT_TAIL;
    uint256 public constant HARD_MIN_SPLIT_LEAD = 10 minutes;
    uint256 public constant HARD_MIN_SPLIT_TAIL = 5 minutes;
    uint256 public constant HARD_MAX_SPLIT_WINDOW = 7 days;
    uint8 public constant CONFIRMATIONS_TO_CLEAR = 2;
    /// @notice Largest S accepted (1e15 USDG per token); larger answers are treated as malformed.
    uint256 public constant MAX_S = 1e33;
    uint256 public constant MAX_MULTIPLIER = 1e24;
    uint8 public constant MAX_FEED_DECIMALS = 36;
    uint256 public constant MAX_SEQUENCER_GRACE = 1 days;
    /// @notice Gas forwarded to each external read (feed, token getter, calendar, sequencer feed). A Chainlink proxy
    /// read costs well under this; the cap keeps a gas-burning or re-entering dependency from making `read` revert.
    uint256 public constant EXTERNAL_READ_GAS = 300_000;

    error InvalidAdmin();
    error InvalidConfig();
    error InvalidGracePeriod();
    error InvalidTwapSource();
    error InvalidTimer();

    event MarketHoursSet(address marketHours);
    event SequencerFeedSet(address feed, uint32 gracePeriod);
    event LastGoodPriceSet(address indexed stock, uint256 s, uint256 at);
    event ContinuityConfirmation(address indexed stock, uint8 confirmations, uint256 s);
    event TradeTwapWindowSet(uint32 window);
    event MaxAgeClosedSet(uint32 maxAge);
    event HaltLatched(address indexed stock, uint256 since);

    struct StockState {
        uint128 lastGoodS;
        uint64 lastGoodAt; // feed updatedAt of the last good reading
        uint64 splitPauseUntil; // latched by poke when a split-class change is in its window
        uint128 lastGoodMult; // effective multiplier at the last good reading
        uint128 pendingS; // continuity: the jumped price waiting for confirmation
        uint128 pendingMult;
        uint64 pendingAt; // feed updatedAt of the last counted round
        uint8 confirmations;
        bool manualPaused;
        bool contPaused;
        uint40 haltedSince; // set by poke when an in-session reading is halted, cleared by the next live good reading
    }

    /// @dev Everything one evaluation learns; `poke` uses the extra fields to update state.
    struct Eval {
        PriceReading r;
        SessionKind kind;
        bool live; // REGULAR/EXTENDED reading that is fresh (not halted)
        uint256 liveS;
        uint256 feedUpdatedAt;
        uint256 mult;
        bool splitCond; // split-class change inside its window right now
        uint256 splitUntil;
        bool jump; // unexplained jump vs last good (only evaluated when not already latched)
        bytes32 reason;
        uint256 twap; // only computed for a live reading with a TWAP source
        bytes32 twapReason; // REASON_TWAP / REASON_TWAP_UNAVAILABLE / 0
    }

    /// @dev One storage slot per stock.
    struct TwapSource {
        address pool;
        uint32 window;
        uint16 bandBps;
        bool stockIsToken0;
        uint8 scaleExp;
    }

    struct TokenData {
        bool ok;
        bool oraclePaused;
        uint256 ui;
        uint256 pending;
        uint256 effectiveAt;
        uint256 mult;
    }

    IMarketHours public marketHours;
    IAggregatorV3 public sequencerFeed;
    uint32 public sequencerGracePeriod;

    mapping(address stock => StockConfig) private _configs;
    mapping(address stock => uint8) public feedDecimals;
    mapping(address stock => StockState) private _states;
    mapping(address stock => TwapSource) private _twap;
    /// @notice Window of `tradeTwap` (0 = DEFAULT_TRADE_TWAP_WINDOW).
    uint32 public tradeTwapWindow;
    /// @notice CLOSED/UNKNOWN age bound of the last good price (0 = DEFAULT_MAX_AGE_CLOSED).
    uint32 public maxAgeClosed;

    constructor(address admin, address marketHours_, uint256 splitLead_, uint256 splitTail_) {
        if (admin == address(0)) revert InvalidAdmin();
        if (
            splitLead_ < HARD_MIN_SPLIT_LEAD || splitLead_ > HARD_MAX_SPLIT_WINDOW || splitTail_ < HARD_MIN_SPLIT_TAIL
                || splitTail_ > HARD_MAX_SPLIT_WINDOW
        ) revert InvalidTimer();
        SPLIT_LEAD = splitLead_;
        SPLIT_TAIL = splitTail_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        marketHours = IMarketHours(marketHours_);
        emit MarketHoursSet(marketHours_);
    }

    // ------------------------------------------------------------------ admin

    /// @inheritdoc IPriceGuard
    function setStock(address stock, StockConfig calldata cfg) external override onlyRole(DEFAULT_ADMIN_ROLE) {
        if (
            stock == address(0) || cfg.feed == address(0) || cfg.maxAgeRegular == 0 || cfg.maxAgeExtended == 0
                || cfg.continuityBps == 0
        ) revert InvalidConfig();
        uint8 decimals_;
        try IAggregatorV3(cfg.feed).decimals() returns (uint8 d) {
            decimals_ = d;
        } catch {
            revert InvalidConfig();
        }
        if (decimals_ > MAX_FEED_DECIMALS) revert InvalidConfig();
        _configs[stock] = cfg;
        feedDecimals[stock] = decimals_;
        emit StockConfigured(stock, cfg.feed, cfg.multiplierEmbedded, cfg.maxAgeRegular, cfg.maxAgeExtended);
    }

    /// @inheritdoc IPriceGuard
    /// @dev Guardian (or admin) may pause. Only admin may unpause; that also clears a continuity latch, accepting the
    /// jumped price as the new last good price.
    function setBuysPaused(address stock, bool paused) external override {
        _requireKnown(stock);
        StockState storage st = _states[stock];
        if (paused) {
            if (!hasRole(GUARDIAN_ROLE, msg.sender) && !hasRole(DEFAULT_ADMIN_ROLE, msg.sender)) {
                revert AccessControlUnauthorizedAccount(msg.sender, GUARDIAN_ROLE);
            }
            st.manualPaused = true;
            emit BuysPausedSet(stock, true, REASON_MANUAL);
            return;
        }
        _checkRole(DEFAULT_ADMIN_ROLE);
        st.manualPaused = false;
        emit BuysPausedSet(stock, false, REASON_MANUAL);
        if (st.contPaused) {
            st.contPaused = false;
            st.confirmations = 0;
            st.lastGoodS = st.pendingS;
            st.lastGoodAt = st.pendingAt;
            st.lastGoodMult = st.pendingMult;
            emit BuysPausedSet(stock, false, REASON_CONTINUITY);
            emit LastGoodPriceSet(stock, st.pendingS, st.pendingAt);
        }
    }

    /// @notice Admin: the trade TWAP window, inside [MIN_TRADE_TWAP_WINDOW, MAX_TRADE_TWAP_WINDOW].
    function setTradeTwapWindow(uint32 window) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (window < MIN_TRADE_TWAP_WINDOW || window > MAX_TRADE_TWAP_WINDOW) revert InvalidTimer();
        tradeTwapWindow = window;
        emit TradeTwapWindowSet(window);
    }

    /// @notice Admin: the CLOSED/UNKNOWN age bound, inside [MIN_MAX_AGE_CLOSED, MAX_MAX_AGE_CLOSED].
    function setMaxAgeClosed(uint32 maxAge) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (maxAge < MIN_MAX_AGE_CLOSED || maxAge > MAX_MAX_AGE_CLOSED) revert InvalidTimer();
        maxAgeClosed = maxAge;
        emit MaxAgeClosedSet(maxAge);
    }

    function setMarketHours(address marketHours_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        marketHours = IMarketHours(marketHours_);
        emit MarketHoursSet(marketHours_);
    }

    /// @notice Optional L2 sequencer uptime feed. Zero address disables the check.
    function setSequencerFeed(address feed, uint32 gracePeriod) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (gracePeriod > MAX_SEQUENCER_GRACE) revert InvalidGracePeriod();
        sequencerFeed = IAggregatorV3(feed);
        sequencerGracePeriod = gracePeriod;
        emit SequencerFeedSet(feed, gracePeriod);
    }

    /// @inheritdoc IPriceGuard
    /// @dev The pool must hold the stock on one side; its decimals and the quote token's fix the price scale here, so
    /// `read` does no extra token calls. Cardinality is not checked here: a pool that cannot serve the window simply
    /// reads TWAP_UNAVAILABLE (buys paused) until it can.
    function setTwapSource(address stock, address pool, uint32 window, uint16 bandBps)
        external
        override
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        _requireKnown(stock);
        if (pool == address(0)) {
            delete _twap[stock];
            emit TwapSourceSet(stock, address(0), 0, 0);
            return;
        }
        if (window == 0) window = DEFAULT_TWAP_WINDOW;
        if (bandBps == 0) bandBps = DEFAULT_TWAP_BAND_BPS;
        if (window < MIN_TWAP_WINDOW || window > MAX_TWAP_WINDOW || bandBps > MAX_TWAP_BAND_BPS) {
            revert InvalidTwapSource();
        }
        (bool ok0, uint256 t0) = _staticWord(pool, abi.encodeCall(ITwapPoolTokens.token0, ()));
        (bool ok1, uint256 t1) = _staticWord(pool, abi.encodeCall(ITwapPoolTokens.token1, ()));
        if (!ok0 || !ok1) revert InvalidTwapSource();
        bool stockIsToken0 = address(uint160(t0)) == stock;
        if (stockIsToken0 == (address(uint160(t1)) == stock)) revert InvalidTwapSource(); // neither side, or both
        address quote = address(uint160(stockIsToken0 ? t1 : t0));
        (bool okS, uint256 sd) = _staticWord(stock, abi.encodeCall(ITokenDecimals.decimals, ()));
        (bool okQ, uint256 qd) = _staticWord(quote, abi.encodeCall(ITokenDecimals.decimals, ()));
        if (!okS || !okQ || sd > 36 || qd > 36 || 18 + sd < qd || 18 + sd - qd > MAX_TWAP_SCALE_EXP) {
            revert InvalidTwapSource();
        }
        _twap[stock] = TwapSource({
            pool: pool,
            window: window,
            bandBps: bandBps,
            stockIsToken0: stockIsToken0,
            scaleExp: uint8(18 + sd - qd)
        });
        emit TwapSourceSet(stock, pool, window, bandBps);
    }

    // ------------------------------------------------------------------ views

    /// @inheritdoc IPriceGuard
    function twapCheck(address stock) external view override returns (uint256 twap, bool ok) {
        Eval memory e = _evaluate(stock);
        if (e.live && _twap[stock].pool != address(0)) return (e.twap, e.twapReason == bytes32(0));
        return (_twapPrice(_twap[stock]), false);
    }

    function twapSource(address stock) external view returns (TwapSource memory) {
        return _twap[stock];
    }

    /// @notice The stock pool's TWAP over `tradeTwapWindow` (WAD USDG per whole token), in any session; 0 when no TWAP
    /// source is set or the pool cannot serve the window. Never reverts (review F01: the engine's worse-of price).
    function tradeTwap(address stock) external view returns (uint256) {
        TwapSource memory src = _twap[stock];
        if (src.pool == address(0)) return 0;
        uint32 w = tradeTwapWindow;
        src.window = w == 0 ? DEFAULT_TRADE_TWAP_WINDOW : w;
        return _twapPrice(src);
    }

    /// @notice When the current halt started (0 = not halted): the earlier of poke's latch and the halt derived from the
    /// feed's own staleness (review R05: no poke needed). The engine settles a stock (ORC-4) from it.
    function haltedSince(address stock) external view returns (uint256) {
        uint256 latched = _states[stock].haltedSince;
        uint256 derived = _derivedHalt(_requireKnown(stock), feedDecimals[stock]);
        if (latched == 0) return derived;
        return derived != 0 && derived < latched ? derived : latched;
    }

    /// @inheritdoc IPriceGuard
    function read(address stock) external view override returns (PriceReading memory) {
        return _evaluate(stock).r;
    }

    /// @inheritdoc IPriceGuard
    function readLite(address stock) external view override returns (PriceReading memory) {
        return _evaluate(stock, false).r;
    }

    /// @inheritdoc IPriceGuard
    function config(address stock) external view override returns (StockConfig memory) {
        return _configs[stock];
    }

    /// @inheritdoc IPriceGuard
    function lastGoodPrice(address stock) external view override returns (uint256 s, uint256 at) {
        StockState storage st = _states[stock];
        return (st.lastGoodS, st.lastGoodAt);
    }

    /// @notice Why buys are paused right now (zero when they are not).
    function buysPausedReason(address stock) external view returns (bytes32) {
        return _evaluate(stock).reason;
    }

    function stockState(address stock) external view returns (StockState memory) {
        return _states[stock];
    }

    // ------------------------------------------------------------------ writer

    /// @inheritdoc IPriceGuard
    function poke(address stock) external override returns (PriceReading memory) {
        Eval memory e = _evaluate(stock);
        StockState storage st = _states[stock];

        if (e.splitCond && st.splitPauseUntil < e.splitUntil) {
            st.splitPauseUntil = uint64(e.splitUntil);
            emit BuysPausedSet(stock, true, REASON_SPLIT);
        }

        if (e.live) {
            if (st.contPaused) {
                if (e.feedUpdatedAt > st.pendingAt) {
                    if (_within(e.liveS, st.pendingS, _configs[stock].continuityBps)) {
                        uint8 c = st.confirmations + 1;
                        st.pendingAt = uint64(e.feedUpdatedAt);
                        emit ContinuityConfirmation(stock, c, e.liveS);
                        if (c >= CONFIRMATIONS_TO_CLEAR) {
                            st.contPaused = false;
                            st.confirmations = 0;
                            _setLastGood(stock, st, e);
                            emit BuysPausedSet(stock, false, REASON_CONTINUITY);
                        } else {
                            st.confirmations = c;
                        }
                    } else {
                        _setPending(st, e);
                    }
                }
            } else if (e.jump) {
                st.contPaused = true;
                _setPending(st, e);
                emit BuysPausedSet(stock, true, REASON_CONTINUITY);
            } else {
                _setLastGood(stock, st, e);
            }
        } else if (
            (e.kind == SessionKind.REGULAR || e.kind == SessionKind.EXTENDED) && e.r.session == SessionKind.HALTED
                && st.haltedSince == 0
        ) {
            st.haltedSince = uint40(block.timestamp);
            emit HaltLatched(stock, block.timestamp);
        }
        return _evaluate(stock).r;
    }

    function _setLastGood(address stock, StockState storage st, Eval memory e) private {
        st.haltedSince = 0;
        st.lastGoodS = uint128(e.liveS);
        st.lastGoodAt = uint64(e.feedUpdatedAt);
        st.lastGoodMult = uint128(e.mult);
        emit LastGoodPriceSet(stock, e.liveS, e.feedUpdatedAt);
    }

    function _setPending(StockState storage st, Eval memory e) private {
        st.pendingS = uint128(e.liveS);
        st.pendingMult = uint128(e.mult);
        st.pendingAt = uint64(e.feedUpdatedAt);
        st.confirmations = 0;
    }

    // ------------------------------------------------------------------ evaluation

    function _evaluate(address stock) private view returns (Eval memory e) {
        return _evaluate(stock, true);
    }

    /// @dev `withTwap` false skips the pool observe (readLite): the reading is identical except that TWAP / TWAP_UNAVAILABLE
    /// never pause buys.
    function _evaluate(address stock, bool withTwap) private view returns (Eval memory e) {
        StockConfig memory cfg = _requireKnown(stock);
        StockState memory st = _states[stock];
        e.kind = _sessionKind();

        TokenData memory t = _readToken(stock);
        e.mult = t.mult;
        bool halted = !t.ok || t.oraclePaused || _sequencerDown();

        // Split-class pending multiplier change: pause buys from effectiveAt - 24h until effectiveAt + 1h.
        if (t.ok && t.effectiveAt != 0) {
            uint256 eff = t.effectiveAt;
            bool inWindow = block.timestamp + SPLIT_LEAD >= eff && block.timestamp < eff + SPLIT_TAIL;
            bool afterSwitch = block.timestamp >= eff && block.timestamp < eff + SPLIT_TAIL;
            e.splitCond = (inWindow && t.pending != 0 && _splitClass(t.pending, t.ui))
                || (afterSwitch && st.lastGoodMult != 0 && _splitClass(t.mult, st.lastGoodMult));
            e.splitUntil = eff + SPLIT_TAIL;
        }
        bool splitActive = e.splitCond || block.timestamp < st.splitPauseUntil;

        if (e.kind != SessionKind.REGULAR && e.kind != SessionKind.EXTENDED) {
            // Review F07/F21: never a CLOSED price for a feed that was halted in session, or one older than the bound.
            uint32 maxClosed = maxAgeClosed;
            if (
                st.haltedSince != 0
                    || (
                        st.lastGoodS != 0
                            && block.timestamp > uint256(st.lastGoodAt) + (maxClosed == 0 ? DEFAULT_MAX_AGE_CLOSED : maxClosed)
                    ) || _derivedHalt(cfg, feedDecimals[stock]) != 0
            ) halted = true;
        }

        if (e.kind == SessionKind.REGULAR || e.kind == SessionKind.EXTENDED) {
            uint256 maxAge = e.kind == SessionKind.REGULAR ? cfg.maxAgeRegular : cfg.maxAgeExtended;
            (bool valid, uint256 raw, uint256 updatedAt) = _readFeed(cfg.feed, feedDecimals[stock]);
            if (!valid || block.timestamp - updatedAt > maxAge) halted = true;
            if (!halted) {
                uint256 s = cfg.multiplierEmbedded ? raw : Math.mulDiv(raw, t.mult, WAD);
                if (s == 0 || s > MAX_S) {
                    halted = true;
                } else {
                    e.liveS = s;
                    e.feedUpdatedAt = updatedAt;
                    if (st.lastGoodS != 0 && !_within(s, st.lastGoodS, cfg.continuityBps)) {
                        // Feed and multiplier moved at different instants: never trade on that S.
                        if (_explainedByMultiplier(s, st, t, cfg.continuityBps)) halted = true;
                        else if (!st.contPaused) e.jump = true; // a latched jump is handled by poke's confirmations
                    }
                    if (!halted && withTwap) {
                        TwapSource memory src = _twap[stock];
                        if (src.pool != address(0)) {
                            e.twap = _twapPrice(src);
                            if (e.twap == 0) e.twapReason = REASON_TWAP_UNAVAILABLE;
                            else if (!_within(s, e.twap, src.bandBps)) e.twapReason = REASON_TWAP;
                        }
                    }
                }
            }
        }

        PriceReading memory r = e.r;
        if (halted) {
            r.session = SessionKind.HALTED;
            r.s = st.lastGoodS;
            r.updatedAt = st.lastGoodAt;
            r.fresh = false;
        } else if (e.kind == SessionKind.REGULAR || e.kind == SessionKind.EXTENDED) {
            e.live = true;
            r.session = e.kind;
            r.s = e.liveS;
            r.updatedAt = e.feedUpdatedAt;
            r.fresh = true;
        } else {
            r.session = e.kind; // CLOSED or UNKNOWN
            r.s = st.lastGoodS;
            r.updatedAt = st.lastGoodAt;
            r.fresh = st.lastGoodS != 0;
        }

        if (!cfg.enabled) e.reason = REASON_DISABLED;
        else if (st.manualPaused) e.reason = REASON_MANUAL;
        else if (st.contPaused || e.jump) e.reason = REASON_CONTINUITY;
        else if (splitActive) e.reason = REASON_SPLIT;
        else if (halted) e.reason = REASON_HALTED;
        else if (e.twapReason != bytes32(0)) e.reason = e.twapReason;
        r.buysPaused = e.reason != bytes32(0);
    }

    /// @dev A jump is explained when S moved by the ratio of a split-class multiplier change: either the pending pair
    /// (uiMultiplier -> newUIMultiplier) or the change since the last good reading. Dividend-size steps are inside
    /// any sane continuity band, so only split-class ratios are considered.
    function _explainedByMultiplier(uint256 s, StockState memory st, TokenData memory t, uint256 bps)
        private
        pure
        returns (bool)
    {
        uint256 ratio = Math.mulDiv(s, WAD, st.lastGoodS);
        if (t.pending != 0 && _splitClass(t.pending, t.ui)) {
            if (_within(ratio, Math.mulDiv(t.pending, WAD, t.ui), bps)) return true;
            if (_within(ratio, Math.mulDiv(t.ui, WAD, t.pending), bps)) return true;
        }
        uint256 prev = st.lastGoodMult;
        if (prev != 0 && _splitClass(t.mult, prev)) {
            if (_within(ratio, Math.mulDiv(t.mult, WAD, prev), bps)) return true;
            if (_within(ratio, Math.mulDiv(prev, WAD, t.mult), bps)) return true;
        }
        return false;
    }

    /// @dev |a - b| <= b * bps / 1e4.
    function _within(uint256 a, uint256 b, uint256 bps) private pure returns (bool) {
        uint256 diff = a > b ? a - b : b - a;
        return diff * BPS <= b * bps;
    }

    /// @dev True when `next` differs from `current` by more than SPLIT_CLASS_BPS of `current`.
    function _splitClass(uint256 next, uint256 current) private pure returns (bool) {
        uint256 diff = next > current ? next - current : current - next;
        return diff * BPS > current * SPLIT_CLASS_BPS;
    }

    function _requireKnown(address stock) private view returns (StockConfig memory cfg) {
        cfg = _configs[stock];
        if (cfg.feed == address(0)) revert StockUnknown(stock);
    }

    // ------------------------------------------------------------------ external reads (never revert)

    function _sessionKind() private view returns (SessionKind) {
        address mh = address(marketHours);
        if (mh == address(0)) return SessionKind.UNKNOWN;
        (bool ok, uint256 v) = _staticWord(mh, abi.encodeCall(IMarketHours.kindAt, (block.timestamp)));
        // The calendar never reports HALTED; anything out of range is UNKNOWN.
        if (!ok || v > uint256(SessionKind.UNKNOWN)) return SessionKind.UNKNOWN;
        return SessionKind(v);
    }

    function _readToken(address stock) private view returns (TokenData memory t) {
        bool ok1;
        bool ok2;
        bool ok3;
        bool ok4;
        uint256 paused;
        (ok1, t.ui) = _staticWord(stock, abi.encodeCall(IStockToken.uiMultiplier, ()));
        (ok2, t.pending) = _staticWord(stock, abi.encodeCall(IStockToken.newUIMultiplier, ()));
        (ok3, t.effectiveAt) = _staticWord(stock, abi.encodeCall(IStockToken.effectiveAt, ()));
        (ok4, paused) = _staticWord(stock, abi.encodeCall(IStockToken.oraclePaused, ()));
        t.oraclePaused = paused != 0; // any non-zero word (including a malformed bool) counts as paused
        // Effective multiplier: the pending one once effectiveAt has passed (works whether or not the token's
        // uiMultiplier() switches by itself at effectiveAt).
        t.mult = (t.effectiveAt != 0 && block.timestamp >= t.effectiveAt && t.pending != 0) ? t.pending : t.ui;
        t.ok = ok1 && ok2 && ok3 && ok4 && t.ui != 0 && t.ui <= MAX_MULTIPLIER && t.pending <= MAX_MULTIPLIER
            && t.mult != 0;
    }

    /// @dev Review R05: the halt start derived from the feed alone, so the F21 latch and the ORC-4 settle clock do not
    /// depend on anyone calling `poke`. The feed's latest round is stale in session (what `_evaluate` reads as HALTED)
    /// from its updatedAt + maxAge on; the first such moment the calendar puts in session (probing that instant and every
    /// 6 h after it for 4 days, past any weekend or holiday closure; a later probe only starts the halt later) is the
    /// derived start. 0 = the feed is not stale at any in-session moment so far, or unreadable (then only poke's latch applies).
    function _derivedHalt(StockConfig memory cfg, uint8 decimals_) private view returns (uint256) {
        (bool valid,, uint256 updatedAt) = _readFeed(cfg.feed, decimals_);
        if (!valid) return 0;
        uint256 t = updatedAt + Math.max(cfg.maxAgeRegular, cfg.maxAgeExtended) + 1;
        address mh = address(marketHours);
        if (mh == address(0)) return 0;
        for (uint256 k; k < DERIVED_HALT_PROBES && t <= block.timestamp; ++k) {
            (bool ok, uint256 v) = _staticWord(mh, abi.encodeCall(IMarketHours.kindAt, (t)));
            if (ok && (v == uint256(SessionKind.REGULAR) || v == uint256(SessionKind.EXTENDED))) return t;
            t += DERIVED_HALT_STEP;
        }
        return 0;
    }

    /// @return valid answer > 0, updatedAt in (0, now], scaled answer within MAX_S
    /// @return raw answer scaled to WAD (multiplier not applied)
    function _readFeed(address feed, uint8 decimals_)
        private
        view
        returns (bool valid, uint256 raw, uint256 updatedAt)
    {
        (bool ok, bytes memory data) = feed.staticcall{gas: EXTERNAL_READ_GAS}(
            abi.encodeCall(IAggregatorV3.latestRoundData, ())
        );
        if (!ok || data.length < 160) return (false, 0, 0);
        int256 answer;
        (, answer,, updatedAt,) = abi.decode(data, (uint256, int256, uint256, uint256, uint256));
        if (answer <= 0 || updatedAt == 0 || updatedAt > block.timestamp) return (false, 0, updatedAt);
        uint256 a = uint256(answer);
        if (decimals_ <= 18) {
            uint256 factor = 10 ** (18 - decimals_);
            if (a > MAX_S / factor) return (false, 0, updatedAt);
            raw = a * factor;
        } else {
            raw = a / 10 ** (decimals_ - 18);
            if (raw == 0 || raw > MAX_S) return (false, 0, updatedAt);
        }
        valid = true;
    }

    /// @dev Mean tick over the window from `observe([window, 0])`, priced in WAD USDG per whole token. Returns 0 on any
    /// failure (no code, revert, short or malformed return, tick out of range); never reverts.
    function _twapPrice(TwapSource memory src) private view returns (uint256 twap) {
        if (src.pool == address(0)) return 0;
        uint32[] memory ago = new uint32[](2);
        ago[0] = src.window;
        (bool ok, bytes memory data) = src.pool.staticcall{gas: EXTERNAL_READ_GAS}(
            abi.encodeCall(IUniswapV3PoolLike.observe, (ago))
        );
        // (int56[2], uint160[2]): two offsets + two (length, a, b) blocks = 256 bytes.
        if (!ok || data.length < 256) return 0;
        uint256 off;
        assembly ("memory-safe") {
            off := mload(add(data, 32))
        }
        if (off > data.length - 96) return 0;
        uint256 len;
        int256 c0;
        int256 c1;
        assembly ("memory-safe") {
            let p := add(add(data, 32), off)
            len := mload(p)
            c0 := mload(add(p, 32))
            c1 := mload(add(p, 64))
        }
        if (len < 2 || c0 != int256(int56(c0)) || c1 != int256(int56(c1))) return 0;
        int256 delta = c1 - c0;
        int256 span = int256(uint256(src.window));
        int256 meanTick = delta / span;
        if (delta < 0 && delta % span != 0) --meanTick; // round toward negative infinity, as Uniswap's OracleLibrary
        if (meanTick > TickPrice.MAX_TICK || meanTick < -TickPrice.MAX_TICK) return 0;
        uint256 px = TickPrice.priceX128(int24(meanTick));
        if (px == 0) return 0;
        uint256 scale = 10 ** uint256(src.scaleExp);
        // Bound before scaling so an extreme tick reads "unavailable" instead of overflowing mulDiv (review F35).
        if (src.stockIsToken0) {
            if (px > Math.mulDiv(MAX_S, TickPrice.Q128, scale)) return 0;
            twap = Math.mulDiv(px, scale, TickPrice.Q128);
        } else {
            if (px < Math.mulDiv(scale, TickPrice.Q128, MAX_S, Math.Rounding.Ceil)) return 0;
            twap = Math.mulDiv(scale, TickPrice.Q128, px);
        }
        if (twap > MAX_S) return 0;
    }

    function _sequencerDown() private view returns (bool) {
        address feed = address(sequencerFeed);
        if (feed == address(0)) return false;
        (bool ok, bytes memory data) = feed.staticcall{gas: EXTERNAL_READ_GAS}(
            abi.encodeCall(IAggregatorV3.latestRoundData, ())
        );
        if (!ok || data.length < 160) return true;
        (, int256 answer, uint256 startedAt,,) = abi.decode(data, (uint256, int256, uint256, uint256, uint256));
        if (answer != 0 || startedAt == 0 || startedAt > block.timestamp) return true;
        return block.timestamp - startedAt < sequencerGracePeriod;
    }

    function _staticWord(address target, bytes memory callData) private view returns (bool ok, uint256 value) {
        bytes memory data;
        (ok, data) = target.staticcall{gas: EXTERNAL_READ_GAS}(callData);
        if (!ok || data.length < 32) return (false, 0);
        value = abi.decode(data, (uint256));
    }
}
