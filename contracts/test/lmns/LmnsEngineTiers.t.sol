// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {LmnsStaking} from "../../src/LmnsStaking.sol";
import {ILmnsStaking} from "../../src/interfaces/ILmnsStaking.sol";
import {IOptionEngine} from "../../src/interfaces/IOptionEngine.sol";
import {MockLmns, BadFeeTiers} from "../mocks/MockLmns.sol";
import {EngineBase} from "../engine/EngineBase.sol";

/// @notice Todo 20 R4 feeDiscountTiers on the real engine: tiers by staked $LMNS lower the 3 bps fee and the spread,
/// bounded, read through a view with a safe default (no tier contract, or a broken one, never blocks a trade).
contract LmnsEngineTiersTest is EngineBase {
    bytes32 internal callD;
    MockLmns internal lmns;
    LmnsStaking internal staking;

    function setUp() public override {
        super.setUp();
        callD = _list(address(nvda), true, 100e18, DAILY);
        lmns = new MockLmns();
        staking = new LmnsStaking(
            admin, IERC20(address(lmns)), IERC20(address(usdg)), address(pool), 14 days, 7 days, 1 days
        );
        ILmnsStaking.Tier[] memory t = new ILmnsStaking.Tier[](2);
        t[0] = ILmnsStaking.Tier(1_000e18, 2_000, 500);
        t[1] = ILmnsStaking.Tier(10_000e18, 5_000, 2_000);
        vm.prank(admin);
        staking.setTiers(t);
        lmns.mint(alice, 10_000e18);
        vm.startPrank(alice);
        lmns.approve(address(staking), 10_000e18);
        staking.stake(10_000e18);
        vm.stopPrank();
    }

    function test_R4_unsetDefaultsToNoDiscount() public {
        assertEq(engine.feeTiers(), address(0));
        (uint16 f, uint16 s) = engine.feeDiscountOf(alice);
        assertEq(f + s, 0);
        IOptionEngine.Quote memory q0 = engine.quote(callD, 100e18, true);
        IOptionEngine.Quote memory q1 = engine.quoteFor(callD, 100e18, true, alice);
        assertEq(q1.usdg, q0.usdg);
        (uint256 cost,) = _buy(alice, callD, 100e18);
        assertEq(cost, q0.usdg);
    }

    function test_R4_feeDiscountTiers() public {
        vm.prank(admin);
        engine.setFeeTiers(address(staking));
        (uint16 f, uint16 s) = engine.feeDiscountOf(alice);
        assertEq(f, 5_000);
        assertEq(s, 2_000);

        IOptionEngine.Quote memory q0 = engine.quote(callD, 100e18, true);
        IOptionEngine.Quote memory q1 = engine.quoteFor(callD, 100e18, true, alice);
        assertEq(q0.feeUsdg, 3e6, "3 bps of $100 x 100");
        assertEq(q1.feeUsdg, 1.5e6, "half the fee");
        assertEq(q0.spreadBps, 150);
        assertEq(q1.spreadBps, 120, "spread 20% lower");
        assertLt(q1.usdg, q0.usdg);
        assertEq(q1.vMarkWad, q0.vMarkWad, "the mark itself is not discounted");

        // Execution matches the account's own quote; an account without stake pays the full price.
        (uint256 costA, uint256 tokA) = _buy(alice, callD, 100e18);
        assertEq(costA, q1.usdg);
        IOptionEngine.Quote memory qb = engine.quote(callD, 100e18, true);
        (uint256 costB,) = _buy(bob, callD, 100e18);
        assertEq(costB, qb.usdg);

        // Sells: the discount raises the proceeds.
        IOptionEngine.Quote memory s0 = engine.quote(callD, tokA, false);
        IOptionEngine.Quote memory s1 = engine.quoteFor(callD, tokA, false, alice);
        assertGt(s1.usdg, s0.usdg);
        assertEq(_sell(alice, callD, tokA), s1.usdg);
    }

    function test_R4_brokenTierContractNeverBlocksTrades() public {
        BadFeeTiers bad = new BadFeeTiers();
        vm.prank(admin);
        engine.setFeeTiers(address(bad));
        IOptionEngine.Quote memory q0 = engine.quote(callD, 10e18, true);
        for (uint256 m; m < 3; ++m) {
            bad.setMode(m); // revert, burn all gas, short answer
            (uint16 f, uint16 s) = engine.feeDiscountOf(alice);
            assertEq(f + s, 0);
            assertEq(engine.quoteFor(callD, 10e18, true, alice).usdg, q0.usdg);
        }
        bad.setMode(1);
        (uint256 cost, uint256 tok) = _buy(alice, callD, 10e18);
        assertGt(cost, 0);
        assertGt(_sell(alice, callD, tok), 0);
        // Out-of-range answers are clamped to the engine's bounds (50% of the fee, 20% of the spread).
        bad.setMode(3);
        (uint16 f3, uint16 s3) = engine.feeDiscountOf(alice);
        assertEq(f3, 5_000);
        assertEq(s3, 2_000);
    }

    function test_R4_setFeeTiersAdminOnly() public {
        vm.prank(guardian);
        vm.expectRevert();
        engine.setFeeTiers(address(staking));
        vm.prank(admin);
        vm.expectRevert(); // not a contract
        engine.setFeeTiers(alice);
        vm.prank(admin);
        engine.setFeeTiers(address(staking));
        vm.prank(admin);
        engine.setFeeTiers(address(0)); // off again
        assertEq(engine.feeTiers(), address(0));
    }

    function testFuzz_R4_discountNeverRaisesCost(uint256 units, uint256 stakeAmt) public {
        units = bound(units, 1e15, 200e18);
        stakeAmt = bound(stakeAmt, 1, 50_000e18);
        vm.prank(admin);
        engine.setFeeTiers(address(staking));
        lmns.mint(bob, stakeAmt);
        vm.startPrank(bob);
        lmns.approve(address(staking), stakeAmt);
        staking.stake(stakeAmt);
        vm.stopPrank();
        IOptionEngine.Quote memory q0 = engine.quote(callD, units, true);
        IOptionEngine.Quote memory q1 = engine.quoteFor(callD, units, true, bob);
        assertLe(q1.usdg, q0.usdg);
        // Bounded: at most half the fee plus 20% of the spread (each rounded up for the pool).
        assertGe(q1.usdg + q0.feeUsdg / 2 + 2 + (q0.usdg - q0.feeUsdg) / 5, q0.usdg);
    }
}
