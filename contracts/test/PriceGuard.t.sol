// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, Vm} from "forge-std/Test.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {PriceGuard} from "../src/PriceGuard.sol";
import {MarketHours} from "../src/MarketHours.sol";
import {IPriceGuard} from "../src/interfaces/IPriceGuard.sol";
import {PriceReading, SessionKind} from "../src/libs/OptionTypes.sol";
import {Session} from "../src/libs/LemniscateTypes.sol";
import {
    MockGuardFeed,
    MockSwitchingStock,
    MockPausedRevertsStock,
    MockKindHours,
    MockSequencerFeed,
    ReentrantFeed,
    GasBurnerFeed
} from "./mocks/PriceGuardMocks.sol";

contract PriceGuardTest is Test {
    uint256 internal constant T0 = 1_790_000_000; // 2026-09-21
    uint256 internal constant WAD = 1e18;

    address internal admin = makeAddr("admin");
    address internal guardian = makeAddr("guardian");
    address internal stranger = makeAddr("stranger");

    PriceGuard internal guard;
    MockKindHours internal hours_;
    MockSwitchingStock internal stock;
    MockGuardFeed internal feed;

    function setUp() public {
        vm.warp(T0);
        hours_ = new MockKindHours();
        stock = new MockSwitchingStock();
        feed = new MockGuardFeed(8, 100e8);
        guard = new PriceGuard(admin, address(hours_));
        bytes32 guardianRole = guard.GUARDIAN_ROLE();
        vm.startPrank(admin);
        guard.grantRole(guardianRole, guardian);
        guard.setStock(address(stock), _cfg(address(feed), false));
        vm.stopPrank();
    }

    // ------------------------------------------------------------------ helpers

    function _cfg(address feed_, bool embedded) internal pure returns (IPriceGuard.StockConfig memory) {
        return IPriceGuard.StockConfig({
            feed: feed_,
            multiplierEmbedded: embedded,
            maxAgeRegular: 1 hours,
            maxAgeExtended: 4 hours,
            continuityBps: 2000,
            enabled: true
        });
    }

    function _read() internal view returns (PriceReading memory) {
        return guard.read(address(stock));
    }

    function _assertHalted(PriceReading memory r) internal pure {
        assertEq(uint256(r.session), uint256(SessionKind.HALTED), "session HALTED");
        assertFalse(r.fresh, "not fresh");
        assertTrue(r.buysPaused, "buys paused when halted");
    }

    function _assertRelClose(uint256 a, uint256 b) internal pure {
        assertApproxEqRel(a, b, 1e9, "S continuous to 1e-9");
    }

    // ------------------------------------------------------------------ R1 multiplierAppliedOnce

    function test_R1_multiplierAppliedOnce_notEmbedded() public {
        stock.setMultiplier(1.5e18);
        PriceReading memory r = _read();
        assertEq(r.s, 150e18);
        assertEq(uint256(r.session), uint256(SessionKind.REGULAR));
        assertTrue(r.fresh);
        assertFalse(r.buysPaused);
        assertEq(r.updatedAt, T0);
    }

    function test_R1_multiplierAppliedOnce_embedded() public {
        vm.prank(admin);
        guard.setStock(address(stock), _cfg(address(feed), true));
        stock.setMultiplier(1.5e18);
        assertEq(_read().s, 100e18, "embedded feed: S = P, multiplier not applied again");
    }

    function testFuzz_R1_multiplierAppliedOnce(uint64 answer, uint64 multBps, bool embedded) public {
        answer = uint64(bound(answer, 1, 1e14)); // up to $1M at 8 decimals
        multBps = uint64(bound(multBps, 1, 1_000_000)); // 0.0001x .. 100x
        uint256 m = uint256(multBps) * 1e14;
        vm.prank(admin);
        guard.setStock(address(stock), _cfg(address(feed), embedded));
        stock.setMultiplier(m);
        feed.push(int256(uint256(answer)));
        uint256 p = uint256(answer) * 1e10;
        assertEq(_read().s, embedded ? p : p * m / WAD);
    }

    function test_R1_feedDecimalsAboveEighteen() public {
        MockGuardFeed wide = new MockGuardFeed(20, 100e20);
        vm.prank(admin);
        guard.setStock(address(stock), _cfg(address(wide), true));
        assertEq(_read().s, 100e18);
    }

    // ------------------------------------------------------------------ R2 splitLeavesSContinuous

    function test_R2_splitLeavesSContinuous_notEmbedded() public {
        stock.setMultiplier(1.2e18);
        guard.poke(address(stock));
        uint256 before = _read().s;
        assertEq(before, 120e18);

        uint256 eff = T0 + 2 hours;
        stock.schedule(4.8e18, eff); // 4:1 split on top of 1.2
        vm.warp(eff);
        feed.push(25e8); // raw per-share price / 4
        PriceReading memory r = _read();
        _assertRelClose(r.s, before);
        assertEq(uint256(r.session), uint256(SessionKind.REGULAR));
        assertTrue(r.fresh);
        assertTrue(r.buysPaused, "split window still pauses buys");

        vm.warp(eff + 1 hours);
        feed.push(25e8);
        r = guard.poke(address(stock));
        _assertRelClose(r.s, before);
        assertFalse(r.buysPaused, "clears by itself 1h after effectiveAt");
    }

    function test_R2_splitLeavesSContinuous_embedded() public {
        vm.prank(admin);
        guard.setStock(address(stock), _cfg(address(feed), true));
        stock.setMultiplier(1.2e18);
        feed.push(120e8); // feed = per-share 100 x 1.2
        guard.poke(address(stock));
        uint256 before = _read().s;

        uint256 eff = T0 + 2 hours;
        stock.schedule(4.8e18, eff);
        vm.warp(eff);
        feed.push(120e8); // feed adjusts at effectiveAt: per-share 25 x 4.8
        PriceReading memory r = _read();
        _assertRelClose(r.s, before);
        assertTrue(r.fresh);
    }

    function testFuzz_R2_splitLeavesSContinuous(uint8 ratio, uint32 price) public {
        ratio = uint8(bound(ratio, 2, 50));
        price = uint32(bound(price, 1e6, 4e9)); // $0.01 .. $40 at 8 decimals before the split multiple
        int256 p0 = int256(uint256(price) * ratio);
        feed.push(p0);
        guard.poke(address(stock));
        uint256 before = _read().s;

        uint256 eff = T0 + 3 hours;
        stock.schedule(uint256(ratio) * WAD, eff);
        vm.warp(eff);
        feed.push(int256(uint256(price)));
        _assertRelClose(_read().s, before);
    }

    /// Feed reprices before the multiplier switches: S would be 4x off, so the reading is HALTED (sells queue).
    function test_R2_misalignedSplitIsHaltedNotTraded() public {
        guard.poke(address(stock));
        uint256 eff = T0 + 2 hours;
        stock.schedule(4e18, eff);
        vm.warp(eff - 30 minutes);
        feed.push(25e8);
        PriceReading memory r = _read();
        _assertHalted(r);
        assertEq(r.s, 100e18, "last good price, never the 4x-off one");
        // Poke during the misaligned window does not move last good.
        guard.poke(address(stock));
        (uint256 s,) = guard.lastGoodPrice(address(stock));
        assertEq(s, 100e18);
        // Once the multiplier switches the reading is fresh and continuous again.
        vm.warp(eff);
        feed.push(25e8);
        r = _read();
        assertTrue(r.fresh);
        _assertRelClose(r.s, 100e18);
    }

    // ------------------------------------------------------------------ R3 dividendStepRaisesS

    function test_R3_dividendStepRaisesS() public {
        guard.poke(address(stock));
        uint256 before = _read().s;
        stock.schedule(1.005e18, T0 + 1);
        vm.warp(T0 + 1);
        PriceReading memory r = _read();
        assertEq(r.s, before * 1005 / 1000, "S up exactly 0.5%");
        assertFalse(r.buysPaused, "dividend-size step does not pause buys");
        r = guard.poke(address(stock));
        assertFalse(r.buysPaused);
        (uint256 s,) = guard.lastGoodPrice(address(stock));
        assertEq(s, 100.5e18);
    }

    // ------------------------------------------------------------------ R4 pendingSplitPausesBuys

    function test_R4_pendingSplitPausesBuys() public {
        guard.poke(address(stock));
        uint256 eff = T0 + 30 hours;
        stock.schedule(2e18, eff);

        assertFalse(_read().buysPaused, "more than 24h before effectiveAt: open");

        vm.warp(eff - 24 hours - 1);
        feed.push(100e8);
        assertFalse(_read().buysPaused);

        vm.warp(eff - 24 hours);
        feed.push(100e8);
        assertTrue(_read().buysPaused, "inside 24h: paused");
        assertEq(guard.buysPausedReason(address(stock)), guard.REASON_SPLIT());

        vm.warp(eff - 1 hours);
        feed.push(100e8);
        vm.expectEmit(true, false, false, true, address(guard));
        emit IPriceGuard.BuysPausedSet(address(stock), true, guard.REASON_SPLIT());
        guard.poke(address(stock)); // latches the pause until effectiveAt + 1h

        vm.warp(eff);
        feed.push(50e8); // token switched: uiMultiplier == newUIMultiplier == 2
        PriceReading memory r = guard.poke(address(stock));
        assertTrue(r.buysPaused);
        _assertRelClose(r.s, 100e18);

        vm.warp(eff + 1 hours - 1);
        feed.push(50e8);
        assertTrue(guard.poke(address(stock)).buysPaused, "until effectiveAt + 1h");

        vm.warp(eff + 1 hours);
        feed.push(50e8);
        assertFalse(_read().buysPaused, "clears by itself");
        assertFalse(guard.poke(address(stock)).buysPaused);
    }

    /// Without a poke inside the window, the multiplier recorded at the last good reading still pauses after the switch.
    function test_R4_pendingSplitPausesBuysAfterSwitchWithoutLatch() public {
        guard.poke(address(stock));
        uint256 eff = T0 + 2 hours;
        stock.schedule(3e18, eff);
        vm.warp(eff + 30 minutes);
        feed.push(int256(100e8) / 3);
        assertTrue(_read().buysPaused);
        vm.warp(eff + 1 hours);
        feed.push(int256(100e8) / 3);
        assertFalse(_read().buysPaused);
    }

    function test_R4_smallPendingChangeDoesNotPause() public {
        stock.schedule(1.04e18, T0 + 2 hours);
        assertFalse(_read().buysPaused, "4% is dividend class");
        stock.schedule(0.94e18, T0 + 2 hours);
        assertTrue(_read().buysPaused, "6% down is split class");
    }

    // ------------------------------------------------------------------ R5 continuityPausesBuys

    function test_R5_continuityPausesBuys_adminClears() public {
        guard.poke(address(stock));
        vm.warp(T0 + 1 minutes);
        feed.push(150e8); // +50% in one round, no multiplier change
        PriceReading memory r = _read();
        assertTrue(r.fresh, "price itself is fresh");
        assertTrue(r.buysPaused);
        assertEq(guard.buysPausedReason(address(stock)), guard.REASON_CONTINUITY());

        vm.expectEmit(true, false, false, true, address(guard));
        emit IPriceGuard.BuysPausedSet(address(stock), true, guard.REASON_CONTINUITY());
        guard.poke(address(stock));
        assertTrue(guard.stockState(address(stock)).contPaused, "reason latched");
        (uint256 s,) = guard.lastGoodPrice(address(stock));
        assertEq(s, 100e18, "last good not moved by an unconfirmed jump");

        // Guardian cannot clear.
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, guardian, bytes32(0))
        );
        vm.prank(guardian);
        guard.setBuysPaused(address(stock), false);

        vm.prank(admin);
        guard.setBuysPaused(address(stock), false);
        assertFalse(_read().buysPaused);
        (s,) = guard.lastGoodPrice(address(stock));
        assertEq(s, 150e18);
    }

    function test_R5_continuityClearsAfterTwoConfirmingRounds() public {
        guard.poke(address(stock));
        vm.warp(T0 + 1 minutes);
        feed.push(150e8);
        guard.poke(address(stock));
        assertTrue(_read().buysPaused);

        guard.poke(address(stock)); // same round: does not count
        assertEq(guard.stockState(address(stock)).confirmations, 0);

        vm.warp(T0 + 2 minutes);
        feed.push(152e8);
        guard.poke(address(stock));
        assertEq(guard.stockState(address(stock)).confirmations, 1);
        assertTrue(_read().buysPaused, "one round is not enough");

        vm.warp(T0 + 3 minutes);
        feed.push(149e8);
        PriceReading memory r = guard.poke(address(stock));
        assertFalse(r.buysPaused, "two confirming rounds clear it");
        (uint256 s,) = guard.lastGoodPrice(address(stock));
        assertEq(s, 149e18);
    }

    function test_R5_nonConfirmingRoundRestartsCount() public {
        guard.poke(address(stock));
        vm.warp(T0 + 1 minutes);
        feed.push(150e8);
        guard.poke(address(stock));
        vm.warp(T0 + 2 minutes);
        feed.push(151e8);
        guard.poke(address(stock));
        vm.warp(T0 + 3 minutes);
        feed.push(300e8); // another jump: restarts
        guard.poke(address(stock));
        assertEq(guard.stockState(address(stock)).confirmations, 0);
        assertEq(guard.stockState(address(stock)).pendingS, 300e18);
        assertTrue(_read().buysPaused);
    }

    function testFuzz_R5_continuityBand(uint32 newAnswer) public {
        newAnswer = uint32(bound(newAnswer, 1, 4e10)); // up to $400
        guard.poke(address(stock));
        vm.warp(T0 + 1 minutes);
        feed.push(int256(uint256(newAnswer)));
        uint256 s = uint256(newAnswer) * 1e10;
        uint256 diff = s > 100e18 ? s - 100e18 : 100e18 - s;
        bool beyond = diff * 10_000 > 100e18 * 2000;
        PriceReading memory r = guard.poke(address(stock));
        assertEq(r.buysPaused, beyond, "paused iff beyond continuityBps");
        assertTrue(r.fresh, "no multiplier change: the reading itself stays fresh");
        assertEq(guard.stockState(address(stock)).contPaused, beyond);
    }

    function test_R5_moveWithinBandDoesNotPause() public {
        guard.poke(address(stock));
        vm.warp(T0 + 1 minutes);
        feed.push(119e8); // +19% < 20%
        assertFalse(guard.poke(address(stock)).buysPaused);
    }

    // ------------------------------------------------------------------ R6 staleFeedIsHalted

    function test_R6_staleFeedIsHalted() public {
        guard.poke(address(stock));
        vm.warp(T0 + 1 hours);
        assertTrue(_read().fresh, "exactly max age is fresh");
        vm.warp(T0 + 1 hours + 1);
        PriceReading memory r = _read();
        _assertHalted(r);
        assertEq(r.s, 100e18, "HALTED reports last good");
        assertEq(guard.buysPausedReason(address(stock)), guard.REASON_HALTED());
    }

    function test_R6_extendedUsesItsOwnMaxAge() public {
        vm.warp(T0 + 2 hours);
        _assertHalted(_read());
        hours_.setKind(SessionKind.EXTENDED);
        PriceReading memory r = _read();
        assertEq(uint256(r.session), uint256(SessionKind.EXTENDED));
        assertTrue(r.fresh);
        vm.warp(T0 + 4 hours + 1);
        _assertHalted(_read());
    }

    function test_R6_badAnswersAreHalted() public {
        feed.push(0);
        _assertHalted(_read());
        feed.push(-1);
        _assertHalted(_read());
        feed.setRound(100e8, T0 + 1); // updatedAt in the future
        _assertHalted(_read());
        feed.setRound(100e8, 0);
        _assertHalted(_read());
        feed.setRound(type(int256).max, T0); // absurd answer
        _assertHalted(_read());
    }

    function test_R6_oraclePausedIsHalted() public {
        stock.setOraclePaused(true);
        _assertHalted(_read());
        hours_.setKind(SessionKind.CLOSED);
        _assertHalted(_read()); // issuer pause halts in every session
    }

    function test_R6_oraclePausedRevertingIsHalted() public {
        MockPausedRevertsStock odd = new MockPausedRevertsStock();
        vm.prank(admin);
        guard.setStock(address(odd), _cfg(address(feed), false));
        _assertHalted(guard.read(address(odd)));
    }

    function test_R6_revertingOrMalformedReadsAreHaltedNeverRevert() public {
        feed.setRevert(true);
        _assertHalted(_read());
        guard.poke(address(stock));
        feed.setRevert(false);
        feed.setShortReturn(true);
        _assertHalted(_read());
        feed.setShortReturn(false);
        stock.setRevert(true);
        _assertHalted(_read());
        stock.setRevert(false);
        assertTrue(_read().fresh);
    }

    function test_R6_calendarFailureIsUnknownNotRevert() public {
        hours_.setRevert(true);
        assertEq(uint256(_read().session), uint256(SessionKind.UNKNOWN));
        hours_.setRevert(false);
        hours_.setGarbage(true);
        assertEq(uint256(_read().session), uint256(SessionKind.UNKNOWN));
        vm.prank(admin);
        guard.setMarketHours(address(0));
        assertEq(uint256(_read().session), uint256(SessionKind.UNKNOWN));
    }

    function test_R6_unknownStockReverts() public {
        vm.expectRevert(abi.encodeWithSelector(IPriceGuard.StockUnknown.selector, stranger));
        guard.read(stranger);
        vm.expectRevert(abi.encodeWithSelector(IPriceGuard.StockUnknown.selector, stranger));
        guard.poke(stranger);
    }

    // ------------------------------------------------------------------ R7 closedReturnsLastClose

    function test_R7_closedReturnsLastClose() public {
        hours_.setKind(SessionKind.CLOSED);
        PriceReading memory r = _read();
        assertEq(uint256(r.session), uint256(SessionKind.CLOSED));
        assertFalse(r.fresh, "no last good price yet");
        assertEq(r.s, 0);

        hours_.setKind(SessionKind.REGULAR);
        guard.poke(address(stock));

        hours_.setKind(SessionKind.CLOSED);
        vm.warp(T0 + 2 days);
        feed.push(110e8);
        r = _read();
        assertEq(uint256(r.session), uint256(SessionKind.CLOSED));
        assertTrue(r.fresh, "fresh = a last good price exists");
        assertEq(r.s, 100e18, "last close, not the live feed");
        assertEq(r.updatedAt, T0);

        guard.poke(address(stock)); // CLOSED poke does not store
        (uint256 s, uint256 at) = guard.lastGoodPrice(address(stock));
        assertEq(s, 100e18);
        assertEq(at, T0);

        hours_.setKind(SessionKind.UNKNOWN);
        r = _read();
        assertEq(uint256(r.session), uint256(SessionKind.UNKNOWN));
        assertEq(r.s, 100e18);

        hours_.setKind(SessionKind.EXTENDED);
        guard.poke(address(stock)); // EXTENDED fresh stores
        (s,) = guard.lastGoodPrice(address(stock));
        assertEq(s, 110e18);
    }

    function test_R7_haltedPokeDoesNotStore() public {
        guard.poke(address(stock));
        vm.warp(T0 + 2 hours);
        feed.setRound(90e8, T0); // old round, now stale
        guard.poke(address(stock));
        (uint256 s,) = guard.lastGoodPrice(address(stock));
        assertEq(s, 100e18);
    }

    // ------------------------------------------------------------------ R8 / R9 with the real calendar

    function _realHours() internal returns (MarketHours mh) {
        MarketHours impl = new MarketHours();
        mh = MarketHours(
            address(new ERC1967Proxy(address(impl), abi.encodeCall(MarketHours.initialize, (admin, admin))))
        );
        vm.prank(admin);
        guard.setMarketHours(address(mh));
    }

    function test_R8_extendedHasSingleProviderMarker_viaGuard() public {
        MarketHours mh = _realHours();
        vm.prank(admin);
        mh.setFallbackEnabled(true);
        // 2026-09-22 (Tue) 21:00 EDT = 2026-09-23T01:00Z: overnight window -> EXTENDED.
        uint256 overnight = 1_790_125_200;
        vm.warp(overnight);
        feed.push(100e8);
        assertEq(uint256(_read().session), uint256(SessionKind.EXTENDED));
        // Same day 10:00 EDT = 14:00Z -> REGULAR.
        vm.warp(1_790_085_600);
        feed.push(100e8);
        assertEq(uint256(_read().session), uint256(SessionKind.REGULAR));
    }

    function test_R9_unknownCalendar() public {
        MarketHours mh = _realHours();
        assertEq(uint256(mh.kindAt(T0)), uint256(SessionKind.UNKNOWN));
        PriceReading memory r = _read();
        assertEq(uint256(r.session), uint256(SessionKind.UNKNOWN));
        assertFalse(r.fresh);
    }

    function test_R9_pushedCalendarCoversAndGapIsClosed() public {
        MarketHours mh = _realHours();
        Session[] memory s = new Session[](2);
        s[0] = Session({open: uint64(T0), close: uint64(T0 + 1 hours)});
        s[1] = Session({open: uint64(T0 + 2 hours), close: uint64(T0 + 3 hours)});
        SessionKind[] memory k = new SessionKind[](2);
        k[0] = SessionKind.REGULAR;
        k[1] = SessionKind.EXTENDED;
        vm.prank(admin);
        mh.setSessionsWithKinds(s, k);
        assertEq(uint256(_read().session), uint256(SessionKind.REGULAR));
        vm.warp(T0 + 90 minutes);
        assertEq(uint256(mh.kindAt(block.timestamp)), uint256(SessionKind.CLOSED));
        vm.warp(T0 + 2 hours);
        feed.push(100e8);
        assertEq(uint256(_read().session), uint256(SessionKind.EXTENDED));
        vm.warp(T0 + 3 hours);
        assertEq(uint256(_read().session), uint256(SessionKind.UNKNOWN), "past the pushed range, no fallback");
    }

    // ------------------------------------------------------------------ R10 accessControl

    function test_R10_accessControl() public {
        IPriceGuard.StockConfig memory cfg = _cfg(address(feed), false);
        bytes32 adminRole = guard.DEFAULT_ADMIN_ROLE();

        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, guardian, adminRole)
        );
        vm.prank(guardian);
        guard.setStock(address(stock), cfg);

        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, adminRole)
        );
        vm.prank(stranger);
        guard.setStock(address(stock), cfg);

        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, guard.GUARDIAN_ROLE()
            )
        );
        vm.prank(stranger);
        guard.setBuysPaused(address(stock), true);

        vm.prank(guardian);
        guard.setBuysPaused(address(stock), true);
        assertTrue(_read().buysPaused);
        assertEq(guard.buysPausedReason(address(stock)), guard.REASON_MANUAL());
        assertTrue(_read().fresh, "guardian pause never stops pricing (sells)");

        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, guardian, adminRole)
        );
        vm.prank(guardian);
        guard.setBuysPaused(address(stock), false);

        vm.prank(admin);
        guard.setBuysPaused(address(stock), false);
        assertFalse(_read().buysPaused);

        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, guardian, adminRole)
        );
        vm.prank(guardian);
        guard.setSequencerFeed(address(1), 1 hours);

        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, guardian, adminRole)
        );
        vm.prank(guardian);
        guard.setMarketHours(address(1));
    }

    function test_R10_setStockValidates() public {
        IPriceGuard.StockConfig memory cfg = _cfg(address(feed), false);
        vm.startPrank(admin);
        cfg.continuityBps = 0;
        vm.expectRevert(PriceGuard.InvalidConfig.selector);
        guard.setStock(address(stock), cfg);
        cfg = _cfg(address(0), false);
        vm.expectRevert(PriceGuard.InvalidConfig.selector);
        guard.setStock(address(stock), cfg);
        cfg = _cfg(address(feed), false);
        cfg.maxAgeRegular = 0;
        vm.expectRevert(PriceGuard.InvalidConfig.selector);
        guard.setStock(address(stock), cfg);
        cfg = _cfg(address(stock), false); // no decimals()
        vm.expectRevert(PriceGuard.InvalidConfig.selector);
        guard.setStock(address(stock), cfg);
        vm.stopPrank();
    }

    function test_R10_disabledStockPausesBuysButStillPrices() public {
        IPriceGuard.StockConfig memory cfg = _cfg(address(feed), false);
        cfg.enabled = false;
        vm.prank(admin);
        guard.setStock(address(stock), cfg);
        PriceReading memory r = _read();
        assertTrue(r.buysPaused);
        assertTrue(r.fresh);
        assertEq(guard.buysPausedReason(address(stock)), guard.REASON_DISABLED());
    }

    function test_R10_keeperBoundsOnMarketHours() public {
        MarketHours mh = _realHours();
        Session[] memory s = new Session[](33);
        SessionKind[] memory k = new SessionKind[](33);
        for (uint256 i; i < 33; ++i) {
            s[i] = Session({open: uint64(T0 + i * 10), close: uint64(T0 + i * 10 + 5)});
        }
        vm.expectRevert(abi.encodeWithSelector(bytes4(keccak256("TooManySessions(uint256)")), 33));
        vm.prank(admin);
        mh.setSessionsWithKinds(s, k);

        s = new Session[](1);
        k = new SessionKind[](1);
        s[0] = Session({open: uint64(T0), close: uint64(T0 + 5 days + 1 hours + 1)});
        vm.expectRevert(abi.encodeWithSelector(bytes4(keccak256("SessionTooLong(uint256)")), 0));
        vm.prank(admin);
        mh.setSessionsWithKinds(s, k);

        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, mh.KEEPER_ROLE()
            )
        );
        vm.prank(stranger);
        mh.setSessionsWithKinds(s, k);
    }

    // ------------------------------------------------------------------ R11 noReadReentrancyOrStateWrite

    function test_R11_readIsViewAndWritesNothing() public {
        guard.poke(address(stock));
        vm.warp(T0 + 1 minutes);
        feed.push(150e8); // a jump read would flag
        vm.record();
        guard.read(address(stock));
        guard.buysPausedReason(address(stock));
        (, bytes32[] memory writes) = vm.accesses(address(guard));
        assertEq(writes.length, 0, "read wrote storage");
    }

    function test_R11_reentrantFeedCannotWrite() public {
        ReentrantFeed evil = new ReentrantFeed();
        vm.prank(admin);
        guard.setStock(address(stock), _cfg(address(evil), true));
        evil.arm(address(guard), address(stock));

        // read: the feed's nested poke runs inside a staticcall, so its SSTOREs revert; state is untouched.
        PriceReading memory r = _read();
        assertEq(r.s, 100e18);
        (uint256 s0, uint256 at0) = guard.lastGoodPrice(address(stock));
        assertEq(s0 + at0, 0, "read left no trace");

        // poke: exactly one LastGoodPriceSet, from the outer call; every nested poke attempt was reverted.
        vm.recordLogs();
        guard.poke(address(stock));
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 sets;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == address(guard) && logs[i].topics[0] == PriceGuard.LastGoodPriceSet.selector) ++sets;
        }
        assertEq(sets, 1);
        (uint256 s,) = guard.lastGoodPrice(address(stock));
        assertEq(s, 100e18);
    }

    function test_R6_gasBurningFeedIsHaltedNotRevert() public {
        GasBurnerFeed burner = new GasBurnerFeed();
        vm.prank(admin);
        guard.setStock(address(stock), _cfg(address(burner), true));
        _assertHalted(_read());
        guard.poke(address(stock));
    }

    // ------------------------------------------------------------------ R12 sequencerFeedOptional

    function test_R12_sequencerFeedOptional() public {
        assertTrue(_read().fresh, "unset: ignored");

        MockSequencerFeed seq = new MockSequencerFeed();
        vm.prank(admin);
        guard.setSequencerFeed(address(seq), 1 hours);

        seq.set(1, T0 - 2 hours); // down
        _assertHalted(_read());

        seq.set(0, T0 - 10 minutes); // back up, inside grace
        _assertHalted(_read());

        seq.set(0, T0 - 1 hours); // grace elapsed
        assertTrue(_read().fresh);

        seq.setRevert(true);
        _assertHalted(_read());

        vm.expectRevert(PriceGuard.InvalidGracePeriod.selector);
        vm.prank(admin);
        guard.setSequencerFeed(address(seq), 1 days + 1);

        vm.prank(admin);
        guard.setSequencerFeed(address(0), 0);
        assertTrue(_read().fresh, "unset again: ignored");
    }
}
