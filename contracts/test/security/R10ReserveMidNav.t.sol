// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {PoolFixture} from "../pool/PoolFixture.sol";

/// @notice Round-2 review R10 (MEDIUM): claims value the pool on the exit side (upper liability bound, hedge at
/// min(S, TWAP)), and the reserve share was computed from that pessimistic raw, so every claim drew
/// (HWM - raw_exit) x burned / supply from the Reserve in real USDG while the honest NAV had not dropped: the
/// pessimism meant to stay with the LPs who stay drained the LPs' first-loss cover instead. The reserve share now
/// comes from the mid (book value, hedge at S) raw.
contract R10ReserveMidNavTest is PoolFixture {
    uint256 internal constant RESERVE = 20_000 * USDG;

    function setUp() public {
        _deploy();
        _deposit(alice, 600_000 * USDG); // the whale
        _deposit(bob, 400_000 * USDG);
        usdg.mint(address(reserve), RESERVE);
        pool.checkpoint(); // HWM at the honest NAV (no envelope, TWAP = S)
    }

    function _pessimism(uint256 extraWad) internal {
        vm.mockCall(
            address(engine), abi.encodeWithSignature("navLiability(bool)", true), abi.encode(extraWad)
        );
    }

    function _maturedTicket(address who, uint256 shares) internal returns (uint256 t) {
        vm.warp(vm.getBlockTimestamp() + 1 days + 1);
        t = _request(who, shares);
        vm.warp(vm.getBlockTimestamp() + 72 hours);
    }

    /// @dev Reviewer PoC: the whale checkpointed at the honest NAV, then claims 30% of supply while the exit bound is 3%
    /// of NAV pessimistic (a widened envelope). The Reserve paid 30% x 3% of NAV. It now pays nothing: no loss happened.
    function test_R10_exitPessimismIsNotDrawnFromTheReserve() public {
        uint256 t = _maturedTicket(alice, pool.totalSupply() * 30 / 100);
        _pessimism(30_000e18); // 3% of the 1M NAV
        vm.prank(alice);
        uint256 paid = pool.claim(t);
        assertGt(paid, 0);
        assertEq(usdg.balanceOf(address(reserve)), RESERVE, "no reserve draw without a loss");
    }

    /// @dev A real drop of the honest NAV below the HWM is still covered by the Reserve on exit.
    function test_R10_realLossStillDrawsTheReserve() public {
        uint256 t = _maturedTicket(bob, pool.totalSupply() * 10 / 100);
        engine.setLiability(10_000e18); // the honest liability rose by 10k
        vm.prank(bob);
        pool.claim(t);
        assertLt(usdg.balanceOf(address(reserve)), RESERVE, "a real loss is covered");
    }

    /// @dev PROPERTY: with no price, vol, funding or liability change, no sequence of checkpoints and claims under any
    /// exit-side pessimism draws the Reserve.
    function testFuzz_R10_reserveNeverDrawnWithoutALoss(uint256 extra, uint256 fracBps, bool checkpointFirst) public {
        extra = bound(extra, 0, 200_000e18);
        fracBps = bound(fracBps, 100, 9_000);
        address who = fracBps % 2 == 0 ? alice : bob;
        uint256 t = _maturedTicket(who, pool.balanceOf(who) * fracBps / 10_000);
        _pessimism(extra);
        if (checkpointFirst) pool.checkpoint();
        (address owner_,,) = pool.ticketOf(t);
        vm.prank(owner_);
        try pool.claim(t) {} catch {}
        pool.checkpoint();
        assertEq(usdg.balanceOf(address(reserve)), RESERVE, "Reserve untouched");
    }
}
