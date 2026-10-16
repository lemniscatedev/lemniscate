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
contract PriceGuard is AccessControl, IPriceGuard {
    bytes32 public constant GUARDIAN_ROLE = Roles.GUARDIAN_ROLE;

    bytes32 public constant REASON_MANUAL = "MANUAL";
    bytes32 public constant REASON_DISABLED = "DISABLED";
    bytes32 public constant REASON_SPLIT = "SPLIT_PENDING";
    bytes32 public constant REASON_CONTINUITY = "CONTINUITY";
    bytes32 public constant REASON_HALTED = "HALTED";

    uint256 private constant WAD = 1e18;
    uint256 private constant BPS = 10_000;

    /// @notice A pending multiplier change larger than this is split class (pauses buys around effectiveAt).
    uint256 public constant SPLIT_CLASS_BPS = 500;
    uint256 public constant SPLIT_LEAD = 24 hours;
    uint256 public constant SPLIT_TAIL = 1 hours;
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

    event MarketHoursSet(address marketHours);
    event SequencerFeedSet(address feed, uint32 gracePeriod);
    event LastGoodPriceSet(address indexed stock, uint256 s, uint256 at);
    event ContinuityConfirmation(address indexed stock, uint8 confirmations, uint256 s);

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

    constructor(address admin, address marketHours_) {
        if (admin == address(0)) revert InvalidAdmin();
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

    // ------------------------------------------------------------------ views

    /// @inheritdoc IPriceGuard
    function read(address stock) external view override returns (PriceReading memory) {
        return _evaluate(stock).r;
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
        }
        return _evaluate(stock).r;
    }

    function _setLastGood(address stock, StockState storage st, Eval memory e) private {
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
