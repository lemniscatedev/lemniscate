// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {EngineBase} from "./EngineBase.sol";
import {IOptionEngine} from "../../src/interfaces/IOptionEngine.sol";
import {LemniscateEngine} from "../../src/LemniscateEngine.sol";
import {EngineStorage} from "../../src/engine/EngineStorage.sol";
import {SessionKind, Speed} from "../../src/libs/OptionTypes.sol";

/// @notice Engine todo R5 (sells never blocked by pauses), R6 (CLOSED sells), R7 (HALTED sell queue), R8 (no
/// round-trip profit), R18 (blocked transfers queue sells).
contract EngineSellTest is EngineBase {
    bytes32 internal callD;
    bytes32 internal putW;

    function setUp() public override {
        super.setUp();
        callD = _list(address(nvda), true, 100e18, DAILY);
        putW = _list(address(nvda), false, 95e18, WEEKLY);
    }

    function _pauseEverything() internal {
        vm.prank(guardian);
        engine.setBuysPaused(true);
        vm.prank(guardian);
        engine.setSeriesBuysPaused(callD, true);
        guard.setPauses(address(nvda), true, true);
        pool.setHedgeStale(true);
        // drawdown pause: record a peak, then drop NAV/share 20%
        engine.pokeRisk();
        skip(1 hours);
        pool.setNavAdjust(-int256(POOL_CASH * 1e12 / 5));
        engine.pokeRisk();
        (, , bool dd,) = engine.flags();
        assertTrue(dd, "drawdown pause on");
    }

    // ----------------------------------------------------------------------------------------------------- R5

    function test_R5_sellNeverBlockedByPauses() public {
        (, uint256 tokens) = _buy(alice, callD, 100e18);
        _pauseEverything();
        vm.expectRevert(abi.encodeWithSelector(IOptionEngine.BuysArePaused.selector, bytes32("GLOBAL")));
        vm.prank(alice);
        engine.buy(callD, 1e18, type(uint128).max, uint64(vm.getBlockTimestamp()), alice);
        uint256 got = _sell(alice, callD, tokens);
        assertGt(got, 0);
        assertEq(_token(callD).balanceOf(alice), 0);
    }

    function testFuzz_R5_sellNeverBlockedByPauses(uint8 flags, uint8 session) public {
        (, uint256 tokens) = _buy(alice, callD, 100e18);
        SessionKind sk = SessionKind(bound(session, 0, 3)); // REGULAR, EXTENDED, CLOSED, UNKNOWN
        if (flags & 1 != 0) {
            vm.prank(guardian);
            engine.setBuysPaused(true);
        }
        if (flags & 2 != 0) {
            vm.prank(guardian);
            engine.setSeriesBuysPaused(callD, true);
        }
        if (flags & 4 != 0) guard.setPauses(address(nvda), true, true);
        if (flags & 8 != 0) pool.setHedgeStale(true);
        if (flags & 16 != 0) {
            engine.pokeRisk();
            skip(1 hours);
            pool.setNavAdjust(-int256(POOL_CASH * 1e12 / 5));
            engine.pokeRisk();
        }
        if (flags & 32 != 0) skip(3 days); // stale vol is irrelevant here (far validUntil); time passes
        guard.setSession(address(nvda), sk);
        uint256 before = usdg.balanceOf(alice);
        uint256 got = _sell(alice, callD, tokens);
        assertEq(usdg.balanceOf(alice), before + got);
        assertEq(_token(callD).balanceOf(alice), 0, "sold, not queued");
        assertEq(engine.ticketCount(), 0);
    }

    // ----------------------------------------------------------------------------------------------------- R6

    /// @dev Friday close -> weekend -> Monday: sells at the last good S, posted (weekend-bumped) sigma, 3x spread.
    function test_R6_closedSell() public {
        (, uint256 tokens) = _buy(alice, putW, 200e18);
        // Friday close: the guard reports CLOSED at the last good price; the vol engine posts a weekend-bumped sigma.
        guard.set(address(nvda), 98e18, SessionKind.CLOSED, true);
        vol.set(address(nvda), Speed.WEEKLY, 6500, 0, uint64(vm.getBlockTimestamp() + 3650 days));
        skip(1 days);
        engine.accrue(putW);
        uint256 units = Math.mulDiv(tokens, registry.seriesOf(putW).norm, WAD);
        IOptionEngine.Quote memory q = engine.quote(putW, units, false);
        assertEq(uint8(q.session), uint8(SessionKind.CLOSED));
        assertEq(q.sigmaBps, 6500, "weekend sigma as posted");
        // spread = 3 x (150 + 250 x |95/98 - 1| / 0.3) bps
        uint256 away = Math.mulDiv(3e18, WAD, 98e18);
        uint256 baseWad = 150e18 + 250 * Math.mulDiv(away, 10_000, 3000);
        assertEq(q.spreadBps, (baseWad * 3 + WAD / 2) / WAD);
        uint256 got = _sell(alice, putW, tokens);
        assertEq(got, q.usdg);
        // The same sell in REGULAR would have paid more (1x spread).
        assertEq(engine.ticketCount(), 0);
        // Monday open: buys again, sells at 1x.
        skip(2 days);
        guard.set(address(nvda), 97e18, SessionKind.REGULAR, true);
        (, tokens) = _buy(alice, putW, 10e18);
        IOptionEngine.Quote memory qr = engine.quote(putW, 10e18, false);
        assertEq(uint8(qr.session), uint8(SessionKind.REGULAR));
    }

    function test_R6_closedSpreadIsThreeTimesRegular() public {
        (, uint256 tokens) = _buy(alice, callD, 100e18);
        uint256 regular = engine.quote(callD, tokens, false).usdg;
        guard.setSession(address(nvda), SessionKind.CLOSED);
        IOptionEngine.Quote memory q = engine.quote(callD, tokens, false);
        assertEq(q.spreadBps, 450);
        assertLt(q.usdg, regular);
        guard.setSession(address(nvda), SessionKind.UNKNOWN);
        assertEq(engine.quote(callD, tokens, false).spreadBps, 450);
        guard.setSession(address(nvda), SessionKind.EXTENDED);
        assertEq(engine.quote(callD, tokens, false).spreadBps, 225);
    }

    // ----------------------------------------------------------------------------------------------------- R7

    function test_R7_haltedSellQueue() public {
        (, uint256 tokens) = _buy(alice, callD, 100e18);
        guard.setSession(address(nvda), SessionKind.HALTED);
        vm.expectEmit(true, true, true, true, address(engine));
        emit IOptionEngine.SellQueued(1, callD, alice, bob, uint128(tokens), uint64(vm.getBlockTimestamp()));
        vm.prank(alice);
        uint256 got = engine.sell(callD, uint128(tokens), 0, uint64(vm.getBlockTimestamp()), bob);
        assertEq(got, 0);
        assertEq(_token(callD).balanceOf(alice), 0);
        assertEq(_token(callD).balanceOf(address(engine)), tokens, "escrowed in the engine");
        assertEq(engine.ticketCount(), 1);

        // Cannot fill while HALTED.
        vm.expectRevert(abi.encodeWithSelector(IOptionEngine.QueueNotFillable.selector, 1));
        engine.fillQueued(1);

        // Escrowed tokens keep paying funding.
        uint256 n0 = registry.seriesOf(callD).norm;
        skip(6 hours);
        engine.accrue(callD);
        assertLt(registry.seriesOf(callD).norm, n0);

        // HALTED clears: anyone fills at the first fresh price, proceeds to the seller's recipient.
        guard.setSession(address(nvda), SessionKind.REGULAR);
        uint256 units = Math.mulDiv(tokens, registry.seriesOf(callD).norm, WAD);
        uint256 q = engine.quote(callD, units, false).usdg;
        uint256 bobBefore = usdg.balanceOf(bob);
        address filler = makeAddr("filler");
        vm.expectEmit(true, false, false, true, address(engine));
        emit IOptionEngine.QueuedSellFilled(1, filler, q);
        vm.prank(filler);
        assertEq(engine.fillQueued(1), q);
        assertEq(usdg.balanceOf(bob), bobBefore + q);
        assertEq(_token(callD).balanceOf(address(engine)), 0);
        assertEq(_token(callD).totalSupply(), 0);
        vm.expectRevert(abi.encodeWithSelector(IOptionEngine.QueueNotFillable.selector, 1));
        engine.fillQueued(1);
    }

    function test_R7_sellerCancelsBeforeFill() public {
        (, uint256 tokens) = _buy(alice, callD, 100e18);
        guard.setSession(address(nvda), SessionKind.HALTED);
        _sell(alice, callD, tokens);
        vm.expectRevert(abi.encodeWithSelector(IOptionEngine.NotTicketSeller.selector, 1));
        vm.prank(bob);
        engine.cancelQueued(1);
        vm.expectEmit(true, false, false, false, address(engine));
        emit IOptionEngine.QueuedSellCancelled(1);
        vm.prank(alice);
        engine.cancelQueued(1);
        assertEq(_token(callD).balanceOf(alice), tokens);
        assertEq(_token(callD).balanceOf(address(engine)), 0);
        guard.setSession(address(nvda), SessionKind.REGULAR);
        vm.expectRevert(abi.encodeWithSelector(IOptionEngine.QueueNotFillable.selector, 1));
        engine.fillQueued(1);
        EngineStorage.Ticket memory t = engine.queuedSell(1);
        assertFalse(t.open);
    }

    // ----------------------------------------------------------------------------------------------------- R8

    function testFuzz_R8_noRoundTripProfit(uint256 units, uint256 k, bool isCall, bool weekly, uint8 session, uint256 s)
        public
    {
        units = bound(units, 1e12, 300e18);
        k = bound(k, 80e18, 120e18);
        s = bound(s, 90e18, 110e18);
        SessionKind sk = SessionKind(bound(session, 0, 1)); // buys exist only in REGULAR / EXTENDED
        uint32 tau = weekly ? WEEKLY : DAILY;
        bytes32 id = registry.idOf(address(nvda), isCall, uint128(k), tau);
        if (registry.seriesOf(id).token == address(0)) id = _list(address(nvda), isCall, uint128(k), tau);
        // Some existing book so the inventory term is live.
        _buy(bob, callD, 500e18);
        guard.set(address(nvda), s, sk, true);
        (uint256 cost, uint256 tokens) = _buy(alice, id, units);
        uint256 got = _sell(alice, id, tokens);
        assertLe(got, cost, "same-block round trip never profits");
    }

    /// @dev A stale vol post prices sells at sigma x 1.2, but it also blocks buys, and staleness is a function of the
    /// timestamp only: within one block both legs see the same post, so the bumped sell has no buy leg to pair with.
    function test_R8_staleVolBlocksTheBuyLeg() public {
        (, uint256 tokens) = _buy(alice, callD, 100e18);
        skip(1);
        vol.set(address(nvda), Speed.DAILY, 5000, 0, uint64(vm.getBlockTimestamp() - 1));
        vm.expectRevert(IOptionEngine.StaleVol.selector);
        vm.prank(bob);
        engine.buy(callD, 1e18, type(uint128).max, uint64(vm.getBlockTimestamp()), bob);
        IOptionEngine.Quote memory q = engine.quote(callD, tokens, false); // units ~ tokens (one second of funding)
        assertEq(q.sigmaBps, 6000);
        assertApproxEqRel(_sell(alice, callD, tokens), q.usdg, 1e14);
    }

    // ---------------------------------------------------------------------------------------------------- R18

    function test_R18_blockedTransfersQueueSells() public {
        (, uint256 tokens) = _buy(alice, callD, 100e18);
        usdg.setPaused(true); // issuer pause: the pool cannot pay
        vm.prank(alice);
        uint256 got = engine.sell(callD, uint128(tokens), 0, uint64(vm.getBlockTimestamp()), alice);
        assertEq(got, 0);
        assertEq(engine.ticketCount(), 1, "queued, not reverted and not lost");
        assertEq(_token(callD).balanceOf(address(engine)), tokens);
        // Buys revert while USDG is paused.
        vm.expectRevert();
        vm.prank(bob);
        engine.buy(callD, 1e18, type(uint128).max, uint64(vm.getBlockTimestamp()), bob);
        // Filling while still paused reverts and keeps the ticket open.
        vm.expectRevert();
        engine.fillQueued(1);
        assertTrue(engine.queuedSell(1).open);
        // Issuer unpauses: the ticket fills.
        usdg.setPaused(false);
        uint256 before = usdg.balanceOf(alice);
        uint256 out = engine.fillQueued(1);
        assertGt(out, 0);
        assertEq(usdg.balanceOf(alice), before + out);
    }

    function test_R18_blockedRecipientQueues() public {
        (, uint256 tokens) = _buy(alice, callD, 100e18);
        usdg.setBlocked(bob, true);
        vm.prank(alice);
        assertEq(engine.sell(callD, uint128(tokens), 0, uint64(vm.getBlockTimestamp()), bob), 0);
        assertTrue(engine.queuedSell(1).open);
        // The seller takes the tokens back and sells to herself instead.
        vm.prank(alice);
        engine.cancelQueued(1);
        assertGt(_sell(alice, callD, tokens), 0);
    }

    function test_R18_poolPayFailureQueues() public {
        (, uint256 tokens) = _buy(alice, callD, 100e18);
        pool.setFailPay(true);
        assertEq(_sell(alice, callD, tokens), 0);
        assertTrue(engine.queuedSell(1).open);
        pool.setFailPay(false);
        assertGt(engine.fillQueued(1), 0);
    }
}
