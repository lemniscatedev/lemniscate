// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {LmnsStaking} from "../../src/LmnsStaking.sol";
import {LmnsBuyBurn} from "../../src/LmnsBuyBurn.sol";
import {FeeRouter} from "../../src/FeeRouter.sol";
import {UniswapV3HedgeAdapter} from "../../src/UniswapV3HedgeAdapter.sol";
import {ILmnsStaking} from "../../src/interfaces/ILmnsStaking.sol";
import {IPriceReference} from "../../src/interfaces/IPriceReference.sol";
import {IHedgeAdapter} from "../../src/interfaces/IHedgeAdapter.sol";
import {ISwapRouter02} from "../../src/interfaces/ISwapRouter02.sol";
import {MockUSDG} from "../mocks/MockUSDG.sol";
import {MockLmns} from "../mocks/MockLmns.sol";
import {MockSwapRouter} from "../mocks/MockSwapRouter.sol";
import {MockPriceReference} from "../mocks/MockPriceReference.sol";

/// @dev Shared setup: mock launchpad $LMNS at $2, a fixed-rate router behind the real hedge adapter, staking with the
/// mainnet timers (14d unstake, 7d stream, 1d claim age).
abstract contract LmnsBase is Test {
    uint24 internal constant FEE = 3000;
    uint256 internal constant PRICE = 2e18; // WAD USD per LMNS

    MockUSDG internal usdg;
    MockLmns internal lmns;
    MockSwapRouter internal router;
    UniswapV3HedgeAdapter internal adapter;
    MockPriceReference internal twap;
    LmnsStaking internal staking;

    address internal admin = makeAddr("admin");
    address internal poolAddr = makeAddr("pool");
    address internal guardian = makeAddr("guardian");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal eve = makeAddr("eve");

    function setUp() public virtual {
        vm.warp(1_790_000_000);
        usdg = new MockUSDG();
        lmns = new MockLmns();
        router = new MockSwapRouter();
        adapter = new UniswapV3HedgeAdapter(ISwapRouter02(address(router)));
        twap = new MockPriceReference();
        twap.setPrice(PRICE);
        _setExecPrice(PRICE);
        usdg.mint(address(router), 1e15);
        lmns.mint(address(router), 1e27);
        staking = _mkStaking(poolAddr);
    }

    function _mkStaking(address pool_) internal returns (LmnsStaking s) {
        s = new LmnsStaking(admin, IERC20(address(lmns)), IERC20(address(usdg)), pool_, 14 days, 7 days, 1 days);
    }

    function _route(LmnsStaking s) internal {
        vm.startPrank(admin);
        s.setSlashRoute(IPriceReference(address(twap)), IHedgeAdapter(address(adapter)), FEE, 300);
        s.setCoverCap(type(uint256).max); // F18: depth cap tested in StakeCover.t.sol
        vm.stopPrank();
    }

    /// @dev Router executes LMNS <-> USDG at `p` (WAD USD per LMNS).
    function _setExecPrice(uint256 p) internal {
        router.setRate(address(lmns), address(usdg), FEE, p / 1e12);
        router.setRate(address(usdg), address(lmns), FEE, 1e48 / p);
    }

    function _stake(LmnsStaking s, address who, uint256 amount) internal returns (uint256 shares) {
        lmns.mint(who, amount);
        vm.startPrank(who);
        lmns.approve(address(s), amount);
        shares = s.stake(amount);
        vm.stopPrank();
    }

    function _reward(LmnsStaking s, uint256 amount) internal {
        usdg.mint(address(s), amount);
        s.syncRewards();
    }
}

