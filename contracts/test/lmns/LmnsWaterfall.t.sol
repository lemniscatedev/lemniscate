// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {LmnsStaking} from "../../src/LmnsStaking.sol";
import {WriterPool} from "../../src/WriterPool.sol";
import {ILmnsStaking} from "../../src/interfaces/ILmnsStaking.sol";
import {IPriceReference} from "../../src/interfaces/IPriceReference.sol";
import {IHedgeAdapter} from "../../src/interfaces/IHedgeAdapter.sol";
import {MockLmns} from "../mocks/MockLmns.sol";
import {PoolFixture} from "../pool/PoolFixture.sol";

/// @notice Todo 20 R3 slashOrderOnLoss: reserve, then staked $LMNS (TWAP value capped by the stake), then LP NAV, on
/// the real WriterPool and Reserve with a staged loss.
contract LmnsWaterfallTest is PoolFixture {
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
        // LMNS at $1 on the TWAP and on the router.
        twap.setPrice(1e18);
        swapRouter.setRate(address(lmns), address(usdg), LMNS_FEE, 1e6);
        staking.setSlashRoute(IPriceReference(address(twap)), IHedgeAdapter(address(adapter)), LMNS_FEE, 300);
        pool.setStaking(ILmnsStaking(address(staking)));

        _deposit(alice, 10_000 * USDG);
        _engineBuy(4_000 * USDG, 4_000 * USDG, 0); // reserve takes 500 (5% of NAV)
        assertEq(reserve.balance(), 500 * USDG);
        pool.checkpoint();

        lmns.mint(staker, 1_000e18);
        vm.startPrank(staker);
        lmns.approve(address(staking), 1_000e18);
        staking.stake(1_000e18);
        vm.stopPrank();
        assertApproxEqAbs(staking.coverValueUsdg(), 970 * USDG, 1); // 1,000 LMNS x $1 x (1 - 3%)
    }

    function test_R3_slashOrderOnLoss() public {
        uint256 nps0 = pool.navPerShare();
        uint256 supply = pool.totalSupply();

        // 1) Loss inside the reserve: LP NAV per share unchanged, stake not counted.
        engine.setLiability(300e18);
        (, uint256 rs) = pool.navParts();
        assertApproxEqAbs(rs, 300e18, 1e12);
        assertApproxEqAbs(pool.navPerShare(), nps0, 1);

        // 2) Loss past the reserve: the stake's cover fills the rest; LP NAV per share still unchanged.
        engine.setLiability(1_200e18);
        (, rs) = pool.navParts();
        assertApproxEqAbs(rs, 1_200e18, 1e12, "reserve 500 + stake 700");
        assertApproxEqAbs(pool.navPerShare(), nps0, 1);

        // 3) Loss past both: only the excess over reserve + capped stake cover (500 + 970) reaches LP NAV.
        engine.setLiability(2_000e18);
        (, rs) = pool.navParts();
        assertApproxEqAbs(rs, 1_470e18, 1e12);
        assertApproxEqRel(pool.navPerShare(), nps0 - 530e18 * 1e12 / supply, 1e12);
        engine.setLiability(1_200e18);

        // Realisation: a payout 800 beyond cash draws the reserve (500) first, then slashes the stake for 300.
        uint256 cash = usdg.balanceOf(address(pool));
        vm.expectEmit(address(pool));
        emit WriterPool.StakeSlashed(300 * USDG, 309_278_350);
        vm.prank(address(engine));
        pool.pay(seller, cash + 800 * USDG, 0);
        assertEq(usdg.balanceOf(seller), cash + 800 * USDG);
        assertEq(reserve.balance(), 0, "reserve used up first");
        // ceil(300 / 0.97) LMNS sold at $1.
        assertApproxEqAbs(1_000e18 - staking.totalAssets(), 309_278_350_515_463_918_000, 1e6);
        // The stake's own value fell pro rata; LP NAV per share is still defended at its mark.
        assertApproxEqAbs(staking.stakeOf(staker), staking.totalAssets(), 1);
    }

    function test_R3_payWithinReserveNeverTouchesStake() public {
        engine.setLiability(400e18);
        uint256 cash = usdg.balanceOf(address(pool));
        vm.prank(address(engine));
        pool.pay(seller, cash + 399 * USDG, 0);
        assertEq(reserve.balance(), 101 * USDG);
        assertEq(staking.totalAssets(), 1_000e18);
    }

    function test_R3_guardianAndAdminCannotSlash() public {
        engine.setLiability(1_200e18);
        vm.prank(guardian);
        vm.expectRevert(ILmnsStaking.NotPool.selector);
        staking.slash(100 * USDG);
        vm.expectRevert(ILmnsStaking.NotPool.selector);
        staking.slash(100 * USDG); // admin (this test contract)
        // The pool exposes no slash entry point: only its loss path (claims, payouts) draws the stake.
        (bool ok,) = address(pool).call(abi.encodeWithSignature("slash(uint256)", 1));
        assertFalse(ok);
        // Pointing the pool at staking is admin only, and only at a staking contract built for this pool.
        vm.prank(guardian);
        vm.expectRevert();
        pool.setStaking(ILmnsStaking(address(0)));
        LmnsStaking other = new LmnsStaking(
            admin, IERC20(address(lmns)), IERC20(address(usdg)), makeAddr("otherPool"), 14 days, 7 days, 1 days
        );
        vm.expectRevert(WriterPool.InvalidParams.selector);
        pool.setStaking(ILmnsStaking(address(other)));
    }

    function test_R1_stakingUnsetOrRouteOffIsReserveOnly() public {
        uint256 nps0 = pool.navPerShare();
        uint256 supply = pool.totalSupply();
        // Route off: the stake gives no cover, so the loss beyond the reserve reaches LP NAV as before todo 20.
        staking.setSlashRoute(IPriceReference(address(0)), IHedgeAdapter(address(0)), 0, 300);
        engine.setLiability(1_200e18);
        assertApproxEqRel(pool.navPerShare(), nps0 - 700e18 * 1e12 / supply, 1e12);
        // Unset entirely: same, and nothing reverts.
        pool.setStaking(ILmnsStaking(address(0)));
        assertApproxEqRel(pool.navPerShare(), nps0 - 700e18 * 1e12 / supply, 1e12);
        pool.checkpoint();
        assertApproxEqAbs(pool.highWaterNavPerShare(), pool.navPerShare(), 1, "reserve exhausted: new defended level");
    }

    function test_R3_exhaustedLayersMoveHighWaterMark() public {
        uint256 hwm0 = pool.highWaterNavPerShare();
        engine.setLiability(1_200e18);
        pool.checkpoint();
        assertEq(pool.highWaterNavPerShare(), hwm0, "still defended while the stake covers");
        engine.setLiability(2_000e18);
        pool.checkpoint();
        assertApproxEqAbs(pool.highWaterNavPerShare(), pool.navPerShare(), 1);
    }
}
