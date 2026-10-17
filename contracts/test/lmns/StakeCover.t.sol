// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {LmnsStaking} from "../../src/LmnsStaking.sol";
import {ILmnsStaking} from "../../src/interfaces/ILmnsStaking.sol";
import {IPriceReference} from "../../src/interfaces/IPriceReference.sol";
import {IHedgeAdapter} from "../../src/interfaces/IHedgeAdapter.sol";
import {MockLmns} from "../mocks/MockLmns.sol";
import {PoolLayers} from "../../src/libs/PoolLayers.sol";
import {PoolFixture} from "../pool/PoolFixture.sol";

/// @dev Security review 2026-10-17, F18 / F19: the staked $LMNS cover counted in NAV must be realisable, and a stake
/// loss must not be escapable by unstaking before LPs exit.
contract StakeCoverTest is PoolFixture {
    uint24 internal constant LMNS_FEE = 3000;

    MockLmns internal lmns;
    LmnsStaking internal staking;
    address internal staker = makeAddr("staker");

    function setUp() public {
        vm.warp(1_790_000_000);
        _deploy();
        lmns = new MockLmns();
        staking = new LmnsStaking(
            admin, IERC20(address(lmns)), IERC20(address(usdg)), address(pool), 14 days, 7 days, 1 days
        );
        twap.setPrice(1e18);
        swapRouter.setRate(address(lmns), address(usdg), LMNS_FEE, 1e6);
        staking.setSlashRoute(IPriceReference(address(twap)), IHedgeAdapter(address(adapter)), LMNS_FEE, 300);
        _enableCover();
        pool.setStaking(ILmnsStaking(address(staking)));

        _deposit(alice, 10_000 * USDG);
        _deposit(bob, 10_000 * USDG);
        _engineBuy(4_000 * USDG, 4_000 * USDG, 0); // reserve takes 1,000 (5% of NAV)
        pool.checkpoint();

        lmns.mint(staker, 1_000e18);
        vm.startPrank(staker);
        lmns.approve(address(staking), 1_000e18);
        staking.stake(1_000e18);
        vm.stopPrank();
    }

    /// @dev Hook for the fix: the cover cap (0 = no cover counted) is admin-set to what the LMNS pool can absorb.
    function _enableCover() internal virtual {
        staking.setCoverCap(1_000 * USDG);
    }

    /// LP value that exists without the stake: raw NAV plus the Reserve's USDG, per share.
    function _realisablePerShare() internal view returns (uint256) {
        (int256 raw,) = pool.navParts();
        int256 r = raw + int256(usdg.balanceOf(address(reserve)) * 1e12);
        return r <= 0 ? 0 : uint256(r) * 1e12 / pool.totalSupply();
    }

    /// Loss past the Reserve, counted as covered by the stake; Bob claims while the LMNS route cannot clear the slash.
    /// The remaining LPs must not pay for the cover that was never realised.
    function test_F18_failedSlashIsChargedToTheClaim() public {
        vm.warp(vm.getBlockTimestamp() + 1 days + 1);
        uint256 ticket = _request(bob, pool.balanceOf(bob));
        vm.warp(vm.getBlockTimestamp() + 72 hours);
        engine.setLiability(1_500e18); // reserve 1,000 + 500 from the stake
        swapRouter.setRate(address(lmns), address(usdg), LMNS_FEE, 1); // the slash cannot clear its floor
        uint256 before = _realisablePerShare();
        { (address owner_,,) = pool.ticketOf(ticket); vm.prank(owner_); }
        pool.claim(ticket);
        assertGe(_realisablePerShare() + 1e9, before, "remaining LPs paid for an unrealised slash");
    }

    /// A stranger cannot force a charged claim on the owner (only the owner may claim, review F12(c)).
    function test_F18_strangerCannotForceChargedClaim() public {
        vm.warp(vm.getBlockTimestamp() + 1 days + 1);
        uint256 ticket = _request(bob, pool.balanceOf(bob));
        vm.warp(vm.getBlockTimestamp() + 72 hours);
        engine.setLiability(1_500e18);
        swapRouter.setRate(address(lmns), address(usdg), LMNS_FEE, 1);
        vm.prank(makeAddr("stranger"));
        vm.expectRevert(abi.encodeWithSignature("NotTicketOwner(address)", bob));
        pool.claim(ticket);
        // With the route healthy the slash clears and nothing is charged.
        swapRouter.setRate(address(lmns), address(usdg), LMNS_FEE, 1e6);
        uint256 preview = pool.previewRedeem(pool.balanceOf(address(pool)));
        { (address owner_,,) = pool.ticketOf(ticket); vm.prank(owner_); }
        uint256 paid = pool.claim(ticket);
        assertApproxEqAbs(paid, preview, 1 * USDG);
    }

    /// The cover counted in NAV never exceeds the admin's depth cap, even with a pumped LMNS TWAP; default 0.
    function test_F18_coverCappedByDepth() public {
        LmnsStaking fresh = new LmnsStaking(
            admin, IERC20(address(lmns)), IERC20(address(usdg)), address(pool), 14 days, 7 days, 1 days
        );
        fresh.setSlashRoute(IPriceReference(address(twap)), IHedgeAdapter(address(adapter)), LMNS_FEE, 300);
        assertEq(fresh.coverValueUsdg(), 0); // no cap set: no cover
        assertApproxEqAbs(staking.coverValueUsdg(), 970 * USDG, 1);
        twap.setPrice(100e18); // TWAP pushed up 100x
        assertEq(staking.coverValueUsdg(), 1_000 * USDG);
        vm.prank(alice);
        vm.expectRevert();
        staking.setCoverCap(1e30);
    }

    /// F19: a loss past the Reserve is already counted against the stake; stakers who see it and unstake must not take
    /// the stake's part of it with them (LP NAV per share must not drop when they leave).
    function test_F19_stakersCannotUnstakeOutOfACountedLoss() public {
        engine.setLiability(1_500e18); // reserve + 900 from the stake
        uint256 nps = pool.navPerShare();
        uint256 sh = staking.sharesOf(staker);
        vm.prank(staker);
        staking.requestUnstake(sh);
        vm.warp(vm.getBlockTimestamp() + 14 days);
        vm.prank(staker);
        uint256 got = staking.completeUnstake();
        assertLt(got, 1_000e18 - 900e18); // the stake's part of the loss stayed behind
        assertApproxEqRel(pool.navPerShare(), nps, 1e12, "LP NAV per share fell when stakers left");
    }

    /// F19: someone who stakes after the loss buys at the post-loss price and does not absorb the older loss.
    function test_F19_newStakerDoesNotAbsorbOlderLoss() public {
        vm.warp(vm.getBlockTimestamp() + 1 days + 1);
        uint256 ticket = _request(bob, pool.balanceOf(bob));
        vm.warp(vm.getBlockTimestamp() + 72 hours);
        engine.setLiability(1_500e18);
        address late = makeAddr("late");
        lmns.mint(late, 1_000e18);
        vm.startPrank(late);
        lmns.approve(address(staking), 1_000e18);
        staking.stake(1_000e18);
        vm.stopPrank();
        { (address owner_,,) = pool.ticketOf(ticket); vm.prank(owner_); }
        pool.claim(ticket); // realises Bob's slice of the stake's part of the loss (a slash)
        assertApproxEqRel(staking.stakeOf(late), 1_000e18, 1e12, "late staker paid for an older loss");
    }

    /// F19 (S-3): a TWAP outage does not release the set-aside, so stakers cannot leave during it with the loss.
    function test_F19_priceOutageKeepsTheSetAside() public {
        engine.setLiability(1_500e18);
        staking.syncLoss();
        uint256 locked = staking.lockedForPool();
        assertGt(locked, 900e18);
        uint256 sh = staking.sharesOf(staker);
        vm.prank(staker);
        staking.requestUnstake(sh);
        vm.warp(vm.getBlockTimestamp() + 14 days);
        twap.setPrice(0);
        vm.prank(staker);
        uint256 got = staking.completeUnstake();
        assertEq(staking.lockedForPool(), locked);
        assertLt(got, 100e18);
        // Recovery with no stakers left: the set-aside stays (releasing it would let the next stake round to 0 shares).
        twap.setPrice(1e18);
        engine.setLiability(0);
        staking.syncLoss();
        assertEq(staking.lockedForPool(), locked);
    }

    /// F19: when the loss recovers, the set-aside returns to the stakers' share price.
    function test_F19_recoveryReleasesTheSetAside() public {
        engine.setLiability(1_500e18);
        staking.syncLoss();
        assertLt(staking.stakeOf(staker), 100e18);
        engine.setLiability(0);
        staking.syncLoss();
        assertEq(staking.lockedForPool(), 0);
        assertApproxEqAbs(staking.stakeOf(staker), 1_000e18, 1e9);
    }
}
