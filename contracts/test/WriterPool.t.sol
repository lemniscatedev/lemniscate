// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {WriterPool} from "../src/WriterPool.sol";
import {UniswapV3HedgeAdapter} from "../src/UniswapV3HedgeAdapter.sol";
import {IWriterPool} from "../src/interfaces/IWriterPool.sol";
import {ILemniscateEngine} from "../src/interfaces/ILemniscateEngine.sol";
import {ISwapRouter02} from "../src/interfaces/ISwapRouter02.sol";
import {Regime} from "../src/libs/LemniscateTypes.sol";
import {MockStockToken} from "./mocks/MockStockToken.sol";
import {MockSwapRouter} from "./mocks/MockSwapRouter.sol";
import {MockUSDG} from "./mocks/MockUSDG.sol";
import {MockReserveShiftAdapter} from "./mocks/MockReserveShiftAdapter.sol";
import {MockVaultEngine} from "./mocks/MockVaultEngine.sol";

contract WriterPoolTest is Test {
    uint24 private constant POOL_FEE = 500;
    uint256 private constant USDG = 1e6;

    address private alice = makeAddr("alice");
    address private bob = makeAddr("bob");

    MockUSDG private usdg;
    MockStockToken private stock;
    MockSwapRouter private router;
    MockVaultEngine private engine;
    UniswapV3HedgeAdapter private adapter;
    WriterPool private vault;

    function setUp() public {
        usdg = new MockUSDG();
        stock = new MockStockToken();
        router = new MockSwapRouter();
        engine = new MockVaultEngine(IERC20(address(usdg)));
        engine.addMarket(stock, 1e18);
        adapter = new UniswapV3HedgeAdapter(ISwapRouter02(address(router)));

        WriterPool implementation = new WriterPool();
        bytes memory initData =
            abi.encodeCall(WriterPool.initialize, (address(this), IERC20(address(usdg)), ILemniscateEngine(address(engine))));
        ERC1967Proxy proxy = new ERC1967Proxy(address(implementation), initData);
        vault = WriterPool(address(proxy));

        vault.setParams(1 days, 1_000, 10_000, 1_000, 100, uint128(2 * USDG), uint128(1_000 * USDG));
        vault.setHedgeRoute(0, adapter, POOL_FEE);
        vault.setDepositor(alice, true);
        vault.setDepositor(bob, true);

        router.setRate(address(usdg), address(stock), POOL_FEE, 11e29);
        router.setRate(address(stock), address(usdg), POOL_FEE, 1e6);
        usdg.mint(address(router), 10_000 * USDG);
        stock.mint(address(router), 10_000e18);
    }

    function testBootstrapDepositUsesTwelveDecimalsAndMaxMintRoundsDown() public {
        assertEq(vault.decimals(), 12);
        assertEq(vault.totalAssets(), 0);
        assertEq(vault.navPerShareWad(), 1e18);
        assertEq(vault.maxDeposit(alice), 1_000 * USDG);
        assertLe(vault.previewMint(vault.maxMint(alice)), vault.maxDeposit(alice));

        _deposit(alice, USDG);
        assertEq(vault.balanceOf(alice), 1e12);
        assertEq(vault.totalAssets(), USDG);
        assertEq(vault.unlockTime(alice), block.timestamp + 1 days);
    }

    function testInflationDonationDoesNotLetFirstDepositorCaptureVictimDeposit() public {
        _deposit(alice, 1);
        usdg.mint(address(vault), 100 * USDG);
        _deposit(bob, USDG);

        assertLt(vault.convertToAssets(vault.balanceOf(alice)), 51 * USDG);
    }

    function testSelfReceiverRulePreventsThirdPartyDepositFromResettingLock() public {
        _deposit(alice, 10 * USDG);
        uint256 originalUnlock = vault.unlockTime(alice);

        usdg.mint(bob, USDG);
        vm.startPrank(bob);
        usdg.approve(address(vault), USDG);
        vm.expectRevert(IWriterPool.InvalidParams.selector);
        vault.deposit(USDG, alice);
        vm.stopPrank();

        assertEq(vault.unlockTime(alice), originalUnlock);
    }

    function testLockedSharesCannotBeTransferredEvenToAnEmptyAccount() public {
        _deposit(alice, 10 * USDG);
        uint256 amount = vault.balanceOf(alice) / 2;
        address freshPool = makeAddr("freshPool");

        vm.startPrank(alice);
        vm.expectRevert(IWriterPool.WithdrawalLocked.selector);
        vault.transfer(freshPool, 1);
        vm.expectRevert(IWriterPool.WithdrawalLocked.selector);
        vault.transfer(bob, amount);
        vault.approve(bob, amount);
        vm.stopPrank();

        vm.prank(bob);
        vm.expectRevert(IWriterPool.WithdrawalLocked.selector);
        vault.transferFrom(alice, bob, amount);
        assertEq(vault.unlockTime(freshPool), 0);
        assertEq(vault.unlockTime(bob), 0);

        vm.warp(vault.unlockTime(alice));
        vm.prank(alice);
        vault.transfer(freshPool, 1);
        assertEq(vault.unlockTime(freshPool), 0);
    }

    function testLockedSharesCannotDustAnExistingHolder() public {
        _deposit(bob, 10 * USDG);
        vm.warp(vault.unlockTime(bob));
        uint256 bobUnlock = vault.unlockTime(bob);
        _deposit(alice, 10 * USDG);

        vm.prank(alice);
        vm.expectRevert(IWriterPool.WithdrawalLocked.selector);
        vault.transfer(bob, 1);
        assertEq(vault.unlockTime(bob), bobUnlock);
        assertGt(vault.maxRedeem(bob), 0);

        vm.warp(vault.unlockTime(alice));
        vm.prank(alice);
        vault.transfer(bob, 1);
    }

    function testLockDurationIsBounded() public {
        vm.expectRevert(IWriterPool.InvalidParams.selector);
        vault.setParams(30 days + 1, 1_000, 10_000, 1_000, 100, uint128(2 * USDG), uint128(1_000 * USDG));
    }

    function testPaySkipsFailingHedgeRouteAndUsesAnotherMarket() public {
        MockStockToken stock2 = new MockStockToken();
        engine.addMarket(stock2, 1e18);
        vault.setHedgeRoute(1, adapter, POOL_FEE);
        router.setRate(address(stock2), address(usdg), POOL_FEE, 1e6);
        usdg.mint(address(router), 10_000 * USDG);
        stock.mint(address(vault), 10e18);
        stock2.mint(address(vault), 10e18);
        vault.syncHedgeUnits(0);
        vault.syncHedgeUnits(1);
        router.setRate(address(stock), address(usdg), POOL_FEE, 1e5); // market 0 swap now misses minOut

        address recipient = makeAddr("recipient");
        vm.prank(address(engine));
        vault.pay(recipient, 5 * USDG, 0);

        assertEq(usdg.balanceOf(recipient), 5 * USDG);
        assertEq(vault.hedgeUnits(0), 10e18);
        assertLt(vault.hedgeUnits(1), 10e18);
        assertEq(stock.allowance(address(vault), address(adapter)), 0);
    }

    function testNavGuardNeutralizesDepositorFrontRunningOfFeedUpdate() public {
        _deposit(bob, 100 * USDG);
        // Unhedged $20 power liability at spot $1: a 0.5% feed drop raises NAV by 20·(1 − 0.995²) = $0.1995.
        engine.setMarket(0, Regime.OPEN, 1e18, true, 1e18, 20e18, 0);
        (int256 nav, int256 low, int256 high) = vault.navBand();
        assertEq(nav, 80e18);
        assertEq(high - nav, 0.1995e18);
        assertEq(nav - low, 0.2005e18);
        assertLt(vault.previewDeposit(10 * USDG), vault.convertToShares(10 * USDG));

        // Alice knows the drop is coming, deposits, the feed moves, and she exits after the lock.
        _deposit(alice, 10 * USDG);
        engine.setMarket(0, Regime.OPEN, 0.995e18, true, 0.995e18, 19.8005e18, 0);
        vm.warp(vault.unlockTime(alice));
        uint256 shares = vault.balanceOf(alice);
        vm.prank(alice);
        uint256 out = vault.redeem(shares, alice, alice);
        assertLe(out, 10 * USDG, "front-running a known feed move must not profit");
    }

    function testWithoutNavGuardTheSameFrontRunProfits() public {
        vault.setNavGuard(0, 0);
        _deposit(bob, 100 * USDG);
        engine.setMarket(0, Regime.OPEN, 1e18, true, 1e18, 20e18, 0);
        _deposit(alice, 10 * USDG);
        engine.setMarket(0, Regime.OPEN, 0.995e18, true, 0.995e18, 19.8005e18, 0);
        vm.warp(vault.unlockTime(alice));
        uint256 shares = vault.balanceOf(alice);
        vm.prank(alice);
        assertGt(vault.redeem(shares, alice, alice), 10 * USDG);
    }

    function testNavGuardChargesOnlyGammaWhenFullyHedged() public {
        _deposit(bob, 100 * USDG);
        stock.mint(address(vault), 40e18);
        vault.syncHedgeUnits(0);
        // Delta-neutral: hedge value 2L. Only the short-gamma term L·m² remains.
        engine.setMarket(0, Regime.OPEN, 1e18, true, 1e18, 20e18, 0);
        (int256 nav, int256 low, int256 high) = vault.navBand();
        assertEq(high, nav);
        assertEq(nav - low, 0.0005e18);
    }

    function testNavGuardUsesClosedMoveOffHoursAndIsAdminBounded() public {
        _deposit(bob, 100 * USDG);
        engine.setMarket(0, Regime.OFF_HOURS, 1e18, true, 1e18, 20e18, 0);
        (int256 nav, int256 low,) = vault.navBand();
        assertEq(nav - low, 20e18 * 600 / 10_000 + 20e18 * 9 / 10_000);

        vm.expectRevert(IWriterPool.InvalidParams.selector);
        vault.setNavGuard(2_001, 300);
        vault.setNavGuard(0, 0);
        (nav, low,) = vault.navBand();
        assertEq(low, nav);
        assertEq(vault.previewRedeem(1e12), vault.convertToAssets(1e12));
    }

    function testWithdrawAndRedeemStayInsideLiabilityReserve() public {
        _deposit(alice, 100 * USDG);
        engine.setMarket(0, Regime.OPEN, 1e18, true, 1e18, 10e18, 0);
        vm.warp(vault.unlockTime(alice));

        uint256 maximumAssets = vault.maxWithdraw(alice);
        uint256 maximumShares = vault.maxRedeem(alice);
        assertEq(maximumAssets, 70 * USDG);
        assertLe(vault.previewRedeem(maximumShares), maximumAssets);
        assertLe(vault.previewMint(vault.maxMint(alice)), vault.maxDeposit(alice));

        vm.prank(alice);
        vault.withdraw(maximumAssets, alice, alice);
        assertGe(vault.navView(), int256(20e18));
    }

    function testWithdrawalRechecksReserveAfterCashRaiseChangesLiability() public {
        _deposit(alice, 100 * USDG);
        stock.mint(address(vault), 20e18);
        vault.syncHedgeUnits(0);
        MockReserveShiftAdapter shiftingAdapter = new MockReserveShiftAdapter(engine);
        vault.setHedgeRoute(0, shiftingAdapter, POOL_FEE);
        vm.warp(vault.unlockTime(alice));

        uint256 conservativeMaximum = vault.maxWithdraw(alice);
        assertEq(conservativeMaximum, 119_800_000);
        assertLe(vault.previewRedeem(vault.maxRedeem(alice)), conservativeMaximum);

        vm.prank(alice);
        vm.expectRevert(IWriterPool.InsufficientLiquidity.selector);
        vault.withdraw(conservativeMaximum, alice, alice);

        assertEq(engine.totalLiability(), 0);
        assertEq(vault.totalAssets(), 120 * USDG);
    }

    function testNavUsesLastGoodPriceWhilePausedEvenWhenSpotRoundIsValid() public {
        usdg.mint(address(vault), 100 * USDG);
        stock.mint(address(vault), 2e18);
        vault.syncHedgeUnits(0);
        engine.setMarket(0, Regime.PAUSED, 100e18, true, 10e18, 0, 0);

        assertEq(vault.navView(), int256(120e18));

        engine.setMarket(0, Regime.OPEN, 100e18, true, 10e18, 0, 0);
        assertEq(vault.navView(), int256(300e18));
        engine.setMarket(0, Regime.OPEN, 100e18, false, 10e18, 0, 0);
        assertEq(vault.navView(), int256(120e18));
    }

    function testRebalanceTracksActualStockDeltaAndResetsApprovals() public {
        _deposit(alice, 100 * USDG);
        engine.setMarket(0, Regime.OPEN, 1e18, true, 1e18, 0, 10e18);

        int256 bought = vault.rebalance(0);
        assertEq(bought, int256(11e18));
        assertEq(vault.hedgeUnits(0), 11e18);
        assertEq(stock.balanceOf(address(vault)), 11e18);
        assertEq(usdg.allowance(address(vault), address(adapter)), 0);
        assertEq(stock.allowance(address(adapter), address(router)), 0);

        engine.setMarket(0, Regime.OPEN, 1e18, true, 1e18, 0, 8e18);
        int256 sold = vault.rebalance(0);
        assertEq(sold, -int256(3e18));
        assertEq(vault.hedgeUnits(0), 8e18);
        assertEq(stock.balanceOf(address(vault)), 8e18);
        assertEq(usdg.allowance(address(vault), address(adapter)), 0);
        assertEq(stock.allowance(address(adapter), address(router)), 0);
    }

    function testRebalanceRejectsPausedRegime() public {
        engine.setMarket(0, Regime.PAUSED, 1e18, true, 1e18, 0, 10e18);

        vm.expectRevert(IWriterPool.RegimePaused.selector);
        vault.rebalance(0);
    }

    function testPayRaisesCashFromHedgeAndRevertsWhenHedgeCannotCoverPayment() public {
        stock.mint(address(vault), 10e18);
        vault.syncHedgeUnits(0);
        address recipient = makeAddr("recipient");

        int256 navBefore = vault.navView();
        vm.prank(address(engine));
        uint256 paid = vault.pay(recipient, 5 * USDG, 0);

        // The hedge sale's execution shortfall comes out of the payment, never out of the remaining LPs.
        assertEq(usdg.balanceOf(recipient), paid);
        assertLe(paid, 5 * USDG);
        assertGe(paid, 5 * USDG * 99 / 100);
        assertGe(vault.navView(), navBefore - int256(5 * USDG * 1e12));
        assertEq(vault.hedgeUnits(0), stock.balanceOf(address(vault)));
        assertEq(usdg.allowance(address(vault), address(adapter)), 0);
        assertEq(stock.allowance(address(vault), address(adapter)), 0);

        vm.prank(address(engine));
        vm.expectRevert(IWriterPool.InsufficientLiquidity.selector);
        vault.pay(recipient, 20 * USDG, 0);
    }

    function testAdapterPullsCallerFundsAndResetsRouterApproval() public {
        usdg.mint(address(this), USDG);
        usdg.approve(address(adapter), USDG);

        uint256 received = adapter.swapExactIn(address(usdg), address(stock), POOL_FEE, USDG, 1e18, address(this));

        assertEq(received, 1.1e18);
        assertEq(stock.balanceOf(address(this)), 1.1e18);
        assertEq(usdg.allowance(address(adapter), address(router)), 0);
        assertEq(usdg.allowance(address(this), address(adapter)), 0);
    }

    function _deposit(address account, uint256 assets) private {
        usdg.mint(account, assets);
        vm.startPrank(account);
        usdg.approve(address(vault), assets);
        vault.deposit(assets, account);
        vm.stopPrank();
    }
}
