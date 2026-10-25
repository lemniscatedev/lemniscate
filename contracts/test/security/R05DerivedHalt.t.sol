// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {PriceGuard} from "../../src/PriceGuard.sol";
import {IPriceGuard} from "../../src/interfaces/IPriceGuard.sol";
import {PriceReading, SessionKind} from "../../src/libs/OptionTypes.sol";
import {MockGuardFeed} from "../mocks/PriceGuardMocks.sol";
import {MockStock18} from "../mocks/TwapMocks.sol";

/// @dev A 24/5 calendar: CLOSED from Friday 20:00 to Sunday 20:00 (UTC stand-in), EXTENDED otherwise, plus closures.
contract MockWeekHours {
    uint256[2][] internal closures;

    function addClosure(uint256 from, uint256 to) external {
        closures.push([from, to]);
    }

    function kindAt(uint256 ts) external view returns (uint256) {
        for (uint256 i; i < closures.length; ++i) {
            if (ts >= closures[i][0] && ts < closures[i][1]) return uint256(SessionKind.CLOSED);
        }
        // 1970-01-01 was a Thursday: day index 1 = Friday.
        uint256 dow = (ts / 1 days + 4) % 7; // 0 = Sunday ... 5 = Friday, 6 = Saturday
        uint256 sod = ts % 1 days;
        if (dow == 6 || (dow == 5 && sod >= 20 hours) || (dow == 0 && sod < 20 hours)) return uint256(SessionKind.CLOSED);
        return uint256(SessionKind.EXTENDED);
    }
}

/// @notice Round-2 review R05 (MEDIUM, on-chain half): haltedSince was latched only inside poke(), and no scheduled job
/// poked a HALTED stock, so a feed that stopped in session read CLOSED at the pre-halt price at the next weekend (the
/// F21 exploit, reopened) and settleHalted never became callable (sells queued forever). PriceGuard now derives the halt
/// start from the feed's own staleness; poke is an optimisation.
contract R05DerivedHaltTest is Test {
    uint256 internal constant WED_10H = 1_790_762_400; // Wednesday 2026-09-23 10:00 UTC
    address internal admin = makeAddr("admin");
    PriceGuard internal guard;
    MockWeekHours internal hours_;
    MockStock18 internal stock;
    MockGuardFeed internal feed;

    function setUp() public {
        vm.warp(WED_10H);
        hours_ = new MockWeekHours();
        stock = new MockStock18();
        feed = new MockGuardFeed(8, 200e8);
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
        guard.poke(address(stock)); // the keeper's last good price: $200, Wednesday 10:00
    }

    /// @dev Reviewer scenario: the SPY feed stops Wednesday 10:00 at $200 and nobody pokes. Friday 20:00 (CLOSED) used
    /// to read CLOSED, fresh, at $200; it now reads HALTED, and the settle clock started Thursday 12:00.
    function test_R05_staleFeedHaltsWithoutAnyPoke() public {
        uint256 staleAt = WED_10H + 26 hours + 1; // Thursday 12:00:01
        vm.warp(WED_10H + 2 days + 10 hours); // Friday 20:00
        assertEq(hours_.kindAt(vm.getBlockTimestamp()), uint256(SessionKind.CLOSED));
        PriceReading memory r = guard.readLite(address(stock));
        assertEq(uint8(r.session), uint8(SessionKind.HALTED), "no CLOSED price for a feed halted in session");
        assertFalse(r.fresh);
        assertEq(guard.haltedSince(address(stock)), staleAt, "halt start derived from the feed");
        // seven days later the stock is settleable (engine.settleHalted reads haltedSince + the delay)
        vm.warp(staleAt + 7 days);
        assertLe(guard.haltedSince(address(stock)) + 7 days, vm.getBlockTimestamp());
        assertEq(uint8(guard.readLite(address(stock)).session), uint8(SessionKind.HALTED), "settleHalted's HALTED read");
        (uint256 lastS,) = guard.lastGoodPrice(address(stock));
        assertEq(lastS, 200e18, "settles at the last good price");
    }

    /// @dev A healthy weekend is not a halt: the last print Friday 19:59, nothing until Sunday 20:00 open.
    function test_R05_normalWeekendIsNotAHalt() public {
        vm.warp(WED_10H + 2 days + 9 hours + 59 minutes); // Friday 19:59
        feed.push(201e8);
        guard.poke(address(stock));
        vm.warp(vm.getBlockTimestamp() + 1 days + 12 hours); // Sunday 07:59, CLOSED
        PriceReading memory r = guard.readLite(address(stock));
        assertEq(uint8(r.session), uint8(SessionKind.CLOSED));
        assertTrue(r.fresh);
        assertEq(guard.haltedSince(address(stock)), 0);
    }

    /// @dev A new round ends the derived halt.
    function test_R05_newRoundEndsTheDerivedHalt() public {
        vm.warp(WED_10H + 30 hours);
        assertGt(guard.haltedSince(address(stock)), 0);
        feed.push(199e8);
        assertEq(guard.haltedSince(address(stock)), 0);
    }

    /// @dev PROPERTY: for any feed that goes stale at an in-session moment t (any stop time, any closure placed around
    /// it), and with no poke ever, every read at a later CLOSED time before a new round is HALTED, and haltedSince is
    /// set no later than the first in-session stale moment, so settleHalted is callable by then + the delay.
    function testFuzz_R05_derivedHaltWithoutPoke(uint256 stopOffset, uint256 later, uint256 closureLen) public {
        stopOffset = bound(stopOffset, 0, 14 days);
        vm.warp(WED_10H + stopOffset);
        feed.push(200e8); // the last round, then the feed stops (only if in session it would have printed)
        uint256 stopAt = vm.getBlockTimestamp();
        closureLen = bound(closureLen, 0, 2 days);
        if (closureLen != 0) hours_.addClosure(stopAt + 30 hours, stopAt + 30 hours + closureLen); // a holiday
        later = bound(later, 26 hours + 1, 20 days);
        vm.warp(stopAt + later);
        // first in-session moment the feed is stale, and the first one that opens 6 h of session (the probe step)
        uint256 firstStale;
        uint256 firstLong;
        for (uint256 t = stopAt + 26 hours + 1; t <= vm.getBlockTimestamp() && firstLong == 0; t += 1 hours) {
            if (hours_.kindAt(t) != uint256(SessionKind.EXTENDED)) continue;
            if (firstStale == 0) firstStale = t;
            bool long_ = true;
            for (uint256 h = 1; h <= 6; ++h) {
                if (hours_.kindAt(t + h * 1 hours) != uint256(SessionKind.EXTENDED)) long_ = false;
            }
            if (long_) firstLong = t;
        }
        uint256 since = guard.haltedSince(address(stock));
        if (firstStale == 0) {
            assertEq(since, 0, "never stale in session yet");
            return;
        }
        if (firstLong != 0 && vm.getBlockTimestamp() >= firstLong + 6 hours) {
            assertGt(since, 0, "derived without a poke");
            assertLe(since, firstLong + 6 hours, "starts within one probe step of a 6 h in-session stretch");
        }
        if (since == 0) return;
        assertGe(since, stopAt + 26 hours, "never before the feed was stale");
        if (hours_.kindAt(vm.getBlockTimestamp()) == uint256(SessionKind.CLOSED)) {
            assertEq(uint8(guard.readLite(address(stock)).session), uint8(SessionKind.HALTED), "CLOSED reads HALTED");
        }
    }
}
