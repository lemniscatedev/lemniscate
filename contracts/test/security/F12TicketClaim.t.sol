// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {PoolFixture} from "../pool/PoolFixture.sol";

/// @notice Review F12 part (c), follow-up B2: a matured withdrawal ticket stayed claimable forever at claim-time NAV
/// (a free option to pick the exit moment) and anyone could claim it (a stranger could force a victim's exit at a
/// moment that suits the stranger). Claims are now the ticket owner's alone, and a ticket left unclaimed for
/// CLAIM_WINDOW after it matured (or after its last pro-rata payment) is re-queued for a fresh QUEUE_DELAY instead of
/// paying: no value moves, the LP keeps every share, and the exit moment can never be held open.
contract F12TicketClaimTest is PoolFixture {
    address internal stranger = makeAddr("stranger");
    uint256 internal constant WINDOW = 7 days; // WriterPool.CLAIM_WINDOW

    function setUp() public {
        _deploy();
    }

    function _maturedTicket() internal returns (uint256 t, uint256 sh) {
        sh = _deposit(alice, 10_000 * USDG);
        vm.warp(vm.getBlockTimestamp() + 1 days + 1);
        t = _request(alice, sh);
        vm.warp(vm.getBlockTimestamp() + 72 hours);
    }

    function test_F12c_strangerCannotClaimSomeoneElsesTicket() public {
        (uint256 t,) = _maturedTicket();
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSignature("NotTicketOwner(address)", alice));
        pool.claim(t);
        vm.prank(alice);
        assertGt(pool.claim(t), 0, "the owner claims");
    }

    function test_F12c_unclaimedTicketExpiresIntoAFreshQueue() public {
        (uint256 t, uint256 sh) = _maturedTicket();
        vm.warp(vm.getBlockTimestamp() + WINDOW + 1);
        uint256 cashBefore = usdg.balanceOf(address(pool));
        vm.prank(alice);
        assertEq(pool.claim(t), 0, "an expired ticket pays nothing now");
        assertEq(usdg.balanceOf(address(pool)), cashBefore, "no value moved");
        (address owner, uint256 shares, uint64 at) = pool.ticketOf(t);
        assertEq(owner, alice);
        assertEq(shares, sh, "the LP keeps every share in the queue");
        assertEq(at, vm.getBlockTimestamp() + 72 hours, "re-queued for a fresh delay");
        assertEq(pool.queuedShares(), sh);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSignature("NotClaimable(uint64)", at));
        pool.claim(t);
        vm.warp(at);
        vm.prank(alice);
        assertApproxEqRel(pool.claim(t), 10_000 * USDG, 0.001e18, "paid in full after the new delay");
    }

    /// S-3 (market closed / permanent hold): inside the window the owner can claim at any time, including the last second.
    function test_F12c_claimOnTheLastSecondOfTheWindowPays() public {
        (uint256 t,) = _maturedTicket();
        vm.warp(vm.getBlockTimestamp() + WINDOW);
        vm.prank(alice);
        assertGt(pool.claim(t), 9_900 * USDG);
    }
}
