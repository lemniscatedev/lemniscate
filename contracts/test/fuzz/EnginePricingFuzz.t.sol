// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {EngineHelper} from "../../src/EngineHelper.sol";
import {ILemniscateEngine} from "../../src/interfaces/ILemniscateEngine.sol";
import {MarketConfig, MarketState, Regime} from "../../src/libs/LemniscateTypes.sol";
import {LemniscateEngineFixture} from "../LemniscateEngine.t.sol";

/// @notice Fuzz properties of LemniscateEngine pricing, fees, carry, the paused mark, and the paused-sell budget.
/// Uses the engine behind its proxy with a fixed-NAV vault double, so NAV-dependent capacity is controlled.
contract EnginePricingFuzzTest is LemniscateEngineFixture {
    uint256 internal constant BPS = 10_000;
    uint256 internal constant NAV = 10_000_000; // USD
    uint256 internal constant WINDOW = 1 hours;
    uint256 internal constant MIN_NORM_FACTOR = 1e12;

    EngineHelper internal helper;

    function setUp() public override {
        super.setUp();
        vault.setNavWad(int256(NAV * WAD));
        usdg.mint(address(vault), NAV * USDG);
        MarketConfig memory c = _config();
        c.maxTradeUsdg = uint128(2_000_000 * USDG);
        c.pausedSellCapPerBlockUsdg = uint128(100_000 * USDG);
        _setConfig(c);
        usdg.mint(ALICE, 100_000_000 * USDG);
        helper = new EngineHelper();
    }

    // ------------------------------------------------------------------ helpers

    function _now() internal view returns (uint256) {
        return vm.getBlockTimestamp();
    }

    function _setRegime(uint256 seed) internal returns (Regime regime) {
        regime = Regime(seed % 3);
        if (regime == Regime.OFF_HOURS) marketHours.setOpen(false);
        if (regime == Regime.PAUSED) stock.setOraclePaused(true);
    }

    function _spreadBand(Regime regime) internal view returns (uint256 spread, uint256 band) {
        MarketConfig memory c = _config();
        if (regime == Regime.OPEN) return (c.openSpreadBps, c.openBandBps);
        if (regime == Regime.OFF_HOURS) return (c.offHoursSpreadBps, c.offHoursBandBps);
        return (c.pausedSpreadBps, 300);
    }

    /// Opens a position so sells have something to sell; returns the tokens bought.
    function _openPosition(uint256 usdgIn) internal returns (uint256) {
        vm.prank(ALICE);
        return engine.buy(0, usdgIn, 0, ALICE, type(uint256).max);
    }

    // ------------------------------------------------------------------ spread / band bounds

    /// @notice Buy trade price lies in [fair*(1+spread), fair*(1+band)] (rounding as the engine floors the markup).
    function testFuzz_buyPriceWithinSpreadAndBand(uint256 usdgIn, uint256 regimeSeed) public {
        Regime regime = _setRegime(regimeSeed % 2); // buys are closed while paused
        usdgIn = bound(usdgIn, USDG, 2_000_000 * USDG);
        uint256 fair = engine.tokenPrice(0);
        (, , uint256 price,) = engine.quoteBuy(0, usdgIn);
        (uint256 spread, uint256 band) = _spreadBand(regime);
        assertGe(price, fair + fair * spread / BPS, "below spread");
        assertLe(price, fair + fair * band / BPS, "above band");
    }

    /// @notice Sell trade price lies in [fair*(1-band), fair*(1-spread)], including the paused 3% band.
    function testFuzz_sellPriceWithinSpreadAndBand(uint256 tokensIn, uint256 regimeSeed) public {
        _openPosition(1_000_000 * USDG);
        Regime regime = _setRegime(regimeSeed);
        uint256 short = engine.getState(0).vaultShort;
        tokensIn = bound(tokensIn, 1, short);
        uint256 fair = engine.tokenPrice(0);
        (, , uint256 price) = engine.quoteSell(0, tokensIn);
        (uint256 spread, uint256 band) = _spreadBand(regime);
        assertLe(price, fair - fair * spread / BPS, "inside spread");
        assertGe(price, fair - fair * band / BPS, "beyond band");
    }

    // ------------------------------------------------------------------ monotonicity

    /// @notice Bigger buys never get a better unit price; tokens out never fall by more than one bps step.
    /// @dev Strict monotonicity of tokensOut does not hold: impact is floored to whole bps, so crossing a bps step
    /// can cost up to 1 bps of tokens (see testBuyTokensOutDipsAtImpactStep).
    function testFuzz_buyQuoteMonotone(uint256 a, uint256 b, uint256 regimeSeed) public {
        _setRegime(regimeSeed % 2);
        a = bound(a, USDG, 2_000_000 * USDG);
        b = bound(b, a, 2_000_000 * USDG);
        (uint256 outA, uint256 feeA, uint256 priceA,) = engine.quoteBuy(0, a);
        (uint256 outB, uint256 feeB, uint256 priceB,) = engine.quoteBuy(0, b);
        assertLe(priceA, priceB, "price falls with size");
        assertLe(feeA, feeB, "fee falls with size");
        assertGe(outB, outA * (BPS - 1) / BPS, "tokensOut falls by more than one bps step");
    }

    /// @notice Bigger sells never get a better unit price; USDG out never falls by more than one bps step.
    function testFuzz_sellQuoteMonotone(uint256 a, uint256 b, uint256 regimeSeed) public {
        _openPosition(1_000_000 * USDG);
        _setRegime(regimeSeed);
        uint256 short = engine.getState(0).vaultShort;
        a = bound(a, 1, short);
        b = bound(b, a, short);
        (uint256 outA,, uint256 priceA) = engine.quoteSell(0, a);
        (uint256 outB,, uint256 priceB) = engine.quoteSell(0, b);
        assertGe(priceA, priceB, "sell price rises with size");
        assertGe(outB + 1, outA * (BPS - 1) / BPS, "usdgOut falls by more than one bps step");
    }

    /// @notice Documents the 1-bps discreteness: one more wei of input across an impact step buys fewer tokens.
    function testBuyTokensOutDipsAtImpactStep() public view {
        MarketConfig memory c = _config();
        uint256 capacity = NAV * USDG * c.maxMarketExposureBps / BPS; // USDG units
        uint256 step = Math.mulDiv(capacity, 1, c.impactBps, Math.Rounding.Ceil); // first input with 1 bps impact
        (uint256 below,,,) = engine.quoteBuy(0, step - 1);
        (uint256 at,,,) = engine.quoteBuy(0, step);
        assertLt(at, below, "expected a dip at the impact step");
        assertGe(at, below * (BPS - 1) / BPS, "dip bounded by one bps");
    }

    // ------------------------------------------------------------------ fees and rounding

    /// @notice Buy fee rounds up, tokens out round down, and execution matches the quote.
    function testFuzz_buyFeeAndRoundingFavourProtocol(uint256 usdgIn) public {
        usdgIn = bound(usdgIn, USDG, 2_000_000 * USDG);
        MarketConfig memory c = _config();
        (uint256 tokensOut, uint256 fee, uint256 price,) = engine.quoteBuy(0, usdgIn);
        assertEq(fee, Math.mulDiv(usdgIn, c.feeBps, BPS, Math.Rounding.Ceil), "fee not ceil");
        assertLe(tokensOut * price, (usdgIn - fee) * 1e12 * WAD, "tokens rounded up");
        uint256 treasuryBefore = usdg.balanceOf(TREASURY);
        vm.prank(ALICE);
        uint256 got = engine.buy(0, usdgIn, tokensOut, ALICE, type(uint256).max);
        assertEq(got, tokensOut, "execution != quote");
        assertEq(usdg.balanceOf(TREASURY) - treasuryBefore, fee * engine.protocolFeeShareBps() / BPS, "treasury cut");
    }

    /// @notice Sell gross rounds down, fee rounds up, and execution pays exactly the quote.
    function testFuzz_sellFeeAndRoundingFavourProtocol(uint256 tokensIn, uint256 regimeSeed) public {
        uint256 bought = _openPosition(1_000_000 * USDG);
        _setRegime(regimeSeed);
        tokensIn = bound(tokensIn, 1, bought);
        MarketConfig memory c = _config();
        (uint256 usdgOut, uint256 fee, uint256 price) = engine.quoteSell(0, tokensIn);
        uint256 gross = tokensIn * price / WAD / 1e12;
        assertLe(gross * 1e12 * WAD, tokensIn * price, "gross rounded up");
        assertEq(fee, Math.mulDiv(gross, c.feeBps, BPS, Math.Rounding.Ceil), "fee not ceil");
        assertEq(usdgOut, gross > fee ? gross - fee : 0, "out != gross - fee");
        uint256 before = usdg.balanceOf(ALICE);
        vm.prank(ALICE);
        try engine.sell(0, tokensIn, 0, ALICE, type(uint256).max) returns (uint256 paid) {
            assertEq(paid, usdgOut, "execution != quote");
            assertEq(usdg.balanceOf(ALICE) - before, usdgOut);
        } catch (bytes memory err) {
            assertEq(bytes4(err), ILemniscateEngine.PausedSellCapExceeded.selector, "unexpected sell revert");
        }
    }

    /// @notice A buy immediately followed by selling the tokens (same block, same mark) never returns more USDG.
    function testFuzz_roundTripNeverProfits(uint256 usdgIn, uint256 regimeSeed, uint256 priorIn) public {
        priorIn = bound(priorIn, 0, 1_000_000 * USDG);
        if (priorIn >= USDG) _openPosition(priorIn);
        _setRegime(regimeSeed % 2);
        usdgIn = bound(usdgIn, USDG, 1_000_000 * USDG); // prior + this stays inside the 2.5M market cap
        uint256 before = usdg.balanceOf(ALICE);
        vm.startPrank(ALICE);
        uint256 tokens = engine.buy(0, usdgIn, 0, ALICE, type(uint256).max);
        engine.sell(0, tokens, 0, ALICE, type(uint256).max);
        vm.stopPrank();
        assertLe(usdg.balanceOf(ALICE), before, "round trip profit");
    }

    // ------------------------------------------------------------------ carry / normFactor

    /// @notice normFactor projection: exactly nf*(1 - carry*min(t,7d)/1d), floored at MIN_NORM_FACTOR, and
    /// non-increasing in elapsed time.
    function testFuzz_normFactorProjection(uint256 carry, uint256 t1, uint256 t2) public {
        carry = bound(carry, 0, 2e18);
        MarketConfig memory c = _config();
        c.offHoursCarryWad = int64(int256(carry));
        _setConfig(c);
        marketHours.setOpen(false); // off-hours and paused both use offHoursCarryWad
        uint256 start = _now();
        uint256 nf0 = engine.getState(0).normFactor;
        t1 = bound(t1, 0, 30 days);
        t2 = bound(t2, t1, 30 days);

        vm.warp(start + t1);
        uint256 nf1 = engine.currentNormFactor(0);
        assertEq(nf1, _expectedNorm(nf0, carry, t1), "projection t1");
        vm.warp(start + t2);
        uint256 nf2 = engine.currentNormFactor(0);
        assertEq(nf2, _expectedNorm(nf0, carry, t2), "projection t2");
        assertLe(nf2, nf1, "normFactor rose with time");
        assertGe(nf2, MIN_NORM_FACTOR, "below floor");
        if (t2 >= 7 days) assertEq(nf2, _expectedNorm(nf0, carry, 7 days), "accrual not capped at 7 days");

        // Storing the accrual gives the same value the view projected.
        engine.accrue(0);
        assertEq(engine.getState(0).normFactor, nf2, "stored != projected");
    }

    /// @notice Decay just short of 100% still floors at MIN_NORM_FACTOR (the fuzzer rarely lands in that sliver).
    function testNormFactorFloorsJustBelowFullDecay() public {
        MarketConfig memory c = _config();
        c.offHoursCarryWad = int64(int256(WAD - 1)); // one day decays all but 1e-18
        _setConfig(c);
        marketHours.setOpen(false);
        vm.warp(_now() + 1 days);
        assertEq(engine.currentNormFactor(0), MIN_NORM_FACTOR);
        engine.accrue(0);
        assertEq(engine.getState(0).normFactor, MIN_NORM_FACTOR);
    }

    function _expectedNorm(uint256 nf0, uint256 carry, uint256 elapsed) internal pure returns (uint256) {
        if (elapsed > 7 days) elapsed = 7 days;
        if (elapsed == 0 || carry == 0) return nf0;
        uint256 decay = carry * elapsed / 1 days;
        if (decay >= WAD) return MIN_NORM_FACTOR;
        uint256 projected = nf0 * (WAD - decay) / WAD;
        return projected < MIN_NORM_FACTOR ? MIN_NORM_FACTOR : projected;
    }

    /// @notice Open-market carry = base + skew*util, clamped to [minCarry, maxCarry] for any utilization.
    function testFuzz_openCarryClamped(uint256 usdgIn, uint256 minCarry, uint256 maxCarry) public {
        MarketConfig memory c = _config();
        minCarry = bound(minCarry, 0, 5e15);
        maxCarry = bound(maxCarry, minCarry, 1e16);
        c.minCarryWad = int64(int256(minCarry));
        c.maxCarryWad = int64(int256(maxCarry));
        _setConfig(c);
        usdgIn = bound(usdgIn, 0, 2_000_000 * USDG);
        if (usdgIn >= USDG) _openPosition(usdgIn);
        MarketState memory s = engine.getState(0);
        int256 raw = int256(s.baseCarryWad) + int256(c.skewCarryWad) * int256(uint256(s.lastUtilBps)) / int256(BPS);
        int256 expected = raw < int256(minCarry) ? int256(minCarry) : raw > int256(maxCarry) ? int256(maxCarry) : raw;
        assertEq(engine.currentCarryWad(0), expected);
        assertLe(s.lastUtilBps, BPS);
    }

    // ------------------------------------------------------------------ paused mark

    /// @notice Paused mark = the newer live round only when it is lower than the last good index but above a quarter
    /// of it (a >50% spot drop is a corporate-action transient); otherwise the last good mark. Never above last good.
    function testFuzz_pausedMarkRule(uint256 livePrice, uint256 delay, bool older, bool invalid) public {
        _openPosition(100_000 * USDG); // accrues at $100 open: lastGood = $100
        MarketState memory s0 = engine.getState(0);
        livePrice = bound(livePrice, 1e6, 1_000e8); // $0.01 .. $1000
        delay = bound(delay, 1, 3 days);
        vm.warp(_now() + delay);
        feed.setAnswer(invalid ? int256(0) : int256(livePrice));
        if (older) feed.setUpdatedAt(s0.lastGoodAt);
        stock.setOraclePaused(true);
        assertEq(uint8(engine.currentRegime(0)), uint8(Regime.PAUSED));

        uint256 liveIndex = Math.mulDiv(livePrice * 1e10, livePrice * 1e10, WAD) / _config().scale;
        bool useLive = !invalid && !older && liveIndex < s0.lastGoodIndex && liveIndex * 4 > s0.lastGoodIndex
            && liveIndex != 0;
        uint256 expected = useLive ? liveIndex : s0.lastGoodIndex;
        assertEq(engine.index(0), expected, "paused index");
        assertLe(engine.index(0), s0.lastGoodIndex, "paused mark above last good");
        (uint256 total,) = engine.valuation();
        assertEq(total, engine.liability(0));
    }

    // ------------------------------------------------------------------ paused-sell leaky bucket

    struct SellLog {
        uint256 at;
        uint256 gross;
    }

    /// @notice Leaky bucket: over any interval [ti, tj] paused sells total at most cap + cap*(tj-ti)/window, so an
    /// interval shorter than the window lets out less than twice the cap, and the stored level never exceeds the cap.
    function testFuzz_pausedSellBudget(uint256 seed) public {
        uint256 bought = _openPosition(2_000_000 * USDG);
        stock.setOraclePaused(true);
        uint256 cap = _config().pausedSellCapPerBlockUsdg;
        uint256 chunk = bought / 30; // ~66k USDG gross against a 100k cap
        SellLog[] memory log = new SellLog[](12);
        uint256 n;
        uint256 t = _now();
        for (uint256 i; i < 12; ++i) {
            seed = uint256(keccak256(abi.encode(seed, i)));
            t += seed % 3 == 0 ? 0 : (seed >> 8) % (90 minutes);
            vm.warp(t);
            uint256 tokensIn = bound(seed >> 64, 1, chunk);
            (uint256 out, uint256 fee,) = engine.quoteSell(0, tokensIn);
            vm.prank(ALICE);
            try engine.sell(0, tokensIn, 0, ALICE, type(uint256).max) {
                log[n++] = SellLog(t, out + fee);
                bought -= tokensIn;
            } catch (bytes memory err) {
                assertEq(bytes4(err), ILemniscateEngine.PausedSellCapExceeded.selector, "unexpected revert");
            }
            assertLe(engine.getState(0).pausedSellUsed, cap, "bucket over cap");
        }
        for (uint256 i; i < n; ++i) {
            uint256 sum;
            for (uint256 j = i; j < n; ++j) {
                sum += log[j].gross;
                uint256 allowance = cap + cap * (log[j].at - log[i].at) / WINDOW;
                assertLe(sum, allowance, "interval exceeded budget");
                if (log[j].at - log[i].at < WINDOW) assertLt(sum, 2 * cap, "short interval >= 2x cap");
            }
        }
    }

    // ------------------------------------------------------------------ capacity helper

    /// @notice quoteBuy's maxUsdgIn fits the exposure caps up to one bps: buying it either succeeds, or reverts with a
    /// cap error and a buy 2 bps smaller succeeds. After any successful buy both caps hold.
    /// @dev maxUsdgIn models price impact as continuous while the engine floors it to whole bps, so the buyer can get
    /// up to 1 bps more tokens than modelled (see testMaxUsdgInCanOvershootMarketCapByUnderOneBps).
    function testFuzz_maxUsdgInFitsCaps(uint256 prior, uint256 regimeSeed, uint16 exposureBps) public {
        MarketConfig memory c = _config();
        c.maxMarketExposureBps = uint16(bound(exposureBps, 100, 10_000));
        _setConfig(c);
        prior = bound(prior, 0, 1_000_000 * USDG);
        if (prior >= USDG) {
            (,,, uint256 room) = engine.quoteBuy(0, USDG);
            if (room >= prior) _openPosition(prior);
        }
        _setRegime(regimeSeed % 2);
        (,,, uint256 maxIn) = engine.quoteBuy(0, USDG);
        vm.assume(maxIn >= c.minTradeUsdg);
        vm.prank(ALICE);
        try engine.buy(0, maxIn, 0, ALICE, type(uint256).max) {}
        catch (bytes memory err) {
            bytes4 sel = bytes4(err);
            assertTrue(
                sel == ILemniscateEngine.MarketCapExceeded.selector || sel == ILemniscateEngine.GlobalCapExceeded.selector,
                "unexpected revert"
            );
            uint256 smaller = maxIn * (BPS - 2) / BPS;
            vm.assume(smaller >= c.minTradeUsdg);
            vm.prank(ALICE);
            engine.buy(0, smaller, 0, ALICE, type(uint256).max);
        }
        uint256 nav = NAV * WAD;
        assertLe(engine.liability(0), nav * c.maxMarketExposureBps / BPS + 1, "market cap");
        assertLe(engine.totalLiability(), nav * engine.maxGlobalExposureBps() / BPS + 1, "global cap");
    }

    /// @notice Documents the sub-bps overshoot: with a 1% market cap the advertised maxUsdgIn reverts, 1 bps less fills.
    function testMaxUsdgInCanOvershootMarketCapByUnderOneBps() public {
        MarketConfig memory c = _config();
        c.maxMarketExposureBps = 100;
        _setConfig(c);
        (,,, uint256 maxIn) = engine.quoteBuy(0, USDG);
        vm.prank(ALICE);
        vm.expectRevert(ILemniscateEngine.MarketCapExceeded.selector);
        engine.buy(0, maxIn, 0, ALICE, type(uint256).max);
        vm.prank(ALICE);
        engine.buy(0, maxIn * (BPS - 1) / BPS, 0, ALICE, type(uint256).max);
    }

    /// @notice grossInputForRoom: the post-fee notional of the returned input, at the price its own (bps-floored)
    /// impact implies, fits the room to within one bps (the continuous-vs-floored impact gap) plus one wei.
    function testFuzz_grossInputForRoomFits(
        uint256 room,
        uint256 capacity,
        uint256 feeBps,
        uint256 impact,
        uint256 spread,
        uint256 band
    ) public view {
        room = bound(room, 1, 1e15);
        capacity = bound(capacity, room, 1e16); // maxUsdgIn: room <= market limit (= capacity)
        feeBps = bound(feeBps, 0, 100);
        impact = bound(impact, 0, 1_000);
        band = bound(band, 0, 1_000);
        spread = bound(spread, 0, band);
        uint256 gross = helper.grossInputForRoom(room, capacity, feeBps, impact, spread, band);
        uint256 impactBps = impact == 0 ? 0 : capacity == 0 ? band : Math.mulDiv(impact, gross, capacity);
        uint256 dev = spread + impactBps > band ? band : spread + impactBps;
        uint256 fee = Math.mulDiv(gross, feeBps, BPS, Math.Rounding.Ceil);
        // notional = (gross - fee) / (1 + dev) must not exceed room * (1 + 1 bps).
        assertLe((gross - fee) * BPS * BPS, (room + 1) * (BPS + dev) * (BPS + 1), "input overshoots room");
    }
}
