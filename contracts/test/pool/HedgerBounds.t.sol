// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {PoolFixture} from "./PoolFixture.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {SessionKind} from "../../src/libs/OptionTypes.sol";
import {PoolHedging} from "../../src/libs/PoolHedging.sol";
import {IPool} from "../../src/interfaces/IPool.sol";

/// @dev Security review 2026-10-17, F03 / F17: the hedger hot key must not be able to set pool NAV (any `ref`), nor
/// brick every NAV path with an overflowing post.
contract HedgerBoundsTest is PoolFixture {
    function setUp() public {
        _deploy();
    }

    /// @dev Alice holds 10% of a 100,000 pool with a matured ticket; the hedger key posts 1,000,000 of "perp equity"
    /// with a non-zero ref. Her claim must not pay above her share of the real NAV.
    function test_F03_hedgerCannotInflateNavWithRef() public {
        _deposit(bob, 90_000 * USDG);
        _deposit(alice, 10_000 * USDG);
        vm.warp(vm.getBlockTimestamp() + 1 days + 1);
        uint256 ticket = _request(alice, pool.balanceOf(alice));
        vm.warp(vm.getBlockTimestamp() + 72 hours);
        uint256 fair = pool.previewRedeem(pool.balanceOf(address(pool)));

        vm.prank(hedger);
        try pool.postHedgeEquity(1_000_000 * USDG, uint64(vm.getBlockTimestamp()), bytes32("x")) {} catch {}
        { (address owner_,,) = pool.ticketOf(ticket); vm.prank(owner_); }
        uint256 paid = pool.claim(ticket);
        assertLe(paid, fair + 1);
        assertGe(usdg.balanceOf(address(pool)), 89_000 * USDG); // Bob's cash is still there
    }

    /// @dev An overflowing post (any ref) must not make NAV, sells, claims or deposits revert.
    function test_F17_hedgerOverflowCannotBrickNav() public {
        _deposit(alice, 10_000 * USDG);
        vm.prank(hedger);
        try pool.postHedgeEquity(type(uint256).max / 1e6, uint64(vm.getBlockTimestamp()), bytes32("x")) {} catch {}
        int256 n = pool.nav();
        assertLe(n, int256(10_000 * USDG * 1e12));
        _deposit(bob, 1_000 * USDG); // deposits still work
        guard.set(address(stock), S0, SessionKind.CLOSED, true); // market closed: same answer
        assertLe(pool.nav(), int256(11_000 * USDG * 1e12));
    }

    /// @dev Perps are off at launch: the cap is 0, so no positive equity can be posted with any ref, even 1 wei.
    function test_F03_perpsOffAtLaunchWhateverRef() public {
        _deposit(alice, 10_000 * USDG);
        (uint16 perpBps,,,) = pool.hedgerLimits();
        assertEq(perpBps, 0);
        vm.startPrank(hedger);
        vm.expectRevert(abi.encodeWithSelector(PoolHedging.PerpEquityCap.selector, 1, 0));
        pool.postHedgeEquity(1, uint64(vm.getBlockTimestamp()), bytes32("dust"));
        pool.postHedgeEquity(0, uint64(vm.getBlockTimestamp()), bytes32("zero")); // zero is always fine
        vm.stopPrank();
    }

    /// @dev With perps on (admin), the hourly bound holds for every ref, and many small posts cannot beat it.
    function test_F17_equityBoundedPerHourWhateverRef() public {
        _deposit(alice, 100_000 * USDG); // cap at 20% = 20,000; 2,000 per hour
        pool.setHedgerLimits(2_000, 50, false);
        vm.startPrank(hedger);
        vm.expectRevert(abi.encodeWithSelector(IPool.HedgeJump.selector, 0, 2_001 * USDG));
        pool.postHedgeEquity(2_001 * USDG, uint64(vm.getBlockTimestamp()), bytes32("fill"));
        pool.postHedgeEquity(2_000 * USDG, uint64(vm.getBlockTimestamp()), bytes32("fill"));
        // 60 posts a minute apart move at most 2,000 in total.
        uint256 e = 2_000 * USDG;
        for (uint256 i; i < 60; ++i) {
            vm.warp(vm.getBlockTimestamp() + 1 minutes);
            e += 2_000 * USDG / 60;
            pool.postHedgeEquity(e, uint64(vm.getBlockTimestamp()), keccak256(abi.encode(i)));
        }
        vm.warp(vm.getBlockTimestamp() + 1 minutes);
        vm.expectRevert();
        pool.postHedgeEquity(e + 100 * USDG, uint64(vm.getBlockTimestamp()), bytes32("x"));
        // A long gap counts as one hour only.
        vm.warp(vm.getBlockTimestamp() + 1 days);
        vm.expectRevert();
        pool.postHedgeEquity(e + 2_001 * USDG, uint64(vm.getBlockTimestamp()), bytes32("x"));
        vm.stopPrank();
    }

    /// @dev The cap is checked again at valuation: lowering it (or a NAV drop) shrinks the counted equity at once.
    function test_F17_capClampsCountedEquity() public {
        _deposit(alice, 100_000 * USDG);
        pool.setHedgerLimits(2_000, 50, false);
        vm.prank(hedger);
        pool.postHedgeEquity(2_000 * USDG, uint64(vm.getBlockTimestamp()), bytes32("fill"));
        int256 withEquity = pool.nav();
        pool.setHedgerLimits(100, 50, false); // 1% of 100,000 = 1,000
        assertApproxEqAbs(pool.nav(), withEquity - int256(1_000 * USDG * 1e12), 1e12);
        pool.setHedgerLimits(0, 50, false);
        assertApproxEqAbs(pool.nav(), withEquity - int256(2_000 * USDG * 1e12), 1e12);
    }

    function test_F17_capSetterBoundedAndAdminOnly() public {
        vm.expectRevert(PoolHedging.InvalidParams.selector);
        pool.setHedgerLimits(2_001, 50, false);
        bytes32 adminRole = pool.GUARDIAN_ROLE(); // non-admin, non-guardian: reported against the guardian role
        vm.prank(hedger);
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, hedger, adminRole)
        );
        pool.setHedgerLimits(100, 50, false);
    }

    /// @dev F27: a compromised hedger sandwiches its own rebalances (pool buys 0.9% over S, sells 0.9% under) in a loop.
    /// The pool's realised loss against the feed price must stay inside the daily budget (0.5% of NAV by default).
    function _sandwichLoop(uint256 rounds) internal returns (uint256 lost) {
        int256 nav0 = pool.nav();
        swapRouter.setRate(address(usdg), address(stock), FEE, uint256(1e48) / 100.9e18);
        swapRouter.setRate(address(stock), address(usdg), FEE, 99.1e18 / 1e12);
        vm.startPrank(hedger);
        for (uint256 i; i < rounds; ++i) {
            try pool.rebalance(address(stock), 100e18, 0) {} catch {}
            try pool.rebalance(address(stock), 0, 0) {} catch {}
        }
        vm.stopPrank();
        _setRouterPrice(S0);
        int256 nav1 = pool.nav();
        lost = nav1 < nav0 ? uint256(nav0 - nav1) / 1e12 : 0;
    }

    function test_F27_sandwichedRebalanceLoopBounded() public {
        _deposit(alice, 100_000 * USDG);
        uint256 lost = _sandwichLoop(50);
        assertLe(lost, 520 * USDG); // 0.5% of NAV plus one trade's overshoot at most
    }

    /// @dev The budget is per UTC day: the next day the hedger can trade again, still inside a fresh budget.
    function test_F27_lossBudgetPerDayAndFairTradesFree() public {
        _deposit(alice, 100_000 * USDG);
        _hedgeTo(100e18); // at the feed price: no realised loss
        (,,, uint256 used) = pool.hedgerLimits();
        assertEq(used, 0);
        _hedgeTo(0);
        uint256 lost = _sandwichLoop(50);
        assertLe(lost, 500 * USDG);
        vm.warp(vm.getBlockTimestamp() + 1 days);
        lost = _sandwichLoop(50);
        assertLe(lost, 500 * USDG);
        (,, bool frozen, uint256 usedToday) = pool.hedgerLimits();
        assertFalse(frozen);
        assertLe(usedToday, 500 * USDG);
    }

    /// @dev The guardian stops every hedger action at once; it cannot unfreeze or change limits; the admin can.
    function test_F27_guardianFreezesHedger() public {
        _deposit(alice, 100_000 * USDG);
        pool.setHedgerLimits(2_000, 50, false);
        vm.prank(guardian);
        pool.setHedgerLimits(0, 0, true); // bps ignored for the guardian
        (uint16 perpBps, uint16 lossBps, bool frozen,) = pool.hedgerLimits();
        assertEq(perpBps, 2_000);
        assertEq(lossBps, 50);
        assertTrue(frozen);
        vm.startPrank(hedger);
        vm.expectRevert(PoolHedging.HedgerFrozen.selector);
        pool.rebalance(address(stock), 10e18, 0);
        vm.expectRevert(PoolHedging.HedgerFrozen.selector);
        pool.postHedgeEquity(0, uint64(vm.getBlockTimestamp()), bytes32("x"));
        vm.stopPrank();
        bytes32 guardianRole = pool.GUARDIAN_ROLE();
        vm.prank(guardian);
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, guardian, guardianRole)
        );
        pool.setHedgerLimits(2_000, 50, false);
        vm.prank(hedger);
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, hedger, guardianRole)
        );
        pool.setHedgerLimits(0, 0, true);
        pool.setHedgerLimits(2_000, 50, false); // admin unfreezes
        _hedgeTo(10e18);
        assertEq(pool.hedgeUnits(address(stock)), 10e18);
    }

    /// @dev Closed market: the hedger cannot trade at all (fresh live price required), so no budget is used.
    function test_F27_closedMarketNoRebalance() public {
        _deposit(alice, 100_000 * USDG);
        guard.set(address(stock), S0, SessionKind.CLOSED, true);
        vm.prank(hedger);
        vm.expectRevert(abi.encodeWithSelector(PoolHedging.StalePrice.selector, address(stock)));
        pool.rebalance(address(stock), 10e18, 0);
    }

    function test_F27_limitsBounded() public {
        vm.expectRevert(PoolHedging.InvalidParams.selector);
        pool.setHedgerLimits(0, 0, false);
        vm.expectRevert(PoolHedging.InvalidParams.selector);
        pool.setHedgerLimits(0, 201, false);
    }
}
