// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {PriceGuard} from "../../src/PriceGuard.sol";
import {IPriceGuard} from "../../src/interfaces/IPriceGuard.sol";
import {PriceReading, SessionKind} from "../../src/libs/OptionTypes.sol";
import {MockGuardFeed, MockKindHours} from "../mocks/PriceGuardMocks.sol";
import {MockStock18} from "../mocks/TwapMocks.sol";

/// @notice Review findings F07/F21 (PriceGuard side): a feed that stopped in session read HALTED on weekdays, then
/// CLOSED and fresh at the pre-halt price from Friday 20:00 (and on every holiday), so queued sells filled at it.
contract F07HaltLatchTest is Test {
    uint256 internal constant T0 = 1_790_000_000;

    address internal admin = makeAddr("admin");
    PriceGuard internal guard;
    MockKindHours internal hours_;
    MockStock18 internal stock;
    MockGuardFeed internal feed;

    function setUp() public {
        vm.warp(T0);
        hours_ = new MockKindHours();
        stock = new MockStock18();
        feed = new MockGuardFeed(8, 100e8);
        guard = new PriceGuard(admin, address(hours_), 24 hours, 1 hours);
        vm.prank(admin);
        guard.setStock(
            address(stock),
            IPriceGuard.StockConfig({
                feed: address(feed),
                multiplierEmbedded: true,
                maxAgeRegular: 26 hours,
                maxAgeExtended: 26 hours,
                continuityBps: 1500,
                enabled: true
            })
        );
        guard.poke(address(stock));
    }

    function test_F07_haltedInSessionStaysHaltedWhenClosed() public {
        skip(27 hours); // the feed stopped: older than maxAge in session
        assertEq(uint8(guard.poke(address(stock)).session), uint8(SessionKind.HALTED));
        hours_.setKind(SessionKind.CLOSED); // Friday 20:00 ET
        PriceReading memory r = guard.readLite(address(stock));
        assertEq(uint8(r.session), uint8(SessionKind.HALTED), "a halted feed must not turn into a CLOSED price");
        assertFalse(r.fresh);
        hours_.setKind(SessionKind.UNKNOWN);
        assertEq(uint8(guard.read(address(stock)).session), uint8(SessionKind.HALTED));
    }

    function test_F07_closedLastGoodPriceOlderThanTheBoundReadsHalted() public {
        hours_.setKind(SessionKind.CLOSED);
        skip(4 days); // a long weekend: still the last close
        assertEq(uint8(guard.readLite(address(stock)).session), uint8(SessionKind.CLOSED));
        skip(2 days); // 6 days without a good reading: a dead feed or keeper
        PriceReading memory r = guard.readLite(address(stock));
        assertEq(uint8(r.session), uint8(SessionKind.HALTED), "no CLOSED payout at a 6-day-old price");
        assertFalse(r.fresh);
    }

    function test_F07_liveGoodReadingClearsTheLatch() public {
        skip(27 hours);
        guard.poke(address(stock));
        assertGt(guard.haltedSince(address(stock)), 0);
        feed.push(101e8); // the feed is back
        guard.poke(address(stock));
        assertEq(guard.haltedSince(address(stock)), 0);
        hours_.setKind(SessionKind.CLOSED);
        PriceReading memory r = guard.readLite(address(stock));
        assertEq(uint8(r.session), uint8(SessionKind.CLOSED));
        assertEq(r.s, 101e18);
    }

    function test_F07_maxAgeClosedSetterBounds() public {
        vm.startPrank(admin);
        vm.expectRevert(PriceGuard.InvalidTimer.selector);
        guard.setMaxAgeClosed(1 days);
        guard.setMaxAgeClosed(3 days);
        vm.expectRevert(PriceGuard.InvalidTimer.selector);
        guard.setTradeTwapWindow(30 seconds);
        guard.setTradeTwapWindow(2 minutes);
        vm.stopPrank();
        assertEq(guard.maxAgeClosed(), 3 days);
        assertEq(guard.tradeTwapWindow(), 2 minutes);
    }
}
