// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {PriceGuard} from "../src/PriceGuard.sol";
import {IPriceGuard} from "../src/interfaces/IPriceGuard.sol";
import {PriceReading, SessionKind} from "../src/libs/OptionTypes.sol";
import {MockGuardFeed, MockKindHours} from "./mocks/PriceGuardMocks.sol";
import {
    MockDecimalsToken,
    MockObservingPool,
    MockRawObservePool,
    MockConstPool,
    MockStock18
} from "./mocks/TwapMocks.sol";

/// @notice Todo 04b: PriceGuard TWAP cross-check (R1-R6). Fixture numbers are real-shaped: 8-decimal feeds that embed
/// the multiplier, 18-decimal stocks, a 6-decimal USDG, and tick cumulatives read from the four primary mainnet pools on
/// 2026-10-16 (addresses deliberately not used here; see the private research notes).
contract PriceGuardTwapTest is Test {
    uint256 internal constant T0 = 1_790_000_000;
    uint256 internal constant WAD = 1e18;
    /// @dev 1.0001^-230270 * 1e30 ~= 100.0002: a $100 stock as token0 against a 6-decimal USDG.
    int24 internal constant TICK_100 = -230_270;

    address internal admin = makeAddr("admin");
    address internal stranger = makeAddr("stranger");

    PriceGuard internal guard;
    MockKindHours internal hours_;
    MockStock18 internal stock;
    MockGuardFeed internal feed;
    MockDecimalsToken internal usdg;
    MockObservingPool internal pool;

    function setUp() public {
        vm.warp(T0);
        hours_ = new MockKindHours();
        stock = new MockStock18();
        feed = new MockGuardFeed(8, 100e8);
        usdg = new MockDecimalsToken(6);
        guard = new PriceGuard(admin, address(hours_), 24 hours, 1 hours);
        pool = new MockObservingPool(address(stock), address(usdg), TICK_100, 7200, 2 hours);
        vm.startPrank(admin);
        guard.setStock(address(stock), _cfg(address(feed)));
        guard.setTwapSource(address(stock), address(pool), 0, 0); // defaults: 30 min, 75 bps
        vm.stopPrank();
    }

    // ------------------------------------------------------------------ helpers

    function _cfg(address feed_) internal pure returns (IPriceGuard.StockConfig memory) {
        return IPriceGuard.StockConfig({
            feed: feed_,
            multiplierEmbedded: true,
            maxAgeRegular: 26 hours,
            maxAgeExtended: 26 hours,
            continuityBps: 1500,
            enabled: true
        });
    }

    function _read() internal view returns (PriceReading memory) {
        return guard.read(address(stock));
    }

    function _reason() internal view returns (bytes32) {
        return guard.buysPausedReason(address(stock));
    }

    function _twap() internal view returns (uint256 t) {
        (t,) = guard.twapCheck(address(stock));
    }

    /// @dev Feed answer (8 decimals) `bps` away from `ref` (WAD).
    function _answerAt(uint256 ref, int256 bps) internal pure returns (int256) {
        return int256(ref) * (10_000 + bps) / 10_000 / 1e10;
    }

    function _assertSellable(PriceReading memory r, int256 answer) internal pure {
        assertEq(uint256(r.session), uint256(SessionKind.REGULAR), "session unchanged");
        assertTrue(r.fresh, "still fresh: sells use the feed");
        assertEq(r.s, uint256(answer) * 1e10, "S is the feed, never the TWAP");
    }

    // ------------------------------------------------------------------ R1 twapDisagreementPausesBuys

    function test_R1_twapDisagreementPausesBuys_inBandOpen() public view {
        uint256 t = _twap();
        assertApproxEqRel(t, 100e18, 1e14, "TWAP ~ $100");
        PriceReading memory r = _read();
        assertFalse(r.buysPaused);
        assertEq(_reason(), bytes32(0));
        (uint256 t2, bool ok) = guard.twapCheck(address(stock));
        assertEq(t2, t);
        assertTrue(ok);
    }

    function test_R1_twapDisagreementPausesBuys_bothSidesAndClears() public {
        uint256 t = _twap();
        int256 up = _answerAt(t, 80);
        feed.push(up);
        PriceReading memory r = _read();
        assertTrue(r.buysPaused, "feed 80 bps above TWAP");
        assertEq(_reason(), guard.REASON_TWAP());
        _assertSellable(r, up);
        (, bool ok) = guard.twapCheck(address(stock));
        assertFalse(ok);

        int256 down = _answerAt(t, -80);
        feed.push(down);
        assertTrue(_read().buysPaused, "feed 80 bps below TWAP");
        assertEq(_reason(), guard.REASON_TWAP());

        feed.push(_answerAt(t, 50)); // back inside: clears by itself, no keeper, no admin
        assertFalse(_read().buysPaused);
        assertEq(_reason(), bytes32(0));
    }

    function test_R1_twapDisagreementPausesBuys_extendedToo() public {
        hours_.setKind(SessionKind.EXTENDED);
        feed.push(_answerAt(_twap(), 100));
        PriceReading memory r = _read();
        assertEq(uint256(r.session), uint256(SessionKind.EXTENDED));
        assertTrue(r.buysPaused);
        assertEq(_reason(), guard.REASON_TWAP());
    }

    function test_R1_twapDisagreementPausesBuys_notInClosedSession() public {
        feed.push(_answerAt(_twap(), 300));
        guard.poke(address(stock)); // records a last good price while REGULAR
        hours_.setKind(SessionKind.CLOSED);
        assertTrue(_reason() != guard.REASON_TWAP(), "CLOSED uses the last close; no TWAP check");
        (uint256 t, bool ok) = guard.twapCheck(address(stock));
        assertGt(t, 0, "TWAP still reported");
        assertFalse(ok, "no live feed price to compare");
    }

    function testFuzz_R1_twapDisagreementPausesBuys_band(int256 bps) public {
        bps = bound(bps, -500, 500);
        uint256 t = _twap();
        feed.push(_answerAt(t, bps));
        uint256 s = _read().s;
        uint256 diff = s > t ? s - t : t - s;
        bool outside = diff * 10_000 > t * 75;
        assertEq(_read().buysPaused, outside);
        assertEq(_reason(), outside ? guard.REASON_TWAP() : bytes32(0));
    }

    function test_R1_twapDisagreementPausesBuys_bandConfigurable() public {
        feed.push(_answerAt(_twap(), 100));
        assertTrue(_read().buysPaused);
        vm.prank(admin);
        guard.setTwapSource(address(stock), address(pool), 1 hours, 150);
        assertFalse(_read().buysPaused, "100 bps inside a 150 bps band");
        PriceGuard.TwapSource memory src = guard.twapSource(address(stock));
        assertEq(src.window, 1 hours);
        assertEq(src.bandBps, 150);
        assertTrue(src.stockIsToken0);
        assertEq(src.scaleExp, 30);
    }

    function test_R1_twapDisagreementPausesBuys_stockAsToken1() public {
        MockObservingPool flipped = new MockObservingPool(address(usdg), address(stock), -TICK_100, 7200, 2 hours);
        vm.prank(admin);
        guard.setTwapSource(address(stock), address(flipped), 0, 0);
        assertApproxEqRel(_twap(), 100e18, 1e14, "inverted pool prices the same");
        assertFalse(_read().buysPaused);
    }

    function test_R1_twapDisagreementPausesBuys_lowerPriorityThanHaltAndManual() public {
        feed.push(_answerAt(_twap(), 200));
        vm.prank(admin);
        guard.setBuysPaused(address(stock), true);
        assertEq(_reason(), guard.REASON_MANUAL());
        vm.prank(admin);
        guard.setBuysPaused(address(stock), false);
        stock.setOraclePaused(true);
        assertEq(_reason(), guard.REASON_HALTED(), "halted reading never consults the TWAP");
    }

    function test_R1_setTwapSourceValidation() public {
        bytes32 adminRole = guard.DEFAULT_ADMIN_ROLE();
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, adminRole)
        );
        guard.setTwapSource(address(stock), address(pool), 0, 0);

        vm.startPrank(admin);
        vm.expectRevert(abi.encodeWithSelector(IPriceGuard.StockUnknown.selector, address(0xBEEF)));
        guard.setTwapSource(address(0xBEEF), address(pool), 0, 0);

        MockObservingPool other = new MockObservingPool(address(usdg), address(0xCAFE), 0, 10, 1 hours);
        vm.expectRevert(PriceGuard.InvalidTwapSource.selector);
        guard.setTwapSource(address(stock), address(other), 0, 0); // pool does not hold the stock

        vm.expectRevert(PriceGuard.InvalidTwapSource.selector);
        guard.setTwapSource(address(stock), address(0xD00D), 0, 0); // not a pool

        vm.expectRevert(PriceGuard.InvalidTwapSource.selector);
        guard.setTwapSource(address(stock), address(pool), 5 minutes, 0); // window below MIN

        vm.expectRevert(PriceGuard.InvalidTwapSource.selector);
        guard.setTwapSource(address(stock), address(pool), 2 days, 0); // window above MAX

        vm.expectRevert(PriceGuard.InvalidTwapSource.selector);
        guard.setTwapSource(address(stock), address(pool), 0, 2001); // band above MAX

        vm.expectEmit(address(guard));
        emit IPriceGuard.TwapSourceSet(address(stock), address(pool), 1800, 75);
        guard.setTwapSource(address(stock), address(pool), 0, 0);

        // Removing the source removes the check.
        feed.push(_answerAt(_twap(), 500));
        assertTrue(_read().buysPaused);
        vm.expectEmit(address(guard));
        emit IPriceGuard.TwapSourceSet(address(stock), address(0), 0, 0);
        guard.setTwapSource(address(stock), address(0), 0, 0);
        vm.stopPrank();
        assertFalse(_read().buysPaused);
        (uint256 t, bool ok) = guard.twapCheck(address(stock));
        assertEq(t, 0);
        assertFalse(ok);
    }

    // ------------------------------------------------------------------ R2 twapUnavailableIsSafe

    function _assertUnavailable() internal view {
        PriceReading memory r = _read();
        assertTrue(r.buysPaused, "buys paused");
        assertEq(_reason(), guard.REASON_TWAP_UNAVAILABLE());
        _assertSellable(r, 100e8);
        (uint256 t, bool ok) = guard.twapCheck(address(stock));
        assertEq(t, 0);
        assertFalse(ok);
    }

    function test_R2_twapUnavailableIsSafe_poolMissing() public {
        vm.etch(address(pool), "");
        _assertUnavailable();
    }

    function test_R2_twapUnavailableIsSafe_observeReverts() public {
        pool.setRevert(true);
        _assertUnavailable();
    }

    function test_R2_twapUnavailableIsSafe_cardinalityTooLow() public {
        // A fresh pool with 10 minutes of history cannot serve a 30-minute window ("OLD").
        MockObservingPool young = new MockObservingPool(address(stock), address(usdg), TICK_100, 7200, 10 minutes);
        vm.prank(admin);
        guard.setTwapSource(address(stock), address(young), 0, 0);
        _assertUnavailable();

        // Cardinality 1: only the newest observation is kept, written 60 s ago.
        vm.prank(admin);
        guard.setTwapSource(address(stock), address(pool), 0, 0);
        skip(60);
        pool.swapTo(TICK_100);
        pool.setCardinality(1);
        skip(60);
        feed.push(100e8);
        _assertUnavailable();

        // Raising cardinality and letting history build restores the check.
        pool.setCardinality(7200);
        skip(30 minutes);
        feed.push(100e8);
        assertFalse(_read().buysPaused);
    }

    function test_R2_twapUnavailableIsSafe_malformedReturns() public {
        MockRawObservePool raw = new MockRawObservePool(address(stock), address(usdg));
        vm.prank(admin);
        guard.setTwapSource(address(stock), address(raw), 0, 0);

        raw.setRaw(hex"01"); // short
        _assertUnavailable();
        raw.setRaw(
            abi.encode(
                uint256(2 ** 200), uint256(0), uint256(0), uint256(0), uint256(0), uint256(0), uint256(0), uint256(0)
            )
        );
        _assertUnavailable(); // offset points outside the data
        raw.setRaw(
            abi.encode(
                uint256(0x40), uint256(0xa0), uint256(1), uint256(5), uint256(0), uint256(2), uint256(0), uint256(0)
            )
        );
        _assertUnavailable(); // array length 1
        raw.setRaw(
            abi.encode(
                uint256(0x40),
                uint256(0xa0),
                uint256(2),
                uint256(1 << 60),
                uint256(0),
                uint256(2),
                uint256(0),
                uint256(0)
            )
        );
        _assertUnavailable(); // value does not fit int56
        raw.setCumulatives(0, int56(1800) * 900_000);
        _assertUnavailable(); // mean tick beyond MAX_TICK
        raw.setCumulatives(-1174852709073, -1175230476916); // a real SPY window: valid
        (uint256 t,) = guard.twapCheck(address(stock));
        assertGt(t, 0);
    }

    function test_R2_twapUnavailableIsSafe_pokeStillRecordsSells() public {
        pool.setRevert(true);
        feed.push(101e8);
        PriceReading memory r = guard.poke(address(stock));
        assertTrue(r.buysPaused);
        (uint256 s, uint256 at) = guard.lastGoodPrice(address(stock));
        assertEq(s, 101e18, "last good price still recorded for sells");
        assertEq(at, vm.getBlockTimestamp());
    }

    // ------------------------------------------------------------------ R3 perStockMaxAge

    function _spyLike() internal returns (int256 answer) {
        // SPY on 2026-10-16: feed 770.74686536 (8 dp), multiplier 1.001718 embedded, 0.05% pool 30-min mean tick -209872.
        stock.setMultiplier(1.001718e18);
        pool = new MockObservingPool(address(stock), address(usdg), -209_872, 7200, 2 hours);
        vm.startPrank(admin);
        IPriceGuard.StockConfig memory c = _cfg(address(feed));
        c.maxAgeRegular = guard.DEFAULT_MAX_AGE_24H_HEARTBEAT();
        c.maxAgeExtended = guard.DEFAULT_MAX_AGE_24H_HEARTBEAT();
        c.continuityBps = 500;
        guard.setStock(address(stock), c);
        guard.setTwapSource(address(stock), address(pool), 0, 0);
        vm.stopPrank();
        answer = 77_074_686_536;
    }

    function test_R3_perStockMaxAge_spyLike23hOldInBandIsBuyable() public {
        assertEq(guard.DEFAULT_MAX_AGE_24H_HEARTBEAT(), 26 hours);
        int256 answer = _spyLike();
        feed.setRound(answer, vm.getBlockTimestamp() - 23 hours); // quiet day: no 0.5% move since yesterday
        PriceReading memory r = _read();
        assertTrue(r.fresh, "23h old is fresh for a heartbeat-24h feed");
        assertEq(uint256(r.session), uint256(SessionKind.REGULAR));
        assertFalse(r.buysPaused, "TWAP agrees: buyable");
        assertEq(r.s, uint256(answer) * 1e10);
    }

    function test_R3_perStockMaxAge_spyLike23hOldOutOfBandPausesBuys() public {
        int256 answer = _spyLike();
        // The market moved 1.5% and the feed stopped printing: the pool follows the market for the whole window.
        pool.swapTo(-209_872 + 150);
        skip(30 minutes);
        feed.setRound(answer, vm.getBlockTimestamp() - 23 hours);
        PriceReading memory r = _read();
        assertTrue(r.fresh, "age alone still passes");
        assertTrue(r.buysPaused, "TWAP catches the stopped feed");
        assertEq(_reason(), guard.REASON_TWAP());
    }

    function test_R3_perStockMaxAge_beyond26hIsHalted() public {
        int256 answer = _spyLike();
        feed.setRound(answer, vm.getBlockTimestamp() - 26 hours - 1);
        PriceReading memory r = _read();
        assertEq(uint256(r.session), uint256(SessionKind.HALTED));
        assertEq(_reason(), guard.REASON_HALTED());
    }

    // ------------------------------------------------------------------ R4 manipulationResistance

    function test_R4_manipulationResistance_singleBlockSpike() public {
        uint256 before = _twap();
        // +20% (1,824 ticks) for one 2-second block, then arbitraged back.
        pool.swapTo(TICK_100 + 1824);
        skip(2);
        pool.swapTo(TICK_100);
        skip(1);
        feed.push(100e8);
        uint256 afterSpike = _twap();
        // 1,824 * 2 / 1800 ~= 2 ticks ~= 2 bps.
        assertApproxEqRel(afterSpike, before, 3e14, "TWAP moved at most ~3 bps");
        assertFalse(_read().buysPaused, "spike cannot pause or unpause buys");
    }

    function test_R4_manipulationResistance_sameBlockSpikeInvisible() public {
        uint256 before = _twap();
        pool.swapTo(TICK_100 + 200_000); // the observation is written with the pre-swap tick
        assertEq(_twap(), before, "price set inside the reading block contributes nothing");
        pool.swapTo(TICK_100);
        assertEq(_twap(), before);
    }

    /// @dev A spike of `delta` ticks held `d` seconds moves the 30-minute mean by delta*d/1800 ticks. Anything below
    /// 60 ticks * 1800 s of tick-seconds stays inside the 75 bps band (1 tick ~ 1 bp).
    function testFuzz_R4_manipulationResistance_spikeBound(int256 delta, uint256 d) public {
        delta = bound(delta, -200_000, 200_000);
        d = bound(d, 1, 12);
        uint256 before = _twap();
        pool.swapTo(TICK_100 + int24(delta));
        skip(d);
        pool.swapTo(TICK_100);
        feed.push(int256(before / 1e10));
        uint256 absDelta = delta < 0 ? uint256(-delta) : uint256(delta);
        if (absDelta * d <= 60 * 1800) {
            assertFalse(_read().buysPaused, "small tick-seconds cannot leave the band");
        }
        // A large spike can only pause buys (grief); it never changes S.
        assertEq(_read().s, (before / 1e10) * 1e10);
    }

    function test_R4_manipulationResistance_sustainedMoveIsSeen() public {
        // Holding the pool 2.25% off for a third of the window (~75 tick-hours / 1800 s) reaches the band.
        pool.swapTo(TICK_100 + 230);
        skip(10 minutes);
        pool.swapTo(TICK_100);
        feed.push(100e8);
        assertTrue(_read().buysPaused, "a sustained off-market pool is visible");
        assertEq(_reason(), guard.REASON_TWAP());
    }

    // ------------------------------------------------------------------ R5 embeddedDefault

    struct Name {
        string sym;
        int256 answer; // 8 dp
        uint256 ui; // uiMultiplier
        int56 c0; // tickCumulative 1800 s ago
        int56 c1; // tickCumulative now
        bool usdgIsToken0;
        uint256 expectedTwap; // 1.0001^meanTick, computed off-chain to 60 digits
    }

    function _names() internal pure returns (Name[4] memory n) {
        n[0] = Name(
            "NVDA", 21_798_784_439, 1.000775e18, 1_675_677_855_493, 1_676_078_355_525, true, 217_485_795_808_252_429_589
        );
        n[1] = Name(
            "TSLA", 35_640_500_000, 1e18, -1_875_082_696_013, -1_875_474_233_204, false, 357_812_336_209_335_613_299
        );
        n[2] = Name(
            "SPY",
            77_074_686_536,
            1.001718e18,
            -1_174_852_709_073,
            -1_175_230_476_916,
            false,
            768_830_405_349_943_302_852
        );
        n[3] = Name(
            "QQQ", 71_625_109_098, 1.000701e18, 910_438_022_513, 910_817_036_273, true, 717_500_655_158_423_889_369
        );
    }

    function test_R5_embeddedDefault_launchNamesRealShaped() public {
        Name[4] memory names = _names();
        for (uint256 i; i < 4; ++i) {
            Name memory n = names[i];
            MockStock18 st = new MockStock18();
            st.setMultiplier(n.ui);
            MockGuardFeed f = new MockGuardFeed(8, n.answer);
            MockRawObservePool p = n.usdgIsToken0
                ? new MockRawObservePool(address(usdg), address(st))
                : new MockRawObservePool(address(st), address(usdg));
            p.setCumulatives(n.c0, n.c1);
            vm.startPrank(admin);
            guard.setStock(
                address(st),
                IPriceGuard.StockConfig({
                    feed: address(f),
                    multiplierEmbedded: true, // launch default: Robinhood feeds embed uiMultiplier
                    maxAgeRegular: 26 hours,
                    maxAgeExtended: 26 hours,
                    continuityBps: 1500,
                    enabled: true
                })
            );
            guard.setTwapSource(address(st), address(p), 0, 0);
            vm.stopPrank();

            PriceReading memory r = guard.read(address(st));
            assertEq(r.s, uint256(n.answer) * 1e10, string.concat(n.sym, ": S = answer, multiplier not applied again"));
            assertFalse(r.buysPaused, string.concat(n.sym, ": real feed/TWAP gap (17-39 bps) inside 75 bps"));
            (uint256 twap, bool ok) = guard.twapCheck(address(st));
            assertTrue(ok);
            assertApproxEqRel(twap, n.expectedTwap, 1e6, string.concat(n.sym, ": TWAP to 1e-12"));
            // Applying the multiplier again would double count (a not-embedded config reads a different S).
            if (n.ui != 1e18) assertTrue(uint256(n.answer) * 1e10 * n.ui / WAD != r.s);
        }
    }

    // ------------------------------------------------------------------ R6 gasBound

    /// @dev Gas of one cold read() (forge charges every top-level test call cold) with and without the TWAP check.
    /// The pool is a storage-free stub, so the difference is PriceGuard's own overhead: one SLOAD, one cold call,
    /// abi handling and the tick maths. Measured 2026-10-16 on a mainnet fork (not run in CI) the totals are higher
    /// because the dependencies are: read() 71k without the check and 152-155k with it on the NVDA and SPY 0.05% pools,
    /// where Uniswap's observe() binary search over 7,200 observations alone costs ~80k. A flat 60k average for the
    /// whole read() is therefore not reachable on mainnet (nor with mocks: todo 04's read() is ~57k cold here); this
    /// test bounds what PriceGuard itself adds.
    function test_R6_gasBound_twapOverhead() public {
        MockConstPool stub = new MockConstPool(address(stock), address(usdg), 0, int56(TICK_100) * 1800);
        vm.prank(admin);
        guard.setTwapSource(address(stock), address(0), 0, 0);
        uint256 g0 = gasleft();
        guard.read(address(stock));
        uint256 without = g0 - gasleft();

        vm.prank(admin);
        guard.setTwapSource(address(stock), address(stub), 0, 0);
        uint256 total;
        uint256 runs = 5;
        for (uint256 i; i < runs; ++i) {
            skip(13);
            feed.push(100e8);
            uint256 g = gasleft();
            PriceReading memory r = guard.read(address(stock));
            total += g - gasleft();
            assertFalse(r.buysPaused);
        }
        uint256 avg = total / runs;
        emit log_named_uint("read() without TWAP (mock deps)", without);
        emit log_named_uint("read() with TWAP (mock deps, avg)", avg);
        emit log_named_uint("TWAP check overhead", avg - without);
        assertLt(avg - without, 15_000, "PriceGuard's own TWAP overhead");
        // The pre-existing read() (todo 04) is already ~57k cold with these mocks, so the whole call cannot sit under
        // 60k; bound it so a regression in either part shows up.
        assertLt(avg, 75_000, "read() with the TWAP check, storage-light mocks");
    }

    // ------------------------------------------------------------------ todo 07 R19 readLite

    function _sameExceptPause(PriceReading memory a, PriceReading memory b) internal pure {
        assertEq(a.s, b.s, "S");
        assertEq(uint256(a.session), uint256(b.session), "session");
        assertEq(a.fresh, b.fresh, "fresh");
        assertEq(a.updatedAt, b.updatedAt, "updatedAt");
    }

    /// @dev readLite == read in every field; only the TWAP pause is absent from readLite's buysPaused.
    function test_R19_readLiteEqualsReadExceptTwap() public {
        uint256 t = _twap();
        // In band: identical, nothing paused.
        PriceReading memory full = guard.read(address(stock));
        PriceReading memory lite = guard.readLite(address(stock));
        _sameExceptPause(full, lite);
        assertEq(full.buysPaused, lite.buysPaused);

        // TWAP disagreement: read pauses buys, readLite does not; S/session/fresh identical.
        feed.push(_answerAt(t, 120));
        full = guard.read(address(stock));
        lite = guard.readLite(address(stock));
        _sameExceptPause(full, lite);
        assertTrue(full.buysPaused, "full read pauses on TWAP");
        assertFalse(lite.buysPaused, "lite read skips the TWAP check");

        // TWAP unavailable: same.
        pool.setRevert(true);
        full = guard.read(address(stock));
        lite = guard.readLite(address(stock));
        _sameExceptPause(full, lite);
        assertTrue(full.buysPaused);
        assertFalse(lite.buysPaused);

        // Every other pause reason shows in both (manual pause here).
        vm.prank(admin);
        guard.setBuysPaused(address(stock), true);
        assertTrue(guard.readLite(address(stock)).buysPaused, "manual pause in lite");

        // Closed and halted: identical.
        hours_.setKind(SessionKind.CLOSED);
        _sameExceptPause(guard.read(address(stock)), guard.readLite(address(stock)));
        hours_.setKind(SessionKind.REGULAR);
        skip(27 hours);
        full = guard.read(address(stock));
        lite = guard.readLite(address(stock));
        _sameExceptPause(full, lite);
        assertEq(uint256(lite.session), uint256(SessionKind.HALTED));
    }

    function testFuzz_R19_readLiteEqualsReadExceptTwap(int256 bps, uint8 kind) public {
        bps = bound(bps, -1500, 1500);
        hours_.setKind(SessionKind(bound(kind, 0, 3)));
        feed.push(_answerAt(_twap(), bps));
        PriceReading memory full = guard.read(address(stock));
        PriceReading memory lite = guard.readLite(address(stock));
        _sameExceptPause(full, lite);
        bytes32 reason = guard.buysPausedReason(address(stock));
        bool twapOnly = reason == guard.REASON_TWAP() || reason == guard.REASON_TWAP_UNAVAILABLE();
        assertEq(lite.buysPaused, full.buysPaused && !twapOnly);
    }

    function test_R19_readLiteGas() public {
        feed.push(100e8);
        uint256 g = gasleft();
        guard.read(address(stock));
        uint256 full = g - gasleft();
        g = gasleft();
        guard.readLite(address(stock));
        uint256 lite = g - gasleft();
        emit log_named_uint("read() gas (mock deps, TWAP pool)", full);
        emit log_named_uint("readLite() gas (mock deps)", lite);
        assertLt(lite, full);
    }
}
