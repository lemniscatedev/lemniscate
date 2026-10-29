// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {SystemFixture} from "../system/SystemFixture.sol";
import {MockObservingPool} from "../mocks/TwapMocks.sol";
import {IOptionEngine} from "../../src/interfaces/IOptionEngine.sol";
import {EngineMarkLib} from "../../src/engine/EngineMarkLib.sol";

/// @notice Audit 2026-10-29 M-2, fail closed: when a stock's trade TWAP source is set but cannot serve any window, a
/// sell is escrowed (never settled at a stale S) and its queued fill waits; LP entries wait too. Real engine and pool.
contract TwapLostFailsClosedTest is SystemFixture {
    int24 internal constant TICK_100 = -230_270;
    bytes32 internal id;
    uint256 internal tokens;

    function setUp() public {
        _deploySystem(1, 200_000e6);
        _lowMinTrade();
        MockObservingPool healthy = new MockObservingPool(address(stocks[0]), address(usdg), TICK_100, 7200, 2 hours);
        vm.prank(admin);
        guard.setTwapSource(address(stocks[0]), address(healthy), 0, 0);
        id = _list(0, true, 100e18, DAILY);
        (, tokens) = _buy(alice, id, 100e18);
        engine.accrue(id); // marks the series into the LP-boundary liability
        // The source becomes unservable: a ring that covers only a few seconds.
        MockObservingPool tiny = new MockObservingPool(address(stocks[0]), address(usdg), TICK_100, 4, 2);
        vm.prank(admin);
        guard.setTwapSource(address(stocks[0]), address(tiny), 0, 0);
        assertTrue(guard.tradeTwapLost(address(stocks[0])));
    }

    function test_M2_sellIsEscrowedWhenTwapLost() public {
        vm.expectEmit(false, true, true, false, address(engine));
        emit IOptionEngine.SellQueued(0, id, alice, alice, 0, 0);
        uint256 proceeds = _sell(alice, id, tokens);
        assertEq(proceeds, 0, "no settlement at a stale price");
    }

    function test_M2_lpDepositWaitsWhenTwapLost() public {
        usdg.mint(lp, 1_000e6);
        vm.startPrank(lp);
        usdg.approve(address(pool), 1_000e6);
        vm.expectRevert(abi.encodeWithSelector(EngineMarkLib.TwapLost.selector, address(stocks[0])));
        pool.deposit(1_000e6, lp);
        vm.stopPrank();
    }

    function test_M2_exitBoundWaitsWhenTwapLost() public {
        vm.expectRevert(abi.encodeWithSelector(EngineMarkLib.TwapLost.selector, address(stocks[0])));
        engine.navLiability(true);
    }
}
