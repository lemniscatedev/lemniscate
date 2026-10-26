// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IOptionEngine} from "../../src/interfaces/IOptionEngine.sol";
import {SessionKind} from "../../src/libs/OptionTypes.sol";
import {LemniscateEngine} from "../../src/LemniscateEngine.sol";
import {EngineOpsLib} from "../../src/engine/EngineOpsLib.sol";
import {EngineStorage} from "../../src/engine/EngineStorage.sol";
import {EngineBase} from "../engine/EngineBase.sol";

/// @notice S-3: the lane-A fixes attacked as new code, with the checklist scenarios (market closed, sybils, permanent
/// hold, one bad user, dust), plus the ORC-4 settlement and dust retirement paths.
contract FixAScenariosTest is EngineBase {
    uint256 internal constant UNITS = 10_000e18;
    address internal carol = makeAddr("carol");

    function _sellQuote(bytes32 id, uint256 units, address who) internal view returns (uint256) {
        return engine.quoteFor(id, units, false, who).usdg;
    }

    // ------------------------------------------------------------------------------------------- F01/F02 hold

    function test_F01_holdEndsAfterHoldSeconds_permanentHold() public {
        bytes32 id = _list(address(nvda), true, 100e18, DAILY);
        _buy(alice, id, UNITS);
        guard.setS(address(nvda), 101e18);
        assertLt(_sellQuote(id, 1_000e18, alice), _sellQuote(id, 1_000e18, address(0)), "inside the hold");
        skip(30 minutes + 1);
        assertEq(_sellQuote(id, 1_000e18, alice), _sellQuote(id, 1_000e18, address(0)), "a long holder is not held");
    }

    function test_F01_oneAccountsHoldNeverTouchesAnother_oneBadUser() public {
        bytes32 id = _list(address(nvda), true, 100e18, DAILY);
        _buy(bob, id, UNITS / 2);
        skip(2 hours);
        _buy(alice, id, UNITS / 2);
        guard.setS(address(nvda), 101e18);
        assertEq(_sellQuote(id, 1_000e18, bob), _sellQuote(id, 1_000e18, address(0)), "bob is not held by alice");
        assertLt(_sellQuote(id, 1_000e18, alice), _sellQuote(id, 1_000e18, address(0)));
    }

    function test_F01_holdAppliesWhenMarketClosed() public {
        bytes32 id = _list(address(nvda), true, 100e18, DAILY);
        (, uint256 tokens) = _buy(alice, id, UNITS);
        guard.set(address(nvda), 101e18, SessionKind.CLOSED, true); // last good close above the buy S
        uint256 proceeds = _sell(alice, id, tokens);
        (uint256 v,) = helper.valueAt(true, 100e18, 100e18, 5000, 0, 0, DAILY);
        assertLe(proceeds * 1e12, (UNITS / 1e18) * v, "CLOSED sell inside the hold priced at the buy S at best");
    }

    /// @dev Review R02 replaced this: buying for another account wrote that account's hold, so a stranger could pin
    /// anyone's sell price. Only the buyer itself (or the configured agent router) may now be a buy's recipient.
    function test_F01_buyingForOtherAccountsRefused_sybil() public {
        bytes32 id = _list(address(nvda), true, 100e18, DAILY);
        vm.prank(alice);
        vm.expectRevert(IOptionEngine.NotOwnBuy.selector);
        engine.buy(id, uint128(UNITS), type(uint128).max, uint64(vm.getBlockTimestamp()), carol);
        assertEq(engine.holdOf(id, carol).until, 0);
    }

    function test_F01_smallRebuyCannotLiftTheHoldPrice_dust() public {
        bytes32 id = _list(address(nvda), true, 100e18, DAILY);
        _buy(alice, id, UNITS);
        guard.setS(address(nvda), 101e18);
        _buy(alice, id, 10e18); // a ~$10 buy at 101
        assertEq(engine.holdOf(id, alice).s, 100e18, "the more binding (lower) call S is kept");
    }

    function test_F01_pumpedTwapOnlyRaisesTheBuyersOwnCost() public {
        bytes32 id = _list(address(nvda), true, 100e18, DAILY);
        uint256 fair = engine.quote(id, UNITS, true).usdg;
        guard.setTradeTwap(address(nvda), 150e18); // someone pushed the pool
        uint256 q = engine.quote(id, UNITS, true).usdg;
        assertGt(q, fair);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IOptionEngine.Slippage.selector, q, fair));
        engine.buy(id, uint128(UNITS), uint128(fair), uint64(vm.getBlockTimestamp()), alice);
    }

    function test_F01_tokenHookOnlyFromTheSeriesToken() public {
        bytes32 id = _list(address(nvda), true, 100e18, DAILY);
        _buy(alice, id, UNITS);
        vm.expectRevert(LemniscateEngine.NotSeriesToken.selector);
        engine.onTokenTransfer(id, alice, bob, 1);
    }

    // ------------------------------------------------------------------------------------- F07/F21 ORC-4, queue

    function test_ORC4_settleAfterDelayThenSellsAndFillsGoThrough() public {
        bytes32 id = _list(address(nvda), true, 100e18, DAILY);
        (, uint256 tokens) = _buy(alice, id, UNITS / 2);
        _buy(bob, id, UNITS / 2);
        skip(1 hours);
        guard.setSession(address(nvda), SessionKind.HALTED);
        guard.setHaltedSince(address(nvda), vm.getBlockTimestamp());
        assertEq(_sell(alice, id, tokens), 0, "HALTED: queued");
        uint256 ticket = engine.ticketCount();

        vm.expectRevert(abi.encodeWithSelector(EngineOpsLib.NotSettleable.selector, address(nvda)));
        engine.settleHalted(address(nvda));
        skip(7 days);
        uint256 s = engine.settleHalted(address(nvda));
        assertEq(s, 100e18);
        assertEq(engine.settlePrice(address(nvda)), 100e18);

        uint256 out = engine.fillQueued(ticket);
        assertGt(out, 0, "the queued ticket fills at the settlement price");
        uint256 bobTokens = _token(id).balanceOf(bob);
        assertGt(_sell(bob, id, bobTokens), 0, "a new sell goes through");
        vm.expectRevert(); // buys stay off for a settled stock
        _buy(carol, id, UNITS);
    }

    function test_ORC4_liveReadingEndsTheSettlement() public {
        bytes32 id = _list(address(nvda), true, 100e18, DAILY);
        _buy(alice, id, UNITS);
        guard.setSession(address(nvda), SessionKind.HALTED);
        guard.setHaltedSince(address(nvda), vm.getBlockTimestamp());
        skip(7 days);
        engine.settleHalted(address(nvda));
        guard.setSession(address(nvda), SessionKind.REGULAR);
        engine.accrue(id);
        assertEq(engine.settlePrice(address(nvda)), 0);
    }

    function test_ORC4_settleNeedsAHaltedReading() public {
        guard.setHaltedSince(address(nvda), vm.getBlockTimestamp());
        skip(8 days); // stale latch, but the feed reads REGULAR now
        vm.expectRevert(abi.encodeWithSelector(EngineOpsLib.NotSettleable.selector, address(nvda)));
        engine.settleHalted(address(nvda));
    }

    /// @dev Review R3-03 follow-up: out of session the stored latch reads HALTED even after the feed recovered, so only an
    /// in-session HALTED read settles; a ripe halt in a closure waits for the next open.
    function test_ORC4_settleNeedsTheCalendarInSession() public {
        guard.setSession(address(nvda), SessionKind.HALTED);
        guard.setHaltedSince(address(nvda), vm.getBlockTimestamp());
        skip(8 days);
        for (uint256 k = uint256(SessionKind.CLOSED); k <= uint256(SessionKind.UNKNOWN); ++k) {
            guard.setCalendarKind(SessionKind(k));
            vm.expectRevert(abi.encodeWithSelector(EngineOpsLib.NotSettleable.selector, address(nvda)));
            engine.settleHalted(address(nvda));
        }
        guard.setCalendarKind(SessionKind.EXTENDED);
        assertEq(engine.settleHalted(address(nvda)), 100e18);
    }

    function test_F21_fillNeverBelowTheSellersMinimum() public {
        bytes32 id = _list(address(nvda), true, 100e18, DAILY);
        (, uint256 tokens) = _buy(alice, id, UNITS);
        guard.setSession(address(nvda), SessionKind.HALTED);
        vm.prank(alice);
        engine.sell(id, uint128(tokens), 5_000e6, uint64(vm.getBlockTimestamp()), alice);
        uint256 ticket = engine.ticketCount();
        assertEq(engine.queuedSell(ticket).minProceeds, 5_000e6);
        guard.setSession(address(nvda), SessionKind.CLOSED);
        guard.setTradeTwap(address(nvda), 90e18); // a pushed pool cannot fill alice's ticket at a dump price
        vm.prank(bob);
        vm.expectRevert();
        engine.fillQueued(ticket);
        vm.prank(alice);
        engine.cancelQueued(ticket);
        assertEq(_token(id).balanceOf(alice), tokens);
    }

    // ------------------------------------------------------------------------------------------ F08/F14/F24 dust

    function test_F08_wholeBalanceSellAlwaysAllowed() public {
        bytes32 id = _list(address(nvda), true, 104e18, DAILY);
        (, uint256 tokens) = _buy(alice, id, 50e18); // a few dollars
        skip(5 days); // funding takes it under $1
        engine.accrue(id);
        vm.expectRevert(IOptionEngine.BelowMinimum.selector);
        _sell(alice, id, tokens / 2);
        _sell(alice, id, tokens); // law 4: the whole balance always sells
        assertEq(_token(id).balanceOf(alice), 0);
    }

    function test_F14_haltedPartialDustSellNotQueued() public {
        bytes32 id = _list(address(nvda), true, 100e18, DAILY);
        _buy(alice, id, UNITS);
        guard.setSession(address(nvda), SessionKind.HALTED);
        uint256 before = engine.ticketCount();
        vm.expectRevert(IOptionEngine.BelowMinimum.selector);
        _sell(alice, id, 1);
        assertEq(engine.ticketCount(), before);
    }

    function test_F24_dustSeriesRetiredFromLiveListAndSkipped() public {
        bytes32 id = _list(address(nvda), true, 104e18, DAILY);
        (, uint256 tokens) = _buy(bob, id, 50e18);
        assertEq(engine.liveSeries(address(nvda)).length, 1);
        bytes32[] memory ids = new bytes32[](1);
        ids[0] = id;
        assertEq(engine.retireDust(ids), 0, "not dust yet");
        skip(5 days);
        assertEq(engine.retireDust(ids), 1);
        assertEq(engine.liveSeries(address(nvda)).length, 0);
        // Review R07: the keeper's dust pass still accrues it; bob can still transfer and sell.
        engine.accrueMany(ids);
        assertEq(registry.seriesOf(id).lastAccrual, vm.getBlockTimestamp());
        IERC20 token = _token(id);
        vm.prank(bob);
        token.transfer(carol, tokens);
        _sell(carol, id, tokens);
        // A new buy puts a series back on the list.
        _buy(alice, id, UNITS);
        assertEq(engine.liveSeries(address(nvda)).length, 1);
    }

    function test_guardsBoundsAndDefaults() public {
        (uint64 minTrade, uint32 hold, uint32 settle) = engine.guards();
        assertEq(minTrade, 1e6);
        assertEq(hold, 30 minutes);
        assertEq(settle, 7 days);
        vm.startPrank(admin);
        vm.expectRevert(LemniscateEngine.InvalidGuards.selector);
        engine.setGuards(EngineStorage.Guards({minTradeUsdg: 2_000e6, holdSeconds: 0, haltSettleDelay: 0}));
        vm.expectRevert(LemniscateEngine.InvalidGuards.selector);
        engine.setGuards(EngineStorage.Guards({minTradeUsdg: 0, holdSeconds: 60, haltSettleDelay: 0}));
        vm.expectRevert(LemniscateEngine.InvalidGuards.selector);
        engine.setGuards(EngineStorage.Guards({minTradeUsdg: 0, holdSeconds: 0, haltSettleDelay: 3600}));
        engine.setGuards(EngineStorage.Guards({minTradeUsdg: 5e6, holdSeconds: 1 hours, haltSettleDelay: 2 days}));
        vm.stopPrank();
        (minTrade, hold, settle) = engine.guards();
        assertEq(minTrade, 5e6);
        assertEq(hold, 1 hours);
        assertEq(settle, 2 days);
        vm.expectRevert();
        engine.setGuards(EngineStorage.Guards({minTradeUsdg: 0, holdSeconds: 0, haltSettleDelay: 0}));
    }
}