contract LmnsStakingTest is LmnsBase {
    // ------------------------------------------------------------------ R1 noTokenContract

    function test_R1_noTokenContract() public {
        // The token is a deploy parameter; staking never mints it (supply only changes by the test's own mints).
        assertEq(address(staking.token()), address(lmns));
        uint256 supply = lmns.totalSupply();
        _route(staking);
        _stake(staking, alice, 1_000e18);
        supply += 1_000e18;
        vm.prank(poolAddr);
        staking.slash(100e6);
        uint256 sh = staking.sharesOf(alice);
        vm.prank(alice);
        staking.requestUnstake(sh);
        skip(14 days);
        vm.prank(alice);
        staking.completeUnstake();
        assertEq(lmns.totalSupply(), supply, "no mint anywhere");
        // Constructor refuses a missing token, the USDG itself, and a non-18-decimal token.
        vm.expectRevert(ILmnsStaking.InvalidParams.selector);
        new LmnsStaking(admin, IERC20(address(0)), IERC20(address(usdg)), poolAddr, 14 days, 7 days, 1 days);
        vm.expectRevert(ILmnsStaking.InvalidParams.selector);
        new LmnsStaking(admin, IERC20(address(usdg)), IERC20(address(usdg)), poolAddr, 14 days, 7 days, 1 days);
        MockUSDG six = new MockUSDG();
        vm.expectRevert(ILmnsStaking.InvalidParams.selector);
        new LmnsStaking(admin, IERC20(address(six)), IERC20(address(usdg)), poolAddr, 14 days, 7 days, 1 days);
    }

    function test_R1_moduleOffViewsNeverRevert() public {
        // No route, no tiers, no stake: every read the pool and engine make returns zero.
        assertEq(staking.coverValueUsdg(), 0);
        (uint16 f, uint16 s) = staking.feeDiscountOf(alice);
        assertEq(f + s, 0);
        vm.prank(poolAddr);
        assertEq(staking.slash(1_000e6), 0);
        _stake(staking, alice, 1_000e18);
        assertEq(staking.coverValueUsdg(), 0, "no route = no cover");
        vm.prank(poolAddr);
        assertEq(staking.slash(1_000e6), 0, "no route = no slash");
    }

    function test_R1_timersHardMinimum() public {
        vm.expectRevert(ILmnsStaking.InvalidParams.selector);
        new LmnsStaking(admin, IERC20(address(lmns)), IERC20(address(usdg)), poolAddr, 5 minutes - 1, 7 days, 1 days);
        vm.expectRevert(ILmnsStaking.InvalidParams.selector);
        new LmnsStaking(admin, IERC20(address(lmns)), IERC20(address(usdg)), poolAddr, 60 days + 1, 7 days, 1 days);
        vm.expectRevert(ILmnsStaking.InvalidParams.selector);
        new LmnsStaking(admin, IERC20(address(lmns)), IERC20(address(usdg)), poolAddr, 14 days, 5 minutes - 1, 1 days);
        vm.expectRevert(ILmnsStaking.InvalidParams.selector);
        new LmnsStaking(admin, IERC20(address(lmns)), IERC20(address(usdg)), poolAddr, 14 days, 7 days, 1 minutes - 1);
        LmnsStaking short =
            new LmnsStaking(admin, IERC20(address(lmns)), IERC20(address(usdg)), poolAddr, 5 minutes, 5 minutes, 1 minutes);
        assertEq(short.UNSTAKE_DELAY(), 5 minutes);
        assertEq(staking.UNSTAKE_DELAY(), 14 days);
    }

    // ------------------------------------------------------------------ R2 stakeUnstake14d

    function test_R2_stakeUnstake14d() public {
        uint256 shares = _stake(staking, alice, 1_000e18);
        assertEq(staking.stakeOf(alice), 1_000e18);
        vm.prank(alice);
        staking.requestUnstake(shares / 2);
        (uint256 qs, uint64 readyAt) = staking.requests(alice);
        assertEq(qs, shares / 2);
        assertEq(readyAt, vm.getBlockTimestamp() + 14 days);
        assertEq(staking.activeShares(), shares - shares / 2);

        skip(14 days - 1);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(ILmnsStaking.NotReady.selector, readyAt));
        staking.completeUnstake();

        // A second request adds to the first and restarts the delay.
        vm.prank(alice);
        staking.requestUnstake(shares / 4);
        (, uint64 readyAt2) = staking.requests(alice);
        assertEq(readyAt2, vm.getBlockTimestamp() + 14 days);

        // Cancel returns everything requested to the active stake.
        vm.prank(alice);
        staking.cancelUnstake();
        assertEq(staking.sharesOf(alice), shares);
        assertEq(staking.activeShares(), shares);

        vm.prank(alice);
        staking.requestUnstake(shares);
        skip(14 days);
        vm.prank(alice);
        uint256 out = staking.completeUnstake();
        assertApproxEqAbs(out, 1_000e18, 1, "virtual share rounding keeps at most 1 wei");
        assertEq(lmns.balanceOf(alice), out);
        vm.prank(alice);
        vm.expectRevert(ILmnsStaking.NothingToUnstake.selector);
        staking.completeUnstake();
    }

    function test_R2_stakeWithPermit() public {
        uint256 pk = 0xA11CE;
        address owner = vm.addr(pk);
        lmns.mint(owner, 500e18);
        uint256 deadline = vm.getBlockTimestamp() + 1 hours;
        bytes32 digest = keccak256(
            abi.encodePacked(
                "\x19\x01",
                lmns.DOMAIN_SEPARATOR(),
                keccak256(
                    abi.encode(
                        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"),
                        owner,
                        address(staking),
                        500e18,
                        lmns.nonces(owner),
                        deadline
                    )
                )
            )
        );
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);
        vm.prank(owner);
        staking.stakeWithPermit(500e18, deadline, v, r, s);
        assertEq(staking.stakeOf(owner), 500e18);
    }

    function test_R2_slashProRataDuringDelay() public {
        _route(staking);
        _stake(staking, alice, 1_000e18);
        uint256 bobShares = _stake(staking, bob, 1_000e18);
        vm.prank(bob);
        staking.requestUnstake(bobShares);
        // Slash a quarter of the 2,000 LMNS ($4,000): $1,000 at the 3% floor needs 1000/2/0.97 LMNS.
        vm.prank(poolAddr);
        staking.slash(970e6);
        uint256 left = staking.totalAssets();
        assertApproxEqAbs(left, 2_000e18 - 500e18, 1e6);
        // Both the active and the requested stake lost the same fraction.
        assertApproxEqAbs(staking.stakeOf(alice), left / 2, 1);
        skip(14 days);
        vm.prank(bob);
        uint256 out = staking.completeUnstake();
        assertApproxEqAbs(out, left / 2, 1);
    }

    // ------------------------------------------------------------------ R3 slash (unit; the waterfall is in LmnsWaterfall.t.sol)

    function test_R3_onlyPoolCanSlash() public {
        _route(staking);
        _stake(staking, alice, 1_000e18);
        address[3] memory who = [admin, guardian, alice];
        for (uint256 i; i < 3; ++i) {
            vm.prank(who[i]);
            vm.expectRevert(ILmnsStaking.NotPool.selector);
            staking.slash(1e6);
        }
    }

    function test_R3_slashAtTwapCappedByStake() public {
        _route(staking);
        _stake(staking, alice, 1_000e18); // $2,000 at the TWAP, cover = 2,000 x 0.97
        assertApproxEqAbs(staking.coverValueUsdg(), 1_940e6, 1);
        // $100 needed: sells ceil(100 / (2 x 0.97)) LMNS, the pool receives them at the executed price.
        uint256 before = usdg.balanceOf(poolAddr);
        vm.prank(poolAddr);
        uint256 sent = staking.slash(100e6);
        uint256 sold = 1_000e18 - staking.totalAssets();
        assertApproxEqAbs(sold, uint256(100e18) * 10_000 / (2 * 9_700), 1);
        assertEq(usdg.balanceOf(poolAddr) - before, sent);
        assertGe(sent, 100e6, "covers the need at the floor or better");
        // A need beyond the stake sells the whole stake down to the share-price floor (1 wei per 1e12 shares).
        vm.prank(poolAddr);
        staking.slash(1_000_000e6);
        assertEq(staking.totalAssets(), 1e9);
        assertEq(lmns.balanceOf(address(staking)), 1e9);
        vm.prank(poolAddr);
        assertEq(staking.slash(1e6), 0, "nothing left to slash");
    }

    function test_R3_failedRouteNeverReverts() public {
        _route(staking);
        _stake(staking, alice, 1_000e18);
        // Executed price 10% under the TWAP: the floor refuses the swap, the slash returns 0, nothing moves.
        _setExecPrice(PRICE * 90 / 100);
        vm.prank(poolAddr);
        assertEq(staking.slash(100e6), 0);
        assertEq(staking.totalAssets(), 1_000e18);
        assertEq(lmns.allowance(address(staking), address(adapter)), 0);
        // TWAP source down: no cover, no slash.
        _setExecPrice(PRICE);
        twap.setReverts(true);
        assertEq(staking.coverValueUsdg(), 0);
        vm.prank(poolAddr);
        assertEq(staking.slash(100e6), 0);
        // TWAP zero (no pool yet).
        twap.setReverts(false);
        twap.setPrice(0);
        vm.prank(poolAddr);
        assertEq(staking.slash(100e6), 0);
    }

    function test_R3_slashRouteAdminOnlyAndBounded() public {
        vm.prank(guardian);
        vm.expectRevert();
        staking.setSlashRoute(IPriceReference(address(twap)), IHedgeAdapter(address(adapter)), FEE, 300);
        vm.startPrank(admin);
        vm.expectRevert(ILmnsStaking.InvalidParams.selector);
        staking.setSlashRoute(IPriceReference(address(twap)), IHedgeAdapter(address(adapter)), FEE, 2_001);
        vm.expectRevert(ILmnsStaking.InvalidParams.selector);
        staking.setSlashRoute(IPriceReference(alice), IHedgeAdapter(address(adapter)), FEE, 300);
        vm.expectRevert(ILmnsStaking.InvalidParams.selector);
        staking.setSlashRoute(IPriceReference(address(twap)), IHedgeAdapter(address(adapter)), 0, 300);
        vm.stopPrank();
    }

    // ------------------------------------------------------------------ R4 feeDiscountTiers (engine side in LmnsEngineTiers.t.sol)

    function test_R4_tiersByActiveStake() public {
        ILmnsStaking.Tier[] memory t = new ILmnsStaking.Tier[](3);
        t[0] = ILmnsStaking.Tier(1_000e18, 1_000, 0);
        t[1] = ILmnsStaking.Tier(10_000e18, 2_500, 500);
        t[2] = ILmnsStaking.Tier(100_000e18, 5_000, 2_000);
        vm.prank(admin);
        staking.setTiers(t);

        _stake(staking, alice, 999e18);
        (uint16 f, uint16 s) = staking.feeDiscountOf(alice);
        assertEq(f + s, 0, "below the first tier");
        _stake(staking, alice, 1e18);
        (f, s) = staking.feeDiscountOf(alice);
        assertEq(f, 1_000);
        _stake(staking, alice, 200_000e18);
        (f, s) = staking.feeDiscountOf(alice);
        assertEq(f, 5_000);
        assertEq(s, 2_000);
        // A requested (unstaking) amount no longer counts.
        uint256 sh = staking.sharesOf(alice);
        vm.prank(alice);
        staking.requestUnstake(sh - sh / 20); // keeps ~10,050
        (f, s) = staking.feeDiscountOf(alice);
        assertEq(f, 2_500);
        assertEq(s, 500);
    }

    function test_R4_tiersBounded() public {
        ILmnsStaking.Tier[] memory t = new ILmnsStaking.Tier[](1);
        t[0] = ILmnsStaking.Tier(1e18, 5_001, 0);
        vm.prank(admin);
        vm.expectRevert(ILmnsStaking.InvalidParams.selector);
        staking.setTiers(t);
        t[0] = ILmnsStaking.Tier(1e18, 0, 2_001);
        vm.prank(admin);
        vm.expectRevert(ILmnsStaking.InvalidParams.selector);
        staking.setTiers(t);
        ILmnsStaking.Tier[] memory u = new ILmnsStaking.Tier[](2);
        u[0] = ILmnsStaking.Tier(2e18, 1, 1);
        u[1] = ILmnsStaking.Tier(2e18, 2, 2);
        vm.prank(admin);
        vm.expectRevert(ILmnsStaking.InvalidParams.selector);
        staking.setTiers(u);
        ILmnsStaking.Tier[] memory many = new ILmnsStaking.Tier[](5);
        for (uint256 i; i < 5; ++i) {
            many[i] = ILmnsStaking.Tier(uint128(i + 1), 1, 1);
        }
        vm.prank(admin);
        vm.expectRevert(ILmnsStaking.InvalidParams.selector);
        staking.setTiers(many);
    }

    // ------------------------------------------------------------------ R5 rewards

    function test_R5_rewardsAccruePerSecondStaked() public {
        _stake(staking, alice, 1_000e18);
        _reward(staking, 700e6); // streamed over 7 days: 100 USDG a day
        skip(3.5 days);
        _stake(staking, bob, 1_000e18); // half the weight from here on
        skip(3.5 days);
        assertApproxEqAbs(staking.earned(alice), 350e6 + 175e6, 10);
        assertApproxEqAbs(staking.earned(bob), 175e6, 10);
        skip(1 days); // stream over: no more accrual
        assertApproxEqAbs(staking.earned(alice), 525e6, 10);
        vm.prank(alice);
        uint256 paid = staking.claimRewards();
        assertEq(usdg.balanceOf(alice), paid);
        vm.prank(bob);
        staking.claimRewards();
        assertLe(usdg.balanceOf(alice) + usdg.balanceOf(bob), 700e6);
        assertGe(usdg.balanceOf(alice) + usdg.balanceOf(bob), 700e6 - 10);
    }

    function test_R5_flashStakeEarnsNothing() public {
        _stake(staking, alice, 1_000e18);
        skip(2 days);
        // A fee distribution lands; eve stakes 1,000x alice's stake in the same block and leaves at once.
        usdg.mint(address(staking), 700e6);
        uint256 eveShares = _stake(staking, eve, 1_000_000e18);
        vm.prank(eve);
        staking.requestUnstake(eveShares);
        assertEq(staking.earned(eve), 0, "nothing for a same-block stake");
        vm.prank(eve);
        vm.expectRevert();
        staking.claimRewards(); // inside the minimum stake age
        skip(7 days);
        assertEq(staking.earned(eve), 0, "unstaking shares earn nothing");
        assertApproxEqAbs(staking.earned(alice), 700e6, 10, "the long-term staker gets the stream");
    }

    function test_R5_claimNeedsMinimumStakeAge() public {
        _stake(staking, alice, 1_000e18);
        _reward(staking, 7e6);
        skip(1 days - 1);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(ILmnsStaking.ClaimTooEarly.selector, uint64(vm.getBlockTimestamp() + 1)));
        staking.claimRewards();
        skip(1);
        vm.prank(alice);
        assertGt(staking.claimRewards(), 0);
    }

    function test_R5_rewardsWithNoStakersAreCarried() public {
        _reward(staking, 700e6); // nobody staked
        skip(3.5 days);
        _stake(staking, alice, 1e18); // the unearned half is streamed again from now
        skip(7 days);
        assertApproxEqAbs(staking.earned(alice), 700e6, 10);
    }

    function test_R5_dustNeverOverpays() public {
        // Tiny and odd-sized stakes, many small transfers: total owed never exceeds what arrived.
        _stake(staking, alice, 1);
        _stake(staking, bob, 3e18 + 7);
        uint256 inflow;
        for (uint256 i; i < 20; ++i) {
            uint256 amt = 1e6 + i * 13;
            usdg.mint(address(staking), amt);
            inflow += amt;
            skip(3 hours + i);
            staking.syncRewards();
        }
        skip(8 days);
        uint256 owedSum = staking.earned(alice) + staking.earned(bob);
        assertLe(owedSum, inflow);
        assertGe(owedSum + 100, inflow, "dust stays tiny");
        vm.prank(alice);
        staking.claimRewards();
        vm.prank(bob);
        staking.claimRewards();
        assertLe(usdg.balanceOf(alice) + usdg.balanceOf(bob), inflow);
    }

    function test_R5_dustTransfersDoNotStretchTheStream() public {
        _stake(staking, alice, 1_000e18);
        _reward(staking, 700e6);
        uint64 finish = staking.periodFinish();
        skip(1 days);
        usdg.mint(address(staking), 1e6 - 1); // below MIN_REWARD_SYNC
        staking.syncRewards();
        assertEq(staking.periodFinish(), finish);
    }

    function testFuzz_R5_owedNeverExceedsInflow(uint96 a, uint96 b, uint64 r1, uint64 r2, uint32 gap) public {
        uint256 sa = bound(a, 1, 1e27);
        uint256 sb = bound(b, 1, 1e27);
        uint256 x = bound(r1, 1e6, 1e13);
        uint256 y = bound(r2, 1e6, 1e13);
        uint256 g = bound(gap, 1, 20 days);
        _stake(staking, alice, sa);
        _reward(staking, x);
        skip(g);
        _stake(staking, bob, sb);
        _reward(staking, y);
        skip(g);
        uint256 owedSum = staking.earned(alice) + staking.earned(bob);
        assertLe(owedSum, x + y);
        assertLe(owedSum, usdg.balanceOf(address(staking)));
    }

    // ------------------------------------------------------------------ R5 / R6 FeeRouter integration (no FeeRouter edits)

    function test_R5_R6_feeRouterBucketsReachStakingAndBurn() public {
        FeeRouter fees = new FeeRouter(admin, IERC20(address(usdg)), poolAddr, makeAddr("treasury"), 7 days);
        LmnsBuyBurn burn = new LmnsBuyBurn(admin, IERC20(address(lmns)), IERC20(address(usdg)));
        vm.prank(admin);
        burn.grantRole(keccak256("KEEPER_ROLE"), address(this)); // F37: keeper-only
        _stake(staking, alice, 1_000e18);

        // Before phase 2 the buckets are held in the router.
        usdg.mint(address(fees), 10_000e6);
        skip(7 days);
        fees.distribute();
        assertEq(fees.heldStakers(), 500e6);
        assertEq(fees.heldBurn(), 500e6);

        // Phase 2: the timelock points the buckets at staking and the burner; held amounts flow on the next round.
        vm.startPrank(admin);
        fees.setRecipient("stakers", address(staking));
        fees.setRecipient("burn", address(burn));
        vm.stopPrank();
        usdg.mint(address(fees), 10_000e6);
        skip(7 days);
        fees.distribute();
        assertEq(usdg.balanceOf(address(staking)), 1_000e6, "5% + held 5%");
        assertEq(usdg.balanceOf(address(burn)), 1_000e6);
        staking.syncRewards();
        skip(7 days);
        assertApproxEqAbs(staking.earned(alice), 1_000e6, 10);

        // Burn: no TWAP source yet -> accumulates.
        assertEq(burn.buyAndBurn(type(uint256).max), 0);
        assertEq(usdg.balanceOf(address(burn)), 1_000e6);
        vm.prank(admin);
        burn.setRoute(IPriceReference(address(twap)), IHedgeAdapter(address(adapter)), FEE, 300);
        uint256 burned = burn.buyAndBurn(type(uint256).max);
        assertEq(burned, 500e18, "$1,000 at $2");
        assertEq(lmns.balanceOf(burn.DEAD()), 500e18);
        assertEq(usdg.balanceOf(address(burn)), 0);
    }

    function test_R6_burnOnlyWithTwapElseAccumulates() public {
        LmnsBuyBurn burn = new LmnsBuyBurn(admin, IERC20(address(lmns)), IERC20(address(usdg)));
        vm.prank(admin);
        burn.grantRole(keccak256("KEEPER_ROLE"), address(this)); // F37: keeper-only
        usdg.mint(address(burn), 100e6);
        assertEq(burn.buyAndBurn(100e6), 0);
        vm.prank(admin);
        burn.setRoute(IPriceReference(address(twap)), IHedgeAdapter(address(adapter)), FEE, 300);
        // TWAP unavailable: accumulates, no revert.
        twap.setReverts(true);
        assertEq(burn.buyAndBurn(100e6), 0);
        twap.setReverts(false);
        // Pool price pushed 10% above the TWAP: the floor refuses, USDG stays.
        _setExecPrice(PRICE * 110 / 100);
        assertEq(burn.buyAndBurn(100e6), 0);
        assertEq(usdg.balanceOf(address(burn)), 100e6);
        assertEq(usdg.allowance(address(burn), address(adapter)), 0);
        _setExecPrice(PRICE);
        assertEq(burn.buyAndBurn(40e6), 20e18, "partial buy");
        assertEq(burn.totalBurned(), 20e18);
        assertEq(usdg.balanceOf(address(burn)), 60e6);
        // Only the admin sets the route.
        vm.prank(guardian);
        vm.expectRevert();
        burn.setRoute(IPriceReference(address(0)), IHedgeAdapter(address(0)), 0, 0);
    }
}
