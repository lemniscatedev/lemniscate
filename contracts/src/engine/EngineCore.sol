// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {IOptionEngine} from "../interfaces/IOptionEngine.sol";
import {PriceReading, Series, SessionKind, Speed, VolReading} from "../libs/OptionTypes.sol";
import {EverlastingMath} from "../libs/EverlastingMath.sol";
import {Funding} from "../libs/Funding.sol";
import {EngineHelper} from "../EngineHelper.sol";
import {EngineStorage} from "./EngineStorage.sol";
import {EngineMarkLib} from "./EngineMarkLib.sol";

/// @title EngineCore
/// @notice Internal building blocks shared by the engine's external libraries: per-transaction price and vol reads,
/// series context, accrual, the per-name risk book, stress and drawdown checks, buy checks and trade pricing.
/// @dev Everything runs in the engine's storage context (the libraries are delegatecalled by the engine).
library EngineCore {
    using SafeCast for uint256;
    using SafeCast for int256;

    /// @dev A call inside try/catch failed because it ran out of gas, not on its own (todo 23).
    error InnerCallOutOfGas();

    /// @dev Call right after a caught failure with the gas measured just before the call. A callee that ran out of gas
    /// leaves the caller only 1/64 of what it had (EIP-150); one that reverted on its own leaves far more. Without this,
    /// the cheapest gas at which a transaction succeeds is the one where the inner call silently runs out (the catch
    /// path), so eth_estimateGas returned too little and the real path then failed on chain, and a caller could choose
    /// the gas that skips the stress re-check or turns a payout into a queued sell.
    function requireNotOutOfGas(uint256 gasBefore) internal view {
        if (gasleft() <= gasBefore / 63) revert InnerCallOutOfGas();
    }

    uint256 internal constant WAD = 1e18;
    uint256 internal constant BPS = 10_000;
    uint32 internal constant TAU_DAILY = 86_400;
    uint32 internal constant TAU_WEEKLY = 604_800;
    /// @dev Buys stop on a series whose norm fell below 1e-3, the keeper's relist threshold (review F06): Funding's
    /// floor is 1e-12, so at most 1e-9 of a buyer's units can ever stop paying funding.
    uint256 internal constant BUY_MIN_NORM = 1e15;
    /// @dev Trade-guard defaults (EngineStorage.Guards zero fields): $1 minimum trade and position, 30-minute hold,
    /// 7 days of HALTED before a stock can be settled at its last price.
    uint64 internal constant DEFAULT_MIN_TRADE_USDG = 1e6;
    uint32 internal constant DEFAULT_HOLD = 30 minutes;
    uint32 internal constant DEFAULT_SETTLE_DELAY = 7 days;
    /// @dev Gas forwarded to PriceGuard.tradeTwap (one Uniswap observe; the real read is well under this).
    uint256 private constant TWAP_READ_GAS = 400_000;
    /// @dev Bounds the engine applies to whatever the $LMNS fee-tier contract returns (todo 20 R4).
    uint16 internal constant MAX_FEE_DISC_BPS = 5_000;
    uint16 internal constant MAX_SPREAD_DISC_BPS = 2_000;
    uint256 private constant TIER_READ_GAS = 60_000;
    uint256 internal constant DRAWDOWN_DAYS = 30;
    uint256 internal constant RING = 31;

    bytes32 private constant PX_TAG = keccak256("lemniscate.engine.px");
    bytes32 private constant VOL_TAG = keccak256("lemniscate.engine.vol");
    uint256 private constant F_FRESH = 1 << 136;
    uint256 private constant F_PAUSED = 1 << 137;
    uint256 private constant F_SET = 1 << 138;
    uint256 private constant F_FULL = 1 << 139;

    /// @dev Everything a trade or an accrual knows about one series at this instant.
    struct Ctx {
        bytes32 id;
        address stock;
        address token;
        uint256 strike;
        uint32 tau;
        bool isCall;
        uint64 lastAccrual;
        uint256 norm;
        uint256 supply;
        uint256 s;
        SessionKind session;
        bool fresh;
        bool pxPaused;
        uint64 sigmaPosted;
        uint64 skewK;
        bool volStale;
        bool priced;
        uint64 sigma;
        uint256 rate0; // funding rate stored at the last accrual (start of the gap), WAD
        EngineHelper.PerUnit pu;
    }

    // ------------------------------------------------------------------------------------------------- context

    function context(EngineHelper h, bytes32 id, bool full) internal returns (Ctx memory c) {
        EngineStorage.SeriesInfo memory si = load(id);
        PriceReading memory r = readPrice(si.stock, full);
        (uint64 sigma, uint64 skewK, bool stale) = readVol(si.stock, si.tau);
        build(h, c, id, si, r, sigma, skewK, stale);
    }

    function contextView(EngineHelper h, bytes32 id, bool full) internal view returns (Ctx memory c) {
        EngineStorage.Layout storage $ = EngineStorage.layout();
        EngineStorage.SeriesInfo memory si = $.info[id];
        if (!si.known) si = fromRegistry(id);
        PriceReading memory r = settled(si.stock, full ? $.priceGuard.read(si.stock) : $.priceGuard.readLite(si.stock));
        VolReading memory v = $.volOracle.read(si.stock, speedOf(si.tau));
        build(h, c, id, si, r, v.sigmaBps, v.skewK, v.stale);
    }

    function build(
        EngineHelper h,
        Ctx memory c,
        bytes32 id,
        EngineStorage.SeriesInfo memory si,
        PriceReading memory r,
        uint64 sigma,
        uint64 skewK,
        bool stale
    ) internal view {
        c.id = id;
        c.stock = si.stock;
        c.token = si.token;
        c.strike = si.strike;
        c.tau = si.tau;
        c.isCall = si.isCall;
        c.lastAccrual = si.lastAccrual;
        c.norm = si.norm;
        c.rate0 = uint256(si.rateMicro) * 1e6;
        c.supply = IERC20(si.token).totalSupply();
        c.s = r.s;
        c.session = r.session;
        c.fresh = r.fresh;
        c.pxPaused = r.buysPaused;
        c.sigmaPosted = sigma;
        c.skewK = skewK;
        c.volStale = stale;
        c.priced = sigma != 0 && inDomain(r.s);
        if (c.priced) (c.pu, c.sigma) = h.perUnit(si.isCall, r.s, si.strike, sigma, skewK, si.tau);
    }

    /// @dev The engine's copy of series `id`, registered on first sight (per-stock lists, weekly-put list, name).
    function load(bytes32 id) internal returns (EngineStorage.SeriesInfo memory si) {
        EngineStorage.Layout storage $ = EngineStorage.layout();
        if ($.info[id].known) return $.info[id];
        si = fromRegistry(id);
        $.info[id] = si;
        $.byStock[si.stock].push(id);
        if (!si.isCall && si.tau == TAU_WEEKLY) $.weeklyPuts[si.stock].push(id);
        EngineStorage.NameBook storage nb = $.book[si.stock];
        if (!nb.known) {
            nb.known = true;
            $.stocks.push(si.stock);
        }
    }

    function fromRegistry(bytes32 id) internal view returns (EngineStorage.SeriesInfo memory si) {
        Series memory s = EngineStorage.layout().registry.seriesOf(id);
        if (s.token == address(0)) revert IOptionEngine.UnknownSeries(id);
        si = EngineStorage.SeriesInfo({
            stock: s.stock,
            tau: s.tauSeconds,
            isCall: s.isCall,
            known: true,
            token: s.token,
            lastAccrual: s.lastAccrual,
            liveIdx: 0,
            rateMicro: 0,
            strike: s.strike,
            norm: s.norm
        });
    }

    function sync(uint256 maxCount) internal {
        EngineStorage.Layout storage $ = EngineStorage.layout();
        uint256 n = $.registry.seriesCount();
        uint256 i = $.syncedCount;
        uint256 end = Math.min(n, i + maxCount);
        for (; i < end; ++i) {
            load($.registry.seriesIdAt(i));
        }
        $.syncedCount = end;
    }

    /// @dev One PriceGuard read per stock per transaction (transient cache). A full read replaces a cached lite one.
    function readPrice(address stock, bool full) internal returns (PriceReading memory r) {
        bytes32 slot = keccak256(abi.encode(stock, PX_TAG));
        uint256 w;
        assembly ("memory-safe") {
            w := tload(slot)
        }
        if (w & F_SET != 0 && (!full || w & F_FULL != 0)) {
            r.s = uint128(w);
            r.session = SessionKind(uint8(w >> 128));
            r.fresh = w & F_FRESH != 0;
            r.buysPaused = w & F_PAUSED != 0;
            return r;
        }
        EngineStorage.Layout storage $ = EngineStorage.layout();
        r = full ? $.priceGuard.read(stock) : $.priceGuard.readLite(stock);
        // A live reading ends an ORC-4 settlement (the feed is back); the next halt needs a new settle delay.
        if (r.session != SessionKind.HALTED && r.session != SessionKind.CLOSED && r.session != SessionKind.UNKNOWN) {
            if ($.settleS[stock] != 0) delete $.settleS[stock];
        }
        r = settled(stock, r);
        if (r.s > type(uint128).max) r.s = 0; // beyond any sane price: treat as no price
        w = r.s | (uint256(uint8(r.session)) << 128) | (r.fresh ? F_FRESH : 0) | (r.buysPaused ? F_PAUSED : 0) | F_SET
            | (full ? F_FULL : 0);
        assembly ("memory-safe") {
            tstore(slot, w)
        }
    }

    /// @dev ORC-4 (review F07/F21): a stock settled after a long halt reads CLOSED at its settlement price, so sells and
    /// queued fills go through (CLOSED spread, worse-of TWAP) instead of waiting for a feed that is gone. Buys stay off.
    function settled(address stock, PriceReading memory r) internal view returns (PriceReading memory) {
        if (r.session != SessionKind.HALTED) return r;
        uint256 st = EngineStorage.layout().settleS[stock];
        if (st == 0) return r;
        r.s = st;
        r.session = SessionKind.CLOSED;
        r.fresh = true;
        r.buysPaused = true;
        return r;
    }

    /// @dev PriceGuard's short-window trade TWAP (0 when unavailable or not supported). A call that failed for lack of
    /// gas reverts: a trader must not pick the gas that drops the worse-of check.
    function tradeTwap(address stock) internal view returns (uint256 twap) {
        uint256 gasBefore = gasleft();
        (bool ok, bytes memory data) = address(EngineStorage.layout().priceGuard).staticcall{gas: TWAP_READ_GAS}(
            abi.encodeWithSignature("tradeTwap(address)", stock)
        );
        if (!ok) {
            requireNotOutOfGas(gasBefore);
            return 0;
        }
        if (data.length < 32) return 0;
        twap = abi.decode(data, (uint256));
    }

    /// @dev The S a trade is priced at (review F01/F02/F10/F22/F23): the worse for the trader of the feed (or last
    /// good / settlement) S and the trade TWAP, and for a sell inside the account's hold also the buy-time S. A
    /// manipulated pool can only worsen the manipulator's own fill (others are bounded by maxCost / minProceeds).
    function tradeS(Ctx memory c, bool isBuy, address account) internal view returns (uint256 s) {
        s = c.s;
        bool up = isBuy == c.isCall; // the trader is worse off at a higher S
        uint256 twap = tradeTwap(c.stock);
        if (twap != 0) s = up ? Math.max(s, twap) : Math.min(s, twap);
        if (!isBuy && account != address(0)) {
            EngineStorage.Hold memory hd = EngineStorage.layout().holds[c.id][account];
            if (hd.until > block.timestamp) s = up ? Math.max(s, hd.s) : Math.min(s, hd.s);
        }
    }

    /// @dev Starts or extends `who`'s hold on series `id` at buy price `s`, keeping the more binding S.
    function recordHold(bytes32 id, address who, uint256 s, bool isCall) internal {
        EngineStorage.Hold storage hd = EngineStorage.layout().holds[id][who];
        if (hd.until <= block.timestamp || (isCall ? s < hd.s : s > hd.s)) hd.s = uint128(s);
        hd.until = uint64(block.timestamp + holdSeconds());
    }

    function minTradeUsdg() internal view returns (uint256) {
        uint64 m = EngineStorage.layout().guards.minTradeUsdg;
        return m == 0 ? DEFAULT_MIN_TRADE_USDG : m;
    }

    function holdSeconds() internal view returns (uint256) {
        uint32 h = EngineStorage.layout().guards.holdSeconds;
        return h == 0 ? DEFAULT_HOLD : h;
    }

    /// @dev Review F08/F14: a partial sell must be worth the minimum and leave at least the minimum behind; selling
    /// the whole balance is always allowed (law 4), whatever it is worth.
    function checkSellSize(Ctx memory c, address seller, uint256 tokens) internal view {
        uint256 bal = IERC20(c.token).balanceOf(seller);
        if (tokens >= bal) return;
        if (!c.priced) revert IOptionEngine.BelowMinimum();
        uint256 minWad = minTradeUsdg() * 1e12;
        if (liab(tokens, c.norm, c.pu.v) < minWad || liab(bal - tokens, c.norm, c.pu.v) < minWad) {
            revert IOptionEngine.BelowMinimum();
        }
    }

    /// @dev One VolOracle read per stock and speed per transaction (transient cache).
    function readVol(address stock, uint32 tau) internal returns (uint64 sigma, uint64 skewK, bool stale) {
        Speed speed = speedOf(tau);
        bytes32 slot = keccak256(abi.encode(stock, speed, VOL_TAG));
        uint256 w;
        assembly ("memory-safe") {
            w := tload(slot)
        }
        if (w & (1 << 129) != 0) return (uint64(w), uint64(w >> 64), w & (1 << 128) != 0);
        VolReading memory v = EngineStorage.layout().volOracle.read(stock, speed);
        w = uint256(v.sigmaBps) | (uint256(v.skewK) << 64) | (v.stale ? 1 << 128 : 0) | (1 << 129);
        assembly ("memory-safe") {
            tstore(slot, w)
        }
        return (v.sigmaBps, v.skewK, v.stale);
    }

    // -------------------------------------------------------------------------------------------------- accrual

    /// @dev Funding since the last accrual, then the series' book refresh. The gap is charged at the larger of the rate
    /// stored at the last accrual and the rate now (review F11/F34: whoever calls accrue cannot pick the price for the
    /// whole gap). Returns false (nothing written) when already accrued in this block or when there is no usable price
    /// or vol: the gap is then charged at the next priced accrual. With no supply the norm is left alone.
    function applyFunding(EngineHelper h, Ctx memory c) internal returns (bool) {
        if (c.lastAccrual >= block.timestamp || !c.priced) return false;
        EngineStorage.Layout storage $ = EngineStorage.layout();
        uint256 oldNorm = c.norm;
        uint256 newNorm = nextNorm(c);
        EngineStorage.SeriesInfo storage si = $.info[c.id];
        si.norm = uint128(newNorm);
        si.lastAccrual = uint64(block.timestamp);
        uint256 rNow = Math.ceilDiv(Funding.rate(c.pu.v, c.pu.payoff), 1e6);
        si.rateMicro = uint48(rNow);
        c.rate0 = rNow * 1e6;
        c.norm = newNorm;
        c.lastAccrual = uint64(block.timestamp);
        $.registry.storeAccrual(c.id, uint128(newNorm), uint64(block.timestamp));
        if (newNorm < oldNorm) reportFunding(c.id, liab(c.supply, oldNorm, c.pu.v) - liab(c.supply, newNorm, c.pu.v));
        storeBook(c, bookFor(h, c, 0, false, false));
        emit IOptionEngine.Accrued(c.id, uint128(newNorm), c.pu.v, c.pu.payoff, c.session);
        return true;
    }

    function nextNorm(Ctx memory c) internal view returns (uint256) {
        if (c.supply == 0) return c.norm;
        uint256 r = Math.max(c.rate0, Funding.rate(c.pu.v, c.pu.payoff));
        return Funding.stepAtRate(c.norm, r, block.timestamp - c.lastAccrual, c.tau);
    }

    /// @dev Tells the pool about funding in USDG (6 dp); dust below one micro-USDG carries to the next report. A
    /// reverting pool never blocks an accrual (and with it every token transfer): the amount carries over.
    function reportFunding(bytes32 id, uint256 fundingWad) internal {
        EngineStorage.Layout storage $ = EngineStorage.layout();
        uint256 dust = $.fundingDustWad + fundingWad;
        uint256 amount = dust / 1e12 + $.fundingBacklogUsdg;
        // Remainder of a unit conversion, not randomness (Slither weak-prng false positive).
        // slither-disable-next-line weak-prng
        $.fundingDustWad = dust % 1e12;
        if (amount == 0) return;
        uint256 gasBefore = gasleft();
        try $.pool.onFunding(id, amount) {
            $.fundingBacklogUsdg = 0;
        } catch {
            requireNotOutOfGas(gasBefore);
            $.fundingBacklogUsdg = amount;
            emit IOptionEngine.FundingReportFailed(id, amount);
        }
    }

    /// @dev Todo 19: tells the pool that `tokens` of `c`'s series were sold back (supply before the burn, the trade's S
    /// and spread) so the writer vaults covering it settle. A failing pool call never blocks the sell, but one that
    /// failed for lack of gas reverts it (a seller must not pick the gas that skips the vault settlement).
    function reportBuyback(Ctx memory c, uint256 tokens, uint256 spread) internal {
        uint256 gasBefore = gasleft();
        try EngineStorage.layout().pool.onBuyback(c.id, tokens, c.supply, c.s, spread) {}
        catch {
            requireNotOutOfGas(gasBefore);
        }
    }

    function liab(uint256 supply, uint256 norm, uint256 v) internal pure returns (uint256) {
        return Math.mulDiv(Math.mulDiv(supply, norm, WAD), v, WAD);
    }

    // ------------------------------------------------------------------------------------------------ the book

    /// @dev The book of `c`'s series and name now and after trading `tokens` (`refresh`: the quote view re-evaluates
    /// the series at the accrued norm, exactly as the trade's own accrual will).
    function bookFor(EngineHelper h, Ctx memory c, uint256 tokens, bool isBuy, bool refresh)
        internal
        view
        returns (EngineHelper.Book memory)
    {
        return h.book(
            EngineHelper.BookIn({
                pu: c.pu,
                sNow: loadRisk(c.id),
                nNow: loadName(c.stock),
                tNow: EngineStorage.layout().bookValue,
                supply: c.supply,
                norm: c.norm,
                tokens: tokens,
                isBuy: isBuy,
                refresh: refresh
            })
        );
    }

    function storeBook(Ctx memory c, EngineHelper.Book memory b) internal {
        EngineStorage.Layout storage $ = EngineStorage.layout();
        EngineHelper.Risk memory r = b.sAfter;
        $.risk[c.id] = EngineStorage.SeriesRisk({
            value: r.value.toUint128(),
            delta: r.delta.toInt128(),
            gamma: r.gamma.toUint128(),
            vega: r.vega.toUint128(),
            sc0: r.sc[0].toInt128(),
            sc1: r.sc[1].toInt128(),
            sc2: r.sc[2].toInt128(),
            sc3: r.sc[3].toInt128()
        });
        EngineStorage.NameBook storage nb = $.book[c.stock];
        nb.value = b.nAfter.value;
        nb.delta = b.nAfter.delta;
        nb.gamma = b.nAfter.gamma;
        nb.vega = b.nAfter.vega;
        nb.sc = b.nAfter.sc;
        nb.lastS = c.s;
        $.bookValue = b.tAfter;
        EngineMarkLib.update(
            c.id,
            c.stock,
            c.tau,
            c.isCall,
            [int256(b.sNow.delta), b.sAfter.delta],
            [b.sNow.vega, b.sAfter.vega],
            b.unitsAfter,
            c.s,
            c.sigmaPosted
        );
    }

    function loadRisk(bytes32 id) internal view returns (EngineHelper.Risk memory r) {
        EngineStorage.SeriesRisk memory s = EngineStorage.layout().risk[id];
        r.value = s.value;
        r.delta = s.delta;
        r.gamma = s.gamma;
        r.vega = s.vega;
        r.sc = [int256(s.sc0), s.sc1, s.sc2, s.sc3];
    }

    function loadName(address stock) internal view returns (EngineHelper.Risk memory r) {
        EngineStorage.NameBook storage nb = EngineStorage.layout().book[stock];
        r.value = nb.value;
        r.delta = nb.delta;
        r.gamma = nb.gamma;
        r.vega = nb.vega;
        r.sc = nb.sc;
    }

    // ---------------------------------------------------------------------------------------- stress, drawdown

    /// @dev Stress loss of the book with `override_`'s name replaced by `name` at price `s` (address(0): as stored).
    /// The pool's spot hedge on each name (its Stock Token balance) offsets the scenario moves.
    function stress(EngineHelper h, address override_, EngineHelper.Risk memory name, uint256 s)
        internal
        view
        returns (uint256)
    {
        EngineStorage.Layout storage $ = EngineStorage.layout();
        uint256 len = $.stocks.length;
        int256[4][] memory sc = new int256[4][](len);
        uint256[] memory hedge = new uint256[](len);
        for (uint256 i; i < len; ++i) {
            address stock = $.stocks[i];
            uint256 px;
            if (stock == override_) {
                sc[i] = name.sc;
                px = s;
            } else {
                EngineStorage.NameBook storage nb = $.book[stock];
                sc[i] = nb.sc;
                px = nb.lastS;
            }
            hedge[i] = Math.mulDiv(balanceOf(stock, address($.pool)), px, WAD);
        }
        return h.stressLoss(sc, hedge);
    }

    /// @dev Stress re-check on accrual and sells (R20) and, from the keeper paths, the NAV/share drawdown sample.
    /// Never reverts: a pool that cannot report NAV leaves the flags as they are.
    function recheck(EngineHelper h, bool withDrawdown) internal {
        EngineStorage.Layout storage $ = EngineStorage.layout();
        int256 nav;
        uint256 gasBefore = gasleft();
        try $.pool.navFor($.bookValue) returns (int256 n) {
            nav = n;
        } catch {
            requireNotOutOfGas(gasBefore);
            return;
        }
        EngineHelper.Risk memory none;
        uint256 loss = stress(h, address(0), none, 0);
        bool over = nav <= 0 ? loss > 0 : loss * BPS > uint256(nav) * $.p.stressBudgetBps;
        if (over != $.stressPaused) {
            $.stressPaused = over;
            if (over) emit IOptionEngine.AutoPaused("STRESS");
            else emit IOptionEngine.AutoResumed("STRESS");
        }
        if (withDrawdown) sampleDrawdown(nav);
    }

    /// @dev NAV per pool share (navFor(bookValue) / pool.totalSupply()) kept as a daily peak in a 31-slot ring; buys
    /// pause while it sits more than drawdownBps under the 30-day peak.
    function sampleDrawdown(int256 nav) internal {
        EngineStorage.Layout storage $ = EngineStorage.layout();
        (bool ok, bytes memory data) = address($.pool).staticcall(abi.encodeCall(IERC20.totalSupply, ()));
        if (!ok || data.length < 32 || nav <= 0) return;
        uint256 shares = abi.decode(data, (uint256));
        if (shares == 0) return;
        uint256 nps = Math.mulDiv(uint256(nav), WAD, shares);
        if (nps > type(uint224).max) return;
        uint256 day = block.timestamp / 1 days;
        // Ring-buffer index, not randomness (Slither weak-prng false positive).
        // slither-disable-next-line weak-prng
        uint256 slot = day % RING;
        uint256 w = $.navPeaks[slot];
        if (w >> 224 != day || uint224(w) < nps) $.navPeaks[slot] = (day << 224) | nps;
        uint256 peak;
        for (uint256 i; i < RING; ++i) {
            uint256 x = $.navPeaks[i];
            if (x != 0 && day - (x >> 224) < DRAWDOWN_DAYS && uint224(x) > peak) peak = uint224(x);
        }
        bool over = peak > nps && (peak - nps) * BPS > peak * $.p.drawdownBps;
        if (over != $.drawdownPaused) {
            $.drawdownPaused = over;
            if (over) emit IOptionEngine.AutoPaused("DRAWDOWN");
            else emit IOptionEngine.AutoResumed("DRAWDOWN");
        }
    }

    // --------------------------------------------------------------------------------------------- buy checks

    /// @dev First buy block that applies (0 = none), in the order of the API's buyBlockReason. Codes decode in
    /// EngineHelper.revertBlock.
    function buyBlock(Ctx memory c) internal view returns (uint8) {
        EngineStorage.Layout storage $ = EngineStorage.layout();
        if (c.s == 0) return 1; // no price
        Series memory s = $.registry.seriesOf(c.id);
        if (!s.buyable || s.archived) return 2;
        if ($.globalBuysPaused) return 3;
        if ($.seriesBuysPaused[c.id]) return 4;
        if ($.stressPaused) return 5;
        if ($.drawdownPaused) return 6;
        if ($.pool.hedgeStale()) return 7;
        if (c.session != SessionKind.REGULAR && c.session != SessionKind.EXTENDED) return 8;
        if (!c.fresh || (!c.priced && c.sigmaPosted != 0)) return 9;
        if (c.pxPaused) return 10;
        if (c.sigmaPosted == 0 || c.volStale) return 11;
        if (inEarningsBlock(c)) return 12;
        return 0;
    }

    /// @dev The series' own speed window when it has one, else the other speed's (as the API does). Inclusive.
    function inEarningsBlock(Ctx memory c) internal view returns (bool) {
        EngineStorage.Layout storage $ = EngineStorage.layout();
        Speed speed = speedOf(c.tau);
        VolReading memory v = $.volOracle.read(c.stock, speed);
        if (v.buyBlockFrom == 0 || v.buyBlockTo == 0) {
            v = $.volOracle.read(c.stock, speed == Speed.DAILY ? Speed.WEEKLY : Speed.DAILY);
        }
        if (v.buyBlockFrom == 0 || v.buyBlockTo == 0) return false;
        return block.timestamp >= v.buyBlockFrom && block.timestamp <= v.buyBlockTo;
    }

    function checkCaps(
        EngineHelper h,
        Ctx memory c,
        EngineHelper.Book memory b,
        int256 navNow,
        address recipient,
        uint256 tokens
    ) internal view {
        if (navNow <= 0) revert IOptionEngine.CapExceeded("NAV");
        EngineStorage.Layout storage $ = EngineStorage.layout();
        uint256 acct = Math.mulDiv(IERC20(c.token).balanceOf(recipient) + tokens, c.norm, WAD);
        h.checkCaps(
            EngineHelper.CapIn({
                nav: uint256(navNow),
                extended: c.session == SessionKind.EXTENDED,
                seriesAfter: b.sAfter.value,
                accountAfter: Math.mulDiv(acct, c.pu.v, WAD),
                nameAfter: b.nAfter.value,
                depthCap: $.hedgeDepthCapWad[c.stock],
                totalAfter: b.tAfter,
                vegaAfter: b.nAfter.vega,
                gammaAfter: b.nAfter.gamma,
                s: c.s,
                stressLoss: stress(h, c.stock, b.nAfter, c.s)
            }),
            $.p
        );
    }

    // ------------------------------------------------------------------------------------------------- pricing

    /// @dev Prices `units` at the trade S `sTrade` (EngineCore.tradeS); the valuation mark stays at the context's S, so
    /// whatever the worse-of rule and the stale-vol cut take off is booked as the pool's spread income.
    function priceTrade(
        EngineHelper h,
        Ctx memory c,
        EngineHelper.Book memory b,
        int256 navNow,
        uint256 units,
        bool isBuy,
        address account,
        uint256 sTrade
    ) internal view returns (IOptionEngine.Quote memory, uint256) {
        EngineStorage.Layout storage $ = EngineStorage.layout();
        (uint16 feeDisc, uint16 spreadDisc) = discountOf(account);
        uint256 vPrice = c.pu.v;
        uint64 sigma = c.sigma;
        uint256 payoff = c.pu.payoff;
        bool cut = !isBuy && c.volStale;
        if (cut || sTrade != c.s) {
            (vPrice, sigma) = h.valueAt(c.isCall, sTrade, c.strike, c.sigmaPosted, c.skewK, cut ? $.p.staleVolCutBps : 0, c.tau);
            payoff = c.isCall ? (sTrade > c.strike ? sTrade - c.strike : 0) : (c.strike > sTrade ? c.strike - sTrade : 0);
        }
        return h.price(
            EngineHelper.PriceIn({
                isBuy: isBuy,
                isCall: c.isCall,
                session: c.session,
                tau: c.tau,
                sigmaBps: sigma,
                s: sTrade,
                k: c.strike,
                units: units,
                vPrice: vPrice,
                payoff: payoff,
                vVal: c.pu.v,
                invWad: inventory(b.nAfter.vega, navNow),
                feeDiscBps: feeDisc,
                spreadDiscBps: spreadDisc
            }),
            $.p
        );
    }

    /// @dev $LMNS fee-tier discounts of `account` (bps of the fee, bps of the spread). Never reverts: no tier contract,
    /// a failing or gas-hungry one, or a short answer all mean no discount; answers are clamped to the engine's bounds.
    function discountOf(address account) internal view returns (uint16 feeDisc, uint16 spreadDisc) {
        address tiers = EngineStorage.layout().feeTiers;
        if (tiers == address(0) || account == address(0)) return (0, 0);
        (bool ok, bytes memory ret) =
            tiers.staticcall{gas: TIER_READ_GAS}(abi.encodeWithSignature("feeDiscountOf(address)", account));
        if (!ok || ret.length < 64) return (0, 0);
        (uint256 f, uint256 s) = abi.decode(ret, (uint256, uint256));
        feeDisc = uint16(Math.min(f, MAX_FEE_DISC_BPS));
        spreadDisc = uint16(Math.min(s, MAX_SPREAD_DISC_BPS));
    }

    /// @dev n = post-trade name vega / vega cap, clamped to [0, 1] (1 when NAV <= 0).
    function inventory(uint256 vega, int256 nav) internal view returns (uint256) {
        if (nav <= 0) return WAD;
        uint256 cap = uint256(nav) * EngineStorage.layout().p.vegaCapNavBps / BPS;
        if (cap == 0) return WAD;
        return Math.min(Math.mulDiv(vega, WAD, cap), WAD);
    }

    function sellable(Ctx memory c) internal pure returns (bool) {
        return c.priced && c.session != SessionKind.HALTED;
    }

    // ------------------------------------------------------------------------------------------- live series

    /// @dev Adds a series to its stock's live list (after a mint). Supply only changes through the engine's own mint
    /// and burn, so this list is the series with tokens outstanding (escrowed tokens included), less those retired as
    /// dust (review F08/F24) until their next buy.
    function markLive(bytes32 id, address stock) internal {
        EngineStorage.Layout storage $ = EngineStorage.layout();
        EngineStorage.SeriesInfo storage si = $.info[id];
        if (si.liveIdx != 0) return;
        $.live[stock].push(id);
        si.liveIdx = uint32($.live[stock].length);
    }

    /// @dev Drops a series from its stock's live list once its supply is zero (after a burn).
    function dropIfEmpty(bytes32 id, address stock, address token) internal {
        if (EngineStorage.layout().info[id].liveIdx == 0 || IERC20(token).totalSupply() != 0) return;
        dropFromLive(id, stock);
    }

    /// @dev Swap-and-pop removal from the live list (empty series, or dust retired by EngineOpsLib.retireDust).
    function dropFromLive(bytes32 id, address stock) internal {
        EngineStorage.Layout storage $ = EngineStorage.layout();
        uint32 idx = $.info[id].liveIdx;
        if (idx == 0) return;
        bytes32[] storage list = $.live[stock];
        bytes32 last = list[list.length - 1];
        list[idx - 1] = last;
        $.info[last].liveIdx = idx;
        list.pop();
        $.info[id].liveIdx = 0;
    }

    // -------------------------------------------------------------------------------------------------- misc

    function balanceOf(address token, address who) internal view returns (uint256) {
        (bool ok, bytes memory data) = token.staticcall(abi.encodeCall(IERC20.balanceOf, (who)));
        if (!ok || data.length < 32) return 0;
        return abi.decode(data, (uint256));
    }

    function speedOf(uint32 tau) internal pure returns (Speed) {
        return tau == TAU_DAILY ? Speed.DAILY : Speed.WEEKLY;
    }

    function inDomain(uint256 s) internal pure returns (bool) {
        return s >= EverlastingMath.MIN_PRICE_WAD && s <= EverlastingMath.MAX_PRICE_WAD;
    }
}
