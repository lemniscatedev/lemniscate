// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {FeeRouter} from "../../src/FeeRouter.sol";
import {Reserve} from "../../src/Reserve.sol";
import {IFeeRouter} from "../../src/interfaces/IFeeRouter.sol";
import {IReserve} from "../../src/interfaces/IReserve.sol";
import {MockUSDG} from "../mocks/MockUSDG.sol";

contract FeeRouterTest is Test {
    MockUSDG internal usdg;
    FeeRouter internal router;
    address internal pool = makeAddr("pool");
    address internal treasury = makeAddr("treasury");
    address internal keepers = makeAddr("keepers");
    address internal hedger = makeAddr("hedger");
    address internal stakers = makeAddr("stakers");

    function setUp() public {
        usdg = new MockUSDG();
        router = new FeeRouter(address(this), IERC20(address(usdg)), pool, treasury);
        router.setRecipient("keepers", keepers);
        router.setRecipient("hedger", hedger);
    }

    function test_R7_feeRouterSplit() public {
        assertEq(router.protocolFeeBps(), 1_000);
        usdg.mint(address(router), 1_000 * 1e6);
        vm.expectRevert(abi.encodeWithSelector(IFeeRouter.TooEarly.selector, vm.getBlockTimestamp() + 7 days));
        router.distribute();

        vm.warp(vm.getBlockTimestamp() + 7 days);
        uint256 amount = router.distribute();
        assertEq(amount, 1_000e6);
        // 80% workers = 800: pool 480 (back to writers via NAV), keepers 160, hedger 160.
        assertEq(usdg.balanceOf(pool), 480e6);
        assertEq(usdg.balanceOf(keepers), 160e6);
        assertEq(usdg.balanceOf(hedger), 160e6);
        assertEq(usdg.balanceOf(treasury), 100e6);
        // Stakers and burn have no recipient yet: held.
        assertEq(router.heldStakers(), 50e6);
        assertEq(router.heldBurn(), 50e6);
        assertEq(router.distributable(), 0);
        assertEq(usdg.balanceOf(address(router)), 100e6);

        // Weekly only.
        usdg.mint(address(router), 200e6);
        vm.expectRevert(abi.encodeWithSelector(IFeeRouter.TooEarly.selector, vm.getBlockTimestamp() + 7 days));
        router.distribute();

        // Once a stakers recipient exists, the held bucket is paid with the next share.
        router.setRecipient("stakers", stakers);
        vm.warp(vm.getBlockTimestamp() + 7 days);
        router.distribute();
        assertEq(usdg.balanceOf(stakers), 50e6 + 10e6);
        assertEq(router.heldStakers(), 0);
        assertEq(router.heldBurn(), 60e6);
    }

    function test_R7_roundingDustStaysInRouter() public {
        usdg.mint(address(router), 101);
        vm.warp(vm.getBlockTimestamp() + 7 days);
        router.distribute();
        // 101 x 80% = 80 -> pool 48, keepers 16, hedger 16; treasury 10; stakers 5 held; burn 5 held: dust 1
        assertEq(usdg.balanceOf(pool) + usdg.balanceOf(keepers) + usdg.balanceOf(hedger) + usdg.balanceOf(treasury), 90);
        assertEq(router.distributable(), 1);
        assertEq(usdg.balanceOf(address(router)), 11);
    }

    function test_R7_splitsAreAdminOnlyAndSumToOne() public {
        vm.expectRevert(IFeeRouter.InvalidParams.selector);
        router.setSplit(8_000, 1_000, 500, 501);
        vm.expectRevert(IFeeRouter.InvalidParams.selector);
        router.setWorkerSplit(6_000, 2_000, 2_001);
        vm.expectRevert(IFeeRouter.InvalidParams.selector);
        router.setProtocolFeeBps(3_001);
        vm.expectRevert(IFeeRouter.InvalidParams.selector);
        router.setRecipient("treasury", address(0));
        vm.expectRevert(IFeeRouter.InvalidParams.selector);
        router.setRecipient("other", treasury);
        vm.prank(keepers);
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, keepers, bytes32(0))
        );
        router.setProtocolFeeBps(500);
        router.setSplit(7_000, 2_000, 500, 500);
        router.setWorkerSplit(10_000, 0, 0);
        router.setProtocolFeeBps(500);
        assertEq(router.protocolFeeBps(), 500);
    }

    function test_R6_reserveCoverIsPoolOnly() public {
        Reserve reserve = new Reserve(address(this), IERC20(address(usdg)), pool);
        usdg.mint(address(reserve), 100e6);
        vm.expectRevert(IReserve.NotPool.selector);
        reserve.cover(1);
        vm.prank(pool);
        assertEq(reserve.cover(30e6), 30e6);
        vm.prank(pool);
        assertEq(reserve.cover(1_000e6), 70e6);
        assertEq(usdg.balanceOf(pool), 100e6);
        assertEq(reserve.incomeShareBps(), 1_500);
        assertEq(reserve.targetBps(), 500);
        vm.expectRevert(IReserve.InvalidParams.selector);
        reserve.setParams(5_001, 500);
        vm.prank(pool);
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, pool, bytes32(0))
        );
        reserve.setParams(1_000, 400);
    }
}
