// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PoolFixture} from "./PoolFixture.sol";
import {MockPoolPriceGuardLite} from "./PoolMocks.sol";
import {WriterPool} from "../../src/WriterPool.sol";
import {IPool} from "../../src/interfaces/IPool.sol";
import {IOptionEngine} from "../../src/interfaces/IOptionEngine.sol";
import {IPriceGuard} from "../../src/interfaces/IPriceGuard.sol";
import {IPriceReference} from "../../src/interfaces/IPriceReference.sol";
import {IReserve} from "../../src/interfaces/IReserve.sol";
import {IFeeRouter} from "../../src/interfaces/IFeeRouter.sol";
import {PoolHedging} from "../../src/libs/PoolHedging.sol";
import {IHedgeAdapter} from "../../src/interfaces/IHedgeAdapter.sol";
import {SessionKind} from "../../src/libs/OptionTypes.sol";

contract WriterPoolTest is PoolFixture {
    function setUp() public {
        _deploy();
    }

    // ------------------------------------------------------------------ R1

    function test_R1_depositMintsAtNavPlus10Bps() public {
        assertEq(pool.decimals(), 12);
        uint256 a = _deposit(alice, 1_000 * USDG);
        assertEq(a, uint256(1_000 * USDG) * 1e6 * 10_000 / 10_010);
        assertApproxEqAbs(pool.navPerShare(), 1.001e18, 1e6);

        uint256 supply = pool.totalSupply();
        uint256 expected = (uint256(1_000 * USDG) * (supply + 1e6) / (1_000 * USDG + 1)) * 10_000 / 10_010;
        assertEq(pool.previewDeposit(1_000 * USDG), expected);
        uint256 b = _deposit(bob, 1_000 * USDG);
        assertEq(b, expected);
        // Bob paid NAV + 10 bps: his share of NAV is below what he put in.
        assertLt(_shareValue(bob), 1_000 * USDG);
        assertGt(_shareValue(bob), 999 * USDG);
    }

    function test_R1_firstDepositorCannotInflate() public {
        // First deposit has a minimum, so a 1-wei bootstrap is impossible.
        usdg.mint(alice, 1e5);
        vm.startPrank(alice);
        usdg.approve(address(pool), 1e5);
        vm.expectRevert(WriterPool.InvalidParams.selector);
        pool.deposit(1e5, alice);
        vm.stopPrank();

        _deposit(alice, 1 * USDG);
        usdg.mint(alice, 100_000 * USDG);
        vm.prank(alice);
        usdg.transfer(address(pool), 100_000 * USDG); // donation to inflate the share price

        uint256 shares = _deposit(bob, 10_000 * USDG);
        assertGt(shares, 0);
        // Bob keeps at least his deposit less the 10 bps premium (virtual shares cap the rounding loss).
        assertGe(_shareValue(bob), 10_000 * USDG * 10_000 / 10_010 - 1);
        // The attacker gains nothing beyond what she donated.
        assertLe(_shareValue(alice), 100_001 * USDG + 10 * USDG);
    }

    // ------------------------------------------------------------------ R2

    function test_R2_depositAllowlistOrPublic() public {
        address stranger = makeAddr("stranger");
        usdg.mint(stranger, 100 * USDG);
        vm.startPrank(stranger);
        usdg.approve(address(pool), 100 * USDG);
        vm.expectRevert(WriterPool.NotDepositor.selector);
        pool.deposit(100 * USDG, stranger);
        assertEq(pool.maxDeposit(stranger), 0);
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, bytes32(0))
        );
        pool.setPublicDeposits(true);
        vm.stopPrank();

        pool.setPublicDeposits(true);
        assertTrue(pool.publicDeposits());
        vm.prank(stranger);
        pool.deposit(100 * USDG, stranger);
        assertGt(pool.balanceOf(stranger), 0);
    }

    function test_R2_depositLock24hAndSelfReceiver() public {
        usdg.mint(alice, 100 * USDG);
        vm.startPrank(alice);
        usdg.approve(address(pool), 100 * USDG);
        vm.expectRevert(WriterPool.InvalidParams.selector); // third-party receiver could restart bob's lock
        pool.deposit(100 * USDG, bob);
        vm.stopPrank();

        uint256 sh = _deposit(alice, 1_000 * USDG);
        assertEq(pool.unlockTime(alice), vm.getBlockTimestamp() + 1 days);
        vm.startPrank(alice);
        vm.expectRevert(WriterPool.WithdrawalLocked.selector);
        pool.transfer(bob, 1);
        vm.expectRevert(WriterPool.WithdrawalLocked.selector);
        pool.requestWithdraw(sh);
        vm.stopPrank();

        vm.warp(vm.getBlockTimestamp() + 1 days);
        vm.prank(alice);
        pool.transfer(bob, 1);
        assertEq(pool.balanceOf(bob), 1);
    }

    // ------------------------------------------------------------------ R3

    function test_R3_withdrawalQueue72h() public {
        uint256 sh = _deposit(alice, 10_000 * USDG);
        _deposit(bob, 10_000 * USDG);
        vm.warp(vm.getBlockTimestamp() + 1 days);
        uint256 t = _request(alice, sh);
        assertEq(pool.balanceOf(address(pool)), sh);
        assertEq(pool.queuedShares(), sh);
        (address owner, uint256 shares, uint64 at) = pool.ticketOf(t);
        assertEq(owner, alice);
        assertEq(shares, sh);
        assertEq(at, vm.getBlockTimestamp() + 72 hours);

        vm.warp(vm.getBlockTimestamp() + 72 hours - 1);
        vm.expectRevert(abi.encodeWithSelector(WriterPool.NotClaimable.selector, at));
        pool.claim(t);

        // NAV moves between request and claim: the ticket is paid at claim-time NAV.
        engine.setLiability(2_000e18);
        vm.warp(vm.getBlockTimestamp() + 1);
        uint256 expected = pool.previewRedeem(sh);
        vm.prank(carol); // anyone may claim; USDG goes to the owner
        uint256 paid = pool.claim(t);
        assertEq(paid, expected);
        assertEq(usdg.balanceOf(alice), paid);
        assertApproxEqRel(paid, 9_000 * USDG, 0.001e18);
        assertEq(pool.queuedShares(), 0);
        vm.expectRevert(abi.encodeWithSelector(WriterPool.UnknownTicket.selector, t));
        pool.claim(t);
    }

    function test_R3_queueIsTheOnlyExit() public {
        uint256 sh = _deposit(alice, 1_000 * USDG);
        vm.warp(vm.getBlockTimestamp() + 1 days);
        vm.startPrank(alice);
        vm.expectRevert(WriterPool.UseWithdrawalQueue.selector);
        pool.transfer(address(pool), sh);
        vm.expectRevert(WriterPool.UseWithdrawalQueue.selector);
        pool.redeem(sh, alice, alice);
        vm.expectRevert(WriterPool.UseWithdrawalQueue.selector);
        pool.withdraw(1, alice, alice);
        vm.expectRevert(WriterPool.UseWithdrawalQueue.selector);
        pool.mint(1, alice);
        vm.stopPrank();
        assertEq(pool.maxRedeem(alice), 0);
        assertEq(pool.maxWithdraw(alice), 0);
    }

    function test_R3_claimRaisesCashFromHedges() public {
        uint256 sh = _deposit(alice, 10_000 * USDG);
        _deposit(bob, 10_000 * USDG);
        _hedgeTo(150e18); // 15,000 USDG of stock, 5,000 cash left
        vm.warp(vm.getBlockTimestamp() + 1 days);
        uint256 t = _request(alice, sh);
        vm.warp(vm.getBlockTimestamp() + 72 hours);
        uint256 expected = pool.previewRedeem(sh);
        uint256 paid = pool.claim(t);
        assertEq(paid, expected); // router fills at S: no execution shortfall
        assertLt(pool.hedgeUnits(address(stock)), 150e18);
        assertEq(stock.balanceOf(address(pool)), pool.hedgeUnits(address(stock)));
        assertEq(stock.allowance(address(pool), address(adapter)), 0);
    }

    function test_R3_massExitProRataNeverLost() public {
        uint256 a = _deposit(alice, 10_000 * USDG);
        uint256 b = _deposit(bob, 10_000 * USDG);
        uint256 c = _deposit(carol, 10_000 * USDG);
        _hedgeTo(250e18); // 25,000 in stock, 5,000 cash
        vm.warp(vm.getBlockTimestamp() + 1 days);
        uint256[3] memory t = [_request(alice, a), _request(bob, b), _request(carol, c)];
        vm.warp(vm.getBlockTimestamp() + 72 hours);

        // The hedge route breaks (router has no USDG): only the 5,000 cash exists.
        uint256 routerCash = usdg.balanceOf(address(swapRouter));
        deal(address(usdg), address(swapRouter), 0);
        uint256 paidFirst;
        for (uint256 i; i < 3; ++i) {
            paidFirst += pool.claim(t[i]);
            (, uint256 left,) = pool.ticketOf(t[i]);
            assertGt(left, 0); // never lost: the rest of each ticket stays claimable
        }
        assertLe(paidFirst, 5_000 * USDG);
        assertGt(paidFirst, 2_500 * USDG);

        // Route restored: every ticket is paid out over the next claims. With every share queued, each round pays
        // the realisable value (hedges counted at their 1% slippage floor) pro rata, so the tail shrinks ~200x a round.
        deal(address(usdg), address(swapRouter), routerCash);
        uint256 paidLater;
        for (uint256 round; round < 10; ++round) {
            for (uint256 i; i < 3; ++i) {
                (, uint256 left,) = pool.ticketOf(t[i]);
                if (left != 0) paidLater += pool.claim(t[i]);
            }
        }
        for (uint256 i; i < 3; ++i) {
            (, uint256 left,) = pool.ticketOf(t[i]);
            assertEq(left, 0);
        }
        uint256 total = paidFirst + paidLater;
        assertEq(total, usdg.balanceOf(alice) + usdg.balanceOf(bob) + usdg.balanceOf(carol));
        assertGt(total, 29_800 * USDG);
        assertLe(total, 30_000 * USDG);
        assertEq(pool.queuedShares(), 0);
        assertEq(pool.totalSupply(), 0);
    }

    // ------------------------------------------------------------------ R4 (formula; fuzzed in PoolFuzz.t.sol)

    function test_R4_navFormula() public {
        _deposit(alice, 20_000 * USDG);
        _hedgeTo(50e18);
        engine.setLiability(3_000e18);
        vm.prank(hedger);
        pool.postHedgeEquity(1_000 * USDG, uint64(vm.getBlockTimestamp()), bytes32("deposit"));
        int256 expected = int256(usdg.balanceOf(address(pool)) * 1e12) + int256(50e18 * S0 / 1e18)
            + int256(1_000 * USDG * 1e12) - 3_000e18;
        (int256 raw, uint256 rs) = pool.navParts();
        assertEq(rs, 0);
        assertEq(raw, expected);
        assertEq(pool.nav(), expected);
        assertEq(pool.navFor(3_000e18), expected);
        assertEq(pool.totalAssets(), uint256(expected) / 1e12);
    }

    function test_R4_navPrefersReadLite() public {
        MockPoolPriceGuardLite lite = new MockPoolPriceGuardLite();
        _deployPool(address(lite));
        lite.setLite(address(stock), 120e18);
        _deposit(alice, 20_000 * USDG);
        _hedgeTo(10e18); // rebalance values the trade at the lite price
        assertEq(pool.nav(), int256(usdg.balanceOf(address(pool)) * 1e12) + int256(pool.hedgeUnits(address(stock)) * 120));
    }

    function test_R4_navGuardBandFromNetGreeks() public {
        _deposit(alice, 20_000 * USDG);
        engine.setLiability(5_000e18);
        engine.setGreeks(address(stock), 100e18, 0); // 100 stock-equivalents of option delta, unhedged
        (int256 mid, int256 low, int256 high) = pool.navBand();
        assertEq(high - mid, 50e18); // 0.5% move on 100 x $100
        assertEq(mid - low, 50e18);
        assertLt(pool.previewDeposit(1_000 * USDG), _midShares(1_000 * USDG));

        // Fully hedged: only the gamma term remains, on both sides.
        _hedgeTo(100e18);
        engine.setGreeks(address(stock), 100e18, 10e18);
        (mid, low, high) = pool.navBand();
        assertEq(high, mid);
        assertEq(mid - low, 1.25e18);

        // Closed session: the wider move applies.
        guard.set(address(stock), S0, SessionKind.CLOSED, true);
        (mid, low, high) = pool.navBand();
        assertEq(mid - low, 45e18); // 10 x 3^2 / 2
    }

    function _midShares(uint256 assets) private view returns (uint256) {
        uint256 navAssets = uint256(pool.nav()) / 1e12;
        return assets * (pool.totalSupply() + 1e6) / (navAssets + 1) * 10_000 / 10_010;
    }

    // ------------------------------------------------------------------ R5

    function test_R5_hedgeEquityPosts() public {
        _deposit(alice, 20_000 * USDG);
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, alice, pool.HEDGER_ROLE())
        );
        vm.prank(alice);
        pool.postHedgeEquity(1, uint64(vm.getBlockTimestamp()), bytes32(0));

        vm.startPrank(hedger);
        vm.expectRevert(abi.encodeWithSelector(WriterPool.BadAsOf.selector, uint64(vm.getBlockTimestamp() + 1)));
        pool.postHedgeEquity(1_000 * USDG, uint64(vm.getBlockTimestamp() + 1), bytes32("fill"));
        // From zero every change is a jump: the first post needs a fill reference.
        vm.expectRevert(abi.encodeWithSelector(IPool.HedgeJump.selector, 0, 1_000 * USDG));
        pool.postHedgeEquity(1_000 * USDG, uint64(vm.getBlockTimestamp()), bytes32(0));
        pool.postHedgeEquity(1_000 * USDG, uint64(vm.getBlockTimestamp()), bytes32("fill"));

        vm.warp(vm.getBlockTimestamp() + 1 hours);
        pool.postHedgeEquity(1_100 * USDG, uint64(vm.getBlockTimestamp()), bytes32(0)); // +10% in 1h: allowed
        vm.warp(vm.getBlockTimestamp() + 30 minutes);
        vm.expectRevert(abi.encodeWithSelector(IPool.HedgeJump.selector, 1_100 * USDG, 1_200 * USDG));
        pool.postHedgeEquity(1_200 * USDG, uint64(vm.getBlockTimestamp()), bytes32(0)); // +9% in 30 min: too fast
        pool.postHedgeEquity(1_200 * USDG, uint64(vm.getBlockTimestamp()), bytes32("fill"));
        vm.expectRevert(abi.encodeWithSelector(WriterPool.BadAsOf.selector, uint64(vm.getBlockTimestamp())));
        pool.postHedgeEquity(1_200 * USDG, uint64(vm.getBlockTimestamp()), bytes32("fill")); // asOf must advance
        vm.stopPrank();

        (uint256 eq, uint64 asOf) = pool.hedgeEquity();
        assertEq(eq, 1_200 * USDG);
        assertEq(asOf, vm.getBlockTimestamp());
        int256 withEquity = pool.nav();
        assertFalse(pool.hedgeStale());
        vm.warp(vm.getBlockTimestamp() + 2 hours + 1);
        assertTrue(pool.hedgeStale());
        assertEq(pool.nav(), withEquity - int256(1_200 * USDG * 1e12)); // stale equity is not counted
    }

    // ------------------------------------------------------------------ R6

    function test_R6_reserveAbsorbsFirst() public {
        _deposit(alice, 50_000 * USDG);
        _deposit(bob, 50_000 * USDG);
        // Reserve takes 15% of spread income, up to 5% of NAV (5,000).
        _engineBuy(10_000 * USDG, 10_000 * USDG, 0);
        assertEq(reserve.balance(), 1_500 * USDG);
        for (uint256 i; i < 4; ++i) {
            _engineBuy(10_000 * USDG, 10_000 * USDG, 0);
        }
        assertEq(reserve.balance(), pool.lastNavUsdg() * 500 / 10_000);
        pool.checkpoint();
        uint256 nps0 = pool.navPerShare();
        uint256 r0 = reserve.balance();

        // Staged loss smaller than the reserve: LP NAV per share does not move.
        engine.setLiability(3_000e18);
        assertApproxEqAbs(pool.navPerShare(), nps0, 1);
        (, uint256 rs) = pool.navParts();
        assertApproxEqAbs(rs, 3_000e18, 1e12);

        // An exit during the loss realises its part of the reserve share; the remaining LP keeps the same NAV/share.
        vm.warp(vm.getBlockTimestamp() + 1 days);
        uint256 t = _request(alice, pool.balanceOf(alice));
        vm.warp(vm.getBlockTimestamp() + 72 hours);
        pool.claim(t);
        assertLt(reserve.balance(), r0);
        assertApproxEqAbs(r0 - reserve.balance(), 1_500 * USDG, 2 * USDG);
        assertApproxEqRel(pool.navPerShare(), nps0, 1e12);

        // Loss beyond what is left in the reserve: only the excess (1,000) reaches LP NAV. The remaining LP carries
        // the whole liability, so the deficit is the reserve share still in use plus the new loss.
        uint256 supply = pool.totalSupply();
        uint256 rLeft = reserve.balance();
        (, uint256 rsNow) = pool.navParts();
        engine.setLiability(3_000e18 - rsNow + rLeft * 1e12 + 1_000e18);
        uint256 expected = nps0 - 1_000e18 * 1e12 / supply;
        assertApproxEqRel(pool.navPerShare(), expected, 1e12);

        // Exhausted: the checkpoint moves the defended level down to the new NAV per share.
        pool.checkpoint();
        assertApproxEqAbs(pool.highWaterNavPerShare(), pool.navPerShare(), 1);
    }

    function test_R6_payDrawsReserveOnlyUpToItsShare() public {
        _deposit(alice, 10_000 * USDG);
        _engineBuy(4_000 * USDG, 4_000 * USDG, 0); // reserve 15% of 4,000 = 600 (target 500 of 10k NAV)
        assertEq(reserve.balance(), 500 * USDG);
        pool.checkpoint();
        uint256 cash = usdg.balanceOf(address(pool));
        // A loss of 100 below the high-water mark: the reserve share is 100 of its 500.
        engine.setLiability(100e18);
        (, uint256 rs) = pool.navParts();
        assertApproxEqAbs(rs, 100e18, 1e12);
        uint256 share = rs / 1e12;
        // A payout beyond cash can draw only that share, not the whole reserve.
        vm.prank(address(engine));
        vm.expectRevert(abi.encodeWithSelector(IPool.Insolvent.selector, cash + 300 * USDG, cash + share));
        pool.pay(seller, cash + 300 * USDG, 0);
        vm.prank(address(engine));
        pool.pay(seller, cash + share, 0);
        assertEq(usdg.balanceOf(seller), cash + share);
        assertEq(reserve.balance(), 500 * USDG - share);
    }

    // ------------------------------------------------------------------ R7 (router unit tests in FeeRouter.t.sol)

    function test_R7_protocolFeeOnSpreadAndFunding() public {
        _deposit(alice, 100_000 * USDG);
        _engineBuy(10_000 * USDG, 1_000 * USDG, 9_000 * USDG);
        assertEq(usdg.balanceOf(address(fees)), 100 * USDG); // 10% of spread
        engine.accrue(bytes32("s"), 500 * USDG);
        assertEq(usdg.balanceOf(address(fees)), 150 * USDG); // + 10% of funding
        vm.prank(address(engine));
        pool.pay(seller, 1_000 * USDG, 200 * USDG);
        assertEq(usdg.balanceOf(address(fees)), 170 * USDG);
    }

    function test_R7_feeOwedWhenCashIsShort() public {
        _deposit(alice, 10_000 * USDG);
        pool.setParams(1 days, 0, 100, uint128(2_000_000 * USDG)); // no cash buffer
        _hedgeTo(100e18); // all cash into stock
        assertEq(usdg.balanceOf(address(pool)), 0);
        engine.setLiability(1_000e18);
        int256 before = pool.nav();
        engine.accrue(bytes32("s"), 1_000 * USDG); // fee 100 cannot be paid in cash
        assertEq(pool.feeOwed(), 100 * USDG);
        assertEq(pool.nav(), before + 1_000e18 - 100e18);
        _engineBuy(1_000 * USDG, 0, 0); // next inflow settles it
        assertEq(pool.feeOwed(), 0);
        assertEq(usdg.balanceOf(address(fees)), 100 * USDG);
    }

    // ------------------------------------------------------------------ R8

    /// @dev Todo 07b: the engine's parameters are the one source of truth; the pool only mirrors `engine.capBps()`.
    function test_R8_capsExposedToEngine() public {
        assertEq(pool.maxOutstandingBps(), 3_500);
        assertEq(pool.maxPerNameBps(), 800);
        _deposit(alice, 100_000 * USDG);
        (uint256 total, uint256 perName) = pool.capsFor(10_000e18);
        assertEq(total, 90_000e18 * 3_500 / 10_000);
        assertEq(perName, 90_000e18 * 800 / 10_000);

        engine.setCapBps(2_000, 500); // an engine parameter change shows through, nothing to set on the pool
        assertEq(pool.maxOutstandingBps(), 2_000);
        assertEq(pool.maxPerNameBps(), 500);
        (total, perName) = pool.capsFor(10_000e18);
        assertEq(total, 90_000e18 * 2_000 / 10_000);
        engine.setLiability(200_000e18);
        (total, perName) = pool.capsFor(200_000e18);
        assertEq(total + perName, 0);
    }

    // ------------------------------------------------------------------ R9

    function test_R9_engineOnly() public {
        vm.startPrank(alice);
        vm.expectRevert(IPool.NotEngine.selector);
        pool.onSale(bytes32("s"), 1, 1);
        vm.expectRevert(IPool.NotEngine.selector);
        pool.onFunding(bytes32("s"), 1);
        vm.expectRevert(IPool.NotEngine.selector);
        pool.pay(alice, 1, 0);
        vm.stopPrank();
    }

    function test_R9_payRaisesCashThenRevertsInsolvent() public {
        _deposit(alice, 10_000 * USDG);
        _hedgeTo(60e18); // 6,000 in stock, 4,000 cash
        vm.prank(address(engine));
        pool.pay(seller, 7_000 * USDG, 0);
        assertEq(usdg.balanceOf(seller), 7_000 * USDG);
        assertLt(pool.hedgeUnits(address(stock)), 60e18);
        assertEq(usdg.allowance(address(pool), address(adapter)), 0);
        assertEq(stock.allowance(address(pool), address(adapter)), 0);

        uint256 cash = usdg.balanceOf(address(pool));
        uint256 stockValue = pool.hedgeUnits(address(stock)) * S0 / 1e30;
        vm.prank(address(engine));
        // Everything is sold first (cash then equals cash + stock value), then it is still one wei short.
        vm.expectRevert(abi.encodeWithSelector(IPool.Insolvent.selector, cash + stockValue + 1, cash + stockValue));
        pool.pay(seller, cash + stockValue + 1, 0);
    }

    // ------------------------------------------------------------------ R10 (fuzzed in PoolFuzz.t.sol)

    function test_R10_navRoundTripNeverProfits() public {
        _deposit(bob, 50_000 * USDG);
        uint256 sh = _deposit(alice, 10_000 * USDG);
        vm.warp(vm.getBlockTimestamp() + 1 days);
        uint256 t = _request(alice, sh);
        vm.warp(vm.getBlockTimestamp() + 72 hours);
        uint256 paid = pool.claim(t);
        assertLe(paid, 10_000 * USDG);
    }

    // ------------------------------------------------------------------ R11

    function test_R11_guardianPausesDepositsOnly() public {
        uint256 sh = _deposit(alice, 10_000 * USDG);
        vm.prank(guardian);
        pool.setDepositsPaused(true);
        assertTrue(pool.depositsPaused());
        assertEq(pool.maxDeposit(bob), 0);
        usdg.mint(bob, 100 * USDG);
        vm.startPrank(bob);
        usdg.approve(address(pool), 100 * USDG);
        vm.expectRevert(WriterPool.DepositsPaused.selector);
        pool.deposit(100 * USDG, bob);
        vm.stopPrank();

        // Guardian cannot unpause, change caps, params or routes.
        vm.startPrank(guardian);
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, guardian, pool.GUARDIAN_ROLE())
        );
        pool.setDepositsPaused(false);
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, guardian, bytes32(0))
        );
        pool.setParams(0, 0, 0, 0);
        vm.stopPrank();

        // Claims and engine pay-outs keep working while deposits are paused.
        vm.prank(address(engine));
        pool.pay(seller, 100 * USDG, 0);
        vm.warp(vm.getBlockTimestamp() + 1 days);
        uint256 t = _request(alice, sh);
        vm.warp(vm.getBlockTimestamp() + 72 hours);
        assertGt(pool.claim(t), 0);

        pool.setDepositsPaused(false);
        assertFalse(pool.depositsPaused());
    }

    // ------------------------------------------------------------------ R13

    function test_R13_poolHoldsSpotHedges() public {
        _deposit(alice, 20_000 * USDG);
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, alice, pool.HEDGER_ROLE())
        );
        vm.prank(alice);
        pool.rebalance(address(stock), 1e18, 0);

        int256 navBefore = pool.nav();
        vm.prank(hedger);
        int256 d = pool.rebalance(address(stock), 50e18, 0);
        assertEq(d, 50e18);
        assertEq(pool.hedgeUnits(address(stock)), 50e18);
        assertEq(stock.balanceOf(address(pool)), 50e18);
        assertEq(pool.nav(), navBefore); // filled at S: NAV unchanged, stock valued at the PriceGuard S
        assertEq(usdg.allowance(address(pool), address(adapter)), 0);
        assertEq(usdg.allowance(address(adapter), address(swapRouter)), 0);

        // Price moves: NAV follows the PriceGuard price.
        _setPrice(110e18);
        assertEq(pool.nav(), navBefore + int256(50e18 * 10));

        vm.prank(hedger);
        d = pool.rebalance(address(stock), 20e18, 0);
        assertEq(d, -30e18);
        assertEq(stock.allowance(address(pool), address(adapter)), 0);
        assertEq(pool.hedgeUnits(address(stock)), 20e18);
    }

    function test_R13_rebalanceIsTwapFlooredAndCallerBounded() public {
        _deposit(alice, 20_000 * USDG);
        _hedgeTo(50e18);
        pool.setModules(
            IOptionEngine(address(engine)), IReserve(address(reserve)), IFeeRouter(address(fees)), IPriceReference(address(twap))
        );
        // The pool trades 2% under the oracle/TWAP: a sale is refused (slippage allowance 1%).
        twap.setPrice(S0);
        _setRouterPrice(98e18);
        vm.prank(hedger);
        vm.expectRevert(PoolHedging.InvalidRoute.selector);
        pool.rebalance(address(stock), 0, 0);
        // TWAP above the oracle lifts the sale floor even when the router matches the oracle.
        _setRouterPrice(S0);
        twap.setPrice(102e18);
        vm.prank(hedger);
        vm.expectRevert(PoolHedging.InvalidRoute.selector);
        pool.rebalance(address(stock), 0, 0);
        // Buys: the cheaper reference sets the minimum units.
        twap.setPrice(97e18);
        vm.prank(hedger);
        vm.expectRevert(PoolHedging.InvalidRoute.selector);
        pool.rebalance(address(stock), 60e18, 0);
        // A reverting TWAP source falls back to the oracle.
        twap.setReverts(true);
        vm.prank(hedger);
        pool.rebalance(address(stock), 60e18, 0);
        // Caller's own bound: minimum USDG out on sells.
        vm.prank(hedger);
        vm.expectRevert(PoolHedging.InvalidRoute.selector);
        pool.rebalance(address(stock), 50e18, 1_000 * USDG + 1);
        // Caller's own bound: maximum USDG in on buys.
        vm.prank(hedger);
        pool.rebalance(address(stock), 70e18, 500 * USDG);
        assertEq(pool.hedgeUnits(address(stock)), 65e18);
    }

    function test_R13_rebalanceNeedsFreshPriceRouteAndCash() public {
        _deposit(alice, 10_000 * USDG);
        guard.set(address(stock), S0, SessionKind.HALTED, false);
        vm.prank(hedger);
        vm.expectRevert(abi.encodeWithSelector(PoolHedging.StalePrice.selector, address(stock)));
        pool.rebalance(address(stock), 1e18, 0);
        _setPrice(S0);
        vm.prank(hedger);
        vm.expectRevert(PoolHedging.InvalidRoute.selector);
        pool.rebalance(makeAddr("noRoute"), 1e18, 0);
        // Cash buffer: 10% of NAV stays in cash.
        vm.prank(hedger);
        pool.rebalance(address(stock), 1_000e18, 0);
        assertEq(usdg.balanceOf(address(pool)), 1_000 * USDG);
        vm.prank(hedger);
        vm.expectRevert(PoolHedging.NoCash.selector);
        pool.rebalance(address(stock), 1_000e18, 0);
    }

    function test_R13_routeAndSyncAdminOnly() public {
        vm.expectRevert(WriterPool.InvalidRoute.selector);
        pool.setHedgeRoute(address(stock), adapter, 0);
        vm.expectRevert(WriterPool.InvalidRoute.selector);
        pool.setHedgeRoute(address(stock), IHedgeAdapter(makeAddr("eoa")), FEE);
        vm.expectRevert("unknown stock");
        pool.setHedgeRoute(makeAddr("unknownStock"), adapter, FEE);
        stock.mint(address(pool), 3e18);
        pool.syncHedgeUnits(address(stock));
        assertEq(pool.hedgeUnits(address(stock)), 3e18);
        assertEq(pool.hedgeStocks().length, 1);
        (, uint24 fee) = pool.routeOf(address(stock));
        assertEq(fee, FEE);
    }

    // ------------------------------------------------------------------ upgrade and init

    function test_upgradeAdminOnlyAndInitLocked() public {
        WriterPool next = new WriterPool();
        vm.prank(alice);
        vm.expectRevert();
        pool.upgradeToAndCall(address(next), "");
        pool.upgradeToAndCall(address(next), "");
        vm.expectRevert();
        pool.initialize(alice, IERC20(address(usdg)), IOptionEngine(address(engine)), IPriceGuard(address(guard)));
        vm.expectRevert();
        next.initialize(alice, IERC20(address(usdg)), IOptionEngine(address(engine)), IPriceGuard(address(guard)));
        vm.expectRevert(WriterPool.InvalidParams.selector);
        new ERC1967Proxy(
            address(next),
            abi.encodeCall(WriterPool.initialize, (address(0), IERC20(address(usdg)), IOptionEngine(address(0)), IPriceGuard(address(guard))))
        );
        // The engine can be set once only.
        vm.expectRevert(WriterPool.InvalidParams.selector);
        pool.setModules(IOptionEngine(alice), IReserve(address(reserve)), IFeeRouter(address(fees)), IPriceReference(address(0)));
    }
}
