// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {PriceGuard} from "../../src/PriceGuard.sol";
import {MarketHours} from "../../src/MarketHours.sol";
import {IPriceGuard} from "../../src/interfaces/IPriceGuard.sol";
import {Session} from "../../src/libs/LemniscateTypes.sol";
import {PriceReading, SessionKind} from "../../src/libs/OptionTypes.sol";
import {MockGuardFeed} from "../mocks/PriceGuardMocks.sol";
import {MockStock18} from "../mocks/TwapMocks.sol";

/// @notice Round-3 review R3-03 (MEDIUM) and R3-04 (LOW, contract half). R3-03: `_derivedHalt` probes PAST calendar
/// times, but the keeper's sessions job replaces MarketHours' list with future-only sessions, so after a push every past
/// probe reads UNKNOWN. The keeper also skipped latching while the derived start was set. A push in the halt therefore
/// erased the only record of it: F21 reopened (a stale CLOSED/UNKNOWN price) and the ORC-4 settle clock restarted.
/// Fix: `poke` stores the derived start in ANY session, the stored latch only moves earlier, and the keeper decides from
/// the STORED latch. These tests use the real MarketHours and the sessions job's push rule (future-only lists, a push
/// whenever the horizon is under 7 days, pushes landing at session closes).
contract R3_03HaltStartPersistsTest is Test {
    uint256 internal constant WED_10H = 1_790_762_400; // Wednesday 2026-09-23 10:00 UTC (UTC stands in for ET)
    uint256 internal constant SETTLE_DELAY = 7 days;
    uint256 internal constant NO_HOLIDAY = type(uint256).max;

    address internal admin = makeAddr("admin");
    address internal keeper = makeAddr("keeper");
    PriceGuard internal guard;
    MarketHours internal hours_;
    MockStock18 internal stock;
    MockGuardFeed internal feed;
    uint256 internal holiday = NO_HOLIDAY; // day start of one full holiday (a gap from the evening before)

    function setUp() public {
        vm.warp(WED_10H);
        MarketHours impl = new MarketHours();
        hours_ = MarketHours(
            address(new ERC1967Proxy(address(impl), abi.encodeCall(MarketHours.initialize, (admin, keeper))))
        );
        _push(); // the sessions job's first push: sessions closing after now, 30-day / 32-session limit
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
        guard.poke(address(stock)); // last good price $200, Wednesday 10:00
    }

    // ------------------------------------------------------------------ calendar (mirrors computeKindedSessions)

    function _trading(uint256 dayStart) internal view returns (bool) {
        uint256 dow = (dayStart / 1 days + 4) % 7; // 0 = Sunday ... 6 = Saturday
        return dow >= 1 && dow <= 5 && dayStart != holiday;
    }

    /// @dev Per trading day D: EXTENDED (D-1) 20:00 to D 09:30, REGULAR 09:30 to 16:00, EXTENDED 16:00 to 20:00; touching
    /// pieces of the same kind merge. Only sessions closing after now and within 30 days, at most 32 (the keeper's rule).
    function _calendar(uint256 nowTs) internal view returns (Session[] memory out, SessionKind[] memory kinds) {
        Session[] memory p = new Session[](200);
        SessionKind[] memory k = new SessionKind[](200);
        uint256 n;
        uint256 today = nowTs - (nowTs % 1 days);
        for (uint256 day = today - 1 days; day <= today + 32 days; day += 1 days) {
            if (!_trading(day)) continue;
            uint256[3] memory opens = [day - 4 hours, day + 9 hours + 30 minutes, day + 16 hours];
            uint256[3] memory closes = [day + 9 hours + 30 minutes, day + 16 hours, day + 20 hours];
            SessionKind[3] memory ks = [SessionKind.EXTENDED, SessionKind.REGULAR, SessionKind.EXTENDED];
            for (uint256 j; j < 3; ++j) {
                if (n != 0 && k[n - 1] == ks[j] && p[n - 1].close == opens[j]) {
                    p[n - 1].close = uint64(closes[j]);
                } else {
                    p[n] = Session(uint64(opens[j]), uint64(closes[j]));
                    k[n] = ks[j];
                    ++n;
                }
            }
        }
        uint256 m;
        out = new Session[](32);
        kinds = new SessionKind[](32);
        for (uint256 i; i < n && m < 32; ++i) {
            if (p[i].close > nowTs && p[i].close <= nowTs + 30 days) {
                out[m] = p[i];
                kinds[m] = k[i];
                ++m;
            }
        }
        assembly {
            mstore(out, m)
            mstore(kinds, m)
        }
    }

    /// @dev The full calendar's kind at t (no push horizon): true when REGULAR or EXTENDED.
    function _inSessionRef(uint256 t) internal view returns (bool) {
        uint256 day = t - (t % 1 days);
        uint256 sod = t % 1 days;
        if (sod >= 20 hours) return _trading(day + 1 days);
        return _trading(day);
    }

    function _push() internal {
        (Session[] memory s, SessionKind[] memory k) = _calendar(vm.getBlockTimestamp());
        vm.prank(keeper);
        hours_.setSessionsWithKinds(s, k);
    }

    function _horizon() internal view returns (uint256) {
        Session[] memory s = hours_.sessions();
        return s.length == 0 ? 0 : s[s.length - 1].close;
    }

    /// @dev The price upkeep's decision (app/src/keeper/jobs/prices.ts), from the STORED latch: latch a HALTED name that
    /// has none (in session, or out of session when a derived start exists), or whose derived start is earlier; re-poke a
    /// live name that is newer or still carries a latch (R3-04).
    function _keeperPass() internal {
        PriceReading memory r = guard.read(address(stock));
        PriceGuard.StockState memory st = guard.stockState(address(stock));
        uint256 view_ = guard.haltedSince(address(stock));
        uint256 k = uint256(hours_.kindAt(vm.getBlockTimestamp()));
        bool inSession = k <= uint256(SessionKind.EXTENDED);
        bool live = uint8(r.session) <= uint8(SessionKind.EXTENDED);
        if (r.session == SessionKind.HALTED) {
            if ((st.haltedSince == 0 && (inSession || view_ != 0)) || (view_ != 0 && view_ < st.haltedSince)) {
                guard.poke(address(stock));
            }
        } else if (live && r.fresh && !st.contPaused && (st.lastGoodAt < r.updatedAt || st.haltedSince != 0)) {
            guard.poke(address(stock));
        }
    }

    // ------------------------------------------------------------------ regressions (fail before the fix)

    /// @dev Reviewer scenario: SPY stops Wednesday 10:00 at $200; the keeper sees the halt Thursday 13:00 (in session,
    /// derived start Thursday 12:00:01); the sessions job pushes at Friday 20:00 a list that starts Sunday 20:00. Before:
    /// the stored latch was Thursday 13:00 (or nothing), so the start moved later. Now it stays Thursday 12:00:01.
    function test_R3_03_pushAfterInSessionLatchKeepsDerivedStart() public {
        uint256 staleAt = WED_10H + 26 hours + 1;
        vm.warp(WED_10H + 27 hours); // Thursday 13:00, REGULAR
        assertEq(guard.haltedSince(address(stock)), staleAt);
        guard.poke(address(stock));
        assertEq(guard.stockState(address(stock)).haltedSince, staleAt, "poke stores the derived start, not now");
        vm.warp(WED_10H + 2 days + 10 hours); // Friday 20:00: the push lands
        _push();
        assertGt(hours_.sessions()[0].open, staleAt + 2 days, "past sessions deleted");
        vm.warp(WED_10H + 3 days + 12 hours); // Saturday 22:00, UNKNOWN (outside the pushed list, no fallback)
        assertEq(uint8(hours_.kindAt(vm.getBlockTimestamp())), uint8(SessionKind.UNKNOWN));
        assertEq(uint8(guard.readLite(address(stock)).session), uint8(SessionKind.HALTED), "F21 stays closed");
        assertEq(guard.haltedSince(address(stock)), staleAt, "settle clock not restarted");
    }

    /// @dev The keeper sees the halt only out of session (Friday 21:00, before the push). Before: poke stored nothing
    /// outside REGULAR/EXTENDED, the push erased the derived start, and the weekend read UNKNOWN, fresh, at $200.
    function test_R3_03_closedPokeStoresDerivedStartBeforeAPush() public {
        uint256 staleAt = WED_10H + 26 hours + 1;
        vm.warp(WED_10H + 2 days + 11 hours); // Friday 21:00, CLOSED (past the Friday 20:00 close)
        guard.poke(address(stock));
        assertEq(guard.stockState(address(stock)).haltedSince, staleAt, "stored in any session");
        _push();
        vm.warp(WED_10H + 3 days + 12 hours);
        PriceReading memory r = guard.readLite(address(stock));
        assertEq(uint8(r.session), uint8(SessionKind.HALTED));
        assertFalse(r.fresh);
        assertEq(guard.haltedSince(address(stock)), staleAt);
        vm.warp(staleAt + SETTLE_DELAY);
        assertEq(uint8(guard.readLite(address(stock)).session), uint8(SessionKind.HALTED), "settleHalted's HALTED read");
        assertLe(guard.haltedSince(address(stock)) + SETTLE_DELAY, vm.getBlockTimestamp(), "settleable on time");
    }

    /// @dev A latch set later (an in-session issuer pause, no stale feed yet) moves EARLIER to a derived start, never later.
    function test_R3_03_latchOnlyMovesEarlier() public {
        vm.warp(WED_10H + 1 hours);
        stock.setOraclePaused(true);
        guard.poke(address(stock));
        uint256 pausedAt = vm.getBlockTimestamp();
        assertEq(guard.stockState(address(stock)).haltedSince, pausedAt);
        vm.warp(WED_10H + 30 hours); // the feed is stale too now: derived start Thursday 12:00:01 > pausedAt
        guard.poke(address(stock));
        assertEq(guard.stockState(address(stock)).haltedSince, pausedAt, "never later");
    }

    /// @dev Nothing to store: CLOSED with no latch and no derived start stays unlatched (a healthy weekend).
    function test_R3_03_healthyWeekendStoresNothing() public {
        vm.warp(WED_10H + 2 days + 9 hours + 59 minutes); // Friday 19:59
        feed.push(201e8);
        guard.poke(address(stock));
        vm.warp(vm.getBlockTimestamp() + 1 days);
        guard.poke(address(stock));
        assertEq(guard.stockState(address(stock)).haltedSince, 0);
        assertEq(uint8(guard.readLite(address(stock)).session), uint8(SessionKind.CLOSED));
    }

    /// @dev R3-04 (contract half): a transient in-session halt ends with no new feed round; a live poke of the SAME round
    /// clears the latch (the keeper now sends it), so the weekend reads CLOSED, not HALTED.
    function test_R3_04_livePokeWithSameRoundClearsTransientLatch() public {
        vm.warp(WED_10H + 2 days + 5 hours); // Friday 15:00
        feed.push(200e8);
        guard.poke(address(stock));
        stock.setOraclePaused(true);
        _keeperPass();
        assertGt(guard.stockState(address(stock)).haltedSince, 0, "transient halt latched");
        vm.warp(vm.getBlockTimestamp() + 10 minutes);
        stock.setOraclePaused(false); // ends without a new round
        _keeperPass();
        assertEq(guard.stockState(address(stock)).haltedSince, 0, "cleared within one keeper pass");
        vm.warp(WED_10H + 3 days + 2 hours); // Saturday, CLOSED
        assertEq(uint8(guard.readLite(address(stock)).session), uint8(SessionKind.CLOSED));
    }

    // ------------------------------------------------------------------ property

    /// forge-config: default.fuzz.runs = 48
    /// @dev PROPERTY (R3-03): real MarketHours, the sessions job's push rule (future-only lists whenever the horizon is
    /// under 7 days, plus one extra push at a fuzzed session close, any holiday), only the keeper jobs running hourly.
    /// For any in-session stop time: once a halt start is visible it never increases and never disappears while the feed
    /// stays stale; it is no later than the first in-session stale moment that opens 6 h of session, plus 6 h; every
    /// CLOSED/UNKNOWN read after it is HALTED; and settleHalted's conditions hold by start + 7 days.
    function testFuzz_R3_03_haltStartNeverMovesLater(uint256 stopOffset, uint256 extraPush, uint256 holidayPick)
        public
    {
        uint256 base = WED_10H - (WED_10H % 1 days);
        if (holidayPick % 3 != 0) holiday = base + bound(holidayPick, 1, 20) * 1 days; // may be a weekend: then none
        vm.warp(WED_10H + 1);
        _push();
        // the stop: the first in-session hour at or after a fuzzed offset (a feed only prints in session)
        uint256 stopAt = WED_10H + bound(stopOffset, 1 hours, 8 days);
        while (uint256(hours_.kindAt(stopAt)) > uint256(SessionKind.EXTENDED)) stopAt += 1 hours;
        vm.warp(stopAt);
        if (_horizon() < stopAt + 7 days) _push();
        feed.push(200e8);
        guard.poke(address(stock));
        assertEq(guard.stockState(address(stock)).haltedSince, 0);

        // an extra push at a session close after the stale start (a holiday correction, or the horizon rule)
        uint256 extraAt = stopAt + 26 hours + bound(extraPush, 0, 6 days);
        extraAt -= extraAt % 30 minutes; // every session boundary is on a half hour
        while (_inSessionRef(extraAt) || !_inSessionRef(extraAt - 1)) extraAt += 30 minutes;
        extraAt = extraAt - (extraAt % 1 hours) + 1 hours; // the hourly job runs just after the close
        bool extraDone;

        uint256 firstLong;
        for (uint256 t = stopAt + 26 hours + 1; firstLong == 0 && t < stopAt + 12 days; t += 1 hours) {
            if (!_inSessionRef(t)) continue;
            bool long_ = true;
            for (uint256 h = 1; h <= 6; ++h) {
                if (!_inSessionRef(t + h * 1 hours)) long_ = false;
            }
            if (long_) firstLong = t;
        }

        uint256 prev;
        for (uint256 now_ = stopAt + 1 hours; now_ <= stopAt + 14 days; now_ += 1 hours) {
            vm.warp(now_);
            _keeperPass(); // the price upkeep runs every few minutes: before the hourly sessions job here
            if (_horizon() < now_ + 7 days) _push();
            if (!extraDone && now_ >= extraAt) {
                _push();
                extraDone = true;
            }
            uint256 since = guard.haltedSince(address(stock));
            if (prev != 0) {
                assertGt(since, 0, "a halt start never disappears while the feed is stale");
                assertLe(since, prev, "a halt start never moves later");
            }
            if (since != 0) {
                prev = since;
                assertGe(since, stopAt + 26 hours, "never before the feed was stale");
                uint256 k = uint256(hours_.kindAt(now_));
                if (k > uint256(SessionKind.EXTENDED)) {
                    assertEq(uint8(guard.readLite(address(stock)).session), uint8(SessionKind.HALTED), "no stale price");
                }
                if (now_ >= since + SETTLE_DELAY) {
                    assertEq(uint8(guard.readLite(address(stock)).session), uint8(SessionKind.HALTED), "settleable");
                }
            }
            if (firstLong != 0 && now_ >= firstLong + 6 hours) {
                assertGt(since, 0, "halt seen");
                assertLe(since, firstLong + 6 hours, "starts within one probe step");
            }
        }
        assertTrue(extraDone);
    }
}
