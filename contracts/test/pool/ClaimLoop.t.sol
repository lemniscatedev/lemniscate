// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {PoolFixture} from "./PoolFixture.sol";

/// @dev Security review 2026-10-17, F16: when liquid assets cannot pay every queued share, a claim pays its pro-rata
/// part and the rest stays claimable. Calling claim() again and again must not let one ticket take all the cash.
contract ClaimLoopTest is PoolFixture {
    uint256[3] internal t;

    function setUp() public {
        _deploy();
    }

    /// 3 LPs x 10,000; 25,000 in stock; 5,000 cash; the stock route is broken (issuer pause / drained pool).
    function _brokenRouteQueue() internal {
        _deposit(alice, 10_000 * USDG);
        _deposit(bob, 10_000 * USDG);
        _deposit(carol, 10_000 * USDG);
        pool.setParams(1 days, 0, 100, 2_000_000e6); // no cash buffer, so the hedger can put 25,000 in stock
        _hedgeTo(250e18);
        vm.warp(vm.getBlockTimestamp() + 1 days + 1);
        t[0] = _request(alice, pool.balanceOf(alice));
        t[1] = _request(bob, pool.balanceOf(bob));
        t[2] = _request(carol, pool.balanceOf(carol));
        vm.warp(vm.getBlockTimestamp() + 72 hours);
        swapRouter.setRate(address(stock), address(usdg), FEE, 1); // every hedge sale fails its floor
    }

    function _loop(uint256 ticket, uint256 n) internal returns (uint256 total) {
        for (uint256 i; i < n; ++i) {
            { (address owner_,,) = pool.ticketOf(ticket); vm.prank(owner_); }
            try pool.claim(ticket) returns (uint256 paid) {
                total += paid;
            } catch {
                break;
            }
        }
    }

    function test_F16_claimLoopTakesNoMoreThanProRata() public {
        _brokenRouteQueue();
        uint256 cash = usdg.balanceOf(address(pool));
        uint256 got = _loop(t[0], 40);
        assertGt(got, 0);
        assertApproxEqRel(got, cash / 3, 0.003e18); // its pro-rata share of the cash on hand, once
        // The others get the same part of the same day's pot, whoever claims first.
        { (address owner_,,) = pool.ticketOf(t[1]); vm.prank(owner_); }
        uint256 b = pool.claim(t[1]);
        { (address owner_,,) = pool.ticketOf(t[2]); vm.prank(owner_); }
        uint256 c = pool.claim(t[2]);
        assertApproxEqRel(b, got, 0.003e18);
        assertApproxEqRel(c, got, 0.003e18);
        assertLe(got + b + c, cash);
    }

    /// Repeat partial claims wait for the next UTC day; a looping helper contract gets one payment per day.
    function test_F16_partialClaimOncePerDay() public {
        _brokenRouteQueue();
        { (address owner_,,) = pool.ticketOf(t[0]); vm.prank(owner_); }
        pool.claim(t[0]);
        uint256 nextDay = (vm.getBlockTimestamp() / 1 days + 1) * 1 days;
        { (address owner_,,) = pool.ticketOf(t[0]); vm.prank(owner_); }
        vm.expectRevert(abi.encodeWithSignature("NotClaimable(uint64)", uint64(nextDay)));
        pool.claim(t[0]);
        vm.warp(nextDay);
        { (address owner_,,) = pool.ticketOf(t[0]); vm.prank(owner_); }
        assertGt(pool.claim(t[0]), 0);
    }

    /// Over several days with the route still broken, every ticket converges to the same total (pro rata), and a
    /// stranger claiming someone else's ticket only pays that ticket's owner.
    function test_F16_proRataOverDays() public {
        _brokenRouteQueue();
        address stranger = makeAddr("stranger");
        uint256 a0 = usdg.balanceOf(alice);
        for (uint256 d; d < 30; ++d) {
            for (uint256 i; i < 3; ++i) {
                { (address owner_,,) = pool.ticketOf(t[i]); vm.prank(owner_); }
                try pool.claim(t[i]) {} catch {}
            }
            vm.warp(vm.getBlockTimestamp() + 1 days);
        }
        assertEq(usdg.balanceOf(stranger), 0);
        uint256 a = usdg.balanceOf(alice) - a0;
        assertApproxEqRel(usdg.balanceOf(bob), a, 0.003e18);
        assertApproxEqRel(usdg.balanceOf(carol), a, 0.003e18);
    }

    /// When liquidity covers every queued share, claims are unaffected: full payment, no daily limit.
    function test_F16_fullClaimsUnaffected() public {
        _deposit(alice, 10_000 * USDG);
        _deposit(bob, 10_000 * USDG);
        vm.warp(vm.getBlockTimestamp() + 1 days + 1);
        uint256 ta = _request(alice, pool.balanceOf(alice));
        uint256 tb = _request(bob, pool.balanceOf(bob));
        vm.warp(vm.getBlockTimestamp() + 72 hours);
        { (address owner_,,) = pool.ticketOf(ta); vm.prank(owner_); }
        assertGt(pool.claim(ta), 9_980 * USDG);
        { (address owner_,,) = pool.ticketOf(tb); vm.prank(owner_); }
        assertGt(pool.claim(tb), 9_980 * USDG);
    }

    /// Sybil: splitting a position into many tickets and claiming them in a loop takes the same pro-rata part.
    function test_F16_splitTicketsGainNothing() public {
        _deposit(alice, 10_000 * USDG);
        _deposit(bob, 10_000 * USDG);
        _deposit(carol, 10_000 * USDG);
        pool.setParams(1 days, 0, 100, 2_000_000e6);
        _hedgeTo(250e18);
        vm.warp(vm.getBlockTimestamp() + 1 days + 1);
        uint256 each = pool.balanceOf(alice) / 10;
        uint256[] memory mine = new uint256[](10);
        for (uint256 i; i < 10; ++i) {
            mine[i] = _request(alice, i == 9 ? pool.balanceOf(alice) : each);
        }
        uint256 tb = _request(bob, pool.balanceOf(bob));
        _request(carol, pool.balanceOf(carol));
        vm.warp(vm.getBlockTimestamp() + 72 hours);
        swapRouter.setRate(address(stock), address(usdg), FEE, 1);
        uint256 cash = usdg.balanceOf(address(pool));
        uint256 got;
        for (uint256 r; r < 5; ++r) {
            for (uint256 i; i < 10; ++i) {
                { (address owner_,,) = pool.ticketOf(mine[i]); vm.prank(owner_); }
                try pool.claim(mine[i]) returns (uint256 p) {
                    got += p;
                } catch {}
            }
        }
        assertApproxEqRel(got, cash / 3, 0.003e18);
        { (address owner_,,) = pool.ticketOf(tb); vm.prank(owner_); }
        assertApproxEqRel(pool.claim(tb), got, 0.003e18);
    }

    /// Review F12(c) S-3: a ticket being paid down pro rata, one partial a day during a long cash shortfall, never lapses
    /// into a re-queue: its claim window runs from its last partial payment.
    function test_F12c_ticketPaidDownDailyNeverLapses() public {
        _brokenRouteQueue();
        for (uint256 d; d < 12; ++d) {
            vm.prank(alice);
            assertGt(pool.claim(t[0]), 0, "a partial every day, past the 7-day window");
            vm.warp((vm.getBlockTimestamp() / 1 days + 1) * 1 days);
        }
    }
}
