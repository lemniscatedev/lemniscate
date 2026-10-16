// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {EngineHelper} from "../src/EngineHelper.sol";
import {LemniscateLens} from "../src/LemniscateLens.sol";
import {OptionToken} from "../src/OptionToken.sol";
import {UniswapV3HedgeAdapter} from "../src/UniswapV3HedgeAdapter.sol";
import {
    IUniswapV3FactoryLike, UniswapV3TwapReference
} from "../src/UniswapV3TwapReference.sol";
import {IWriterPool} from "../src/interfaces/IWriterPool.sol";
import {ILemniscateEngine} from "../src/interfaces/ILemniscateEngine.sol";
import {IStockToken} from "../src/interfaces/IStockToken.sol";
import {ISwapRouter02} from "../src/interfaces/ISwapRouter02.sol";
import {LemniscateMath} from "../src/libs/LemniscateMath.sol";
import {AccountView, MarketConfig, MarketView, Regime, VaultView} from "../src/libs/LemniscateTypes.sol";
import {MockBadAdapter} from "./mocks/MockBadAdapter.sol";
import {MockFeed} from "./mocks/MockFeed.sol";
import {MockMisbehavingStock} from "./mocks/MockMisbehavingStock.sol";
import {SystemFixture} from "./utils/SystemFixture.sol";
import {MockTwapFactory, MockTwapPool} from "./UniswapV3TwapReference.t.sol";

/// @notice Edge paths on the real engine + vault: insolvency, misbehaving dependencies, swap-delta checks, allowance
/// exits, and the lens views.
contract EdgeCasesTest is SystemFixture {
    address internal lp = makeAddr("lp");
    address internal trader = makeAddr("trader");

    function setUp() public {
        _deploySystem();
        usdg.mint(lp, 100_000_000 * USDG);
        usdg.mint(trader, 100_000_000 * USDG);
        vm.prank(lp);
        usdg.approve(address(vault), type(uint256).max);
        vm.prank(trader);
        usdg.approve(address(engine), type(uint256).max);
        vm.prank(lp);
        vault.deposit(1_000_000 * USDG, lp);
    }

    function _buy(uint8 id, uint256 amount) internal returns (uint256) {
        vm.prank(trader);
        return engine.buy(id, amount, 0, trader, type(uint256).max);
    }

    // ------------------------------------------------------------------ insolvency

    /// An unhedged book whose underlying doubles is insolvent: NAV < 0, share price 0, deposits closed,
    /// utilization clamped at 100%, and exits revert. Accrual still works.
    function testInsolventVaultClosesEntriesAndExits() public {
        _buy(0, 380_000 * USDG);
        feeds[0].setAnswer(300e8); // x3 spot: liability x9
        assertLt(vault.navView(), 0);
        assertEq(vault.navPerShareWad(), 0);
        assertEq(vault.totalAssets(), 0);
        assertEq(vault.maxDeposit(lp), 0);
        engine.accrueAll();
        assertEq(engine.getState(0).lastUtilBps, 10_000);
        (,,, uint256 maxIn) = engine.quoteBuy(1, USDG);
        assertEq(maxIn, 0, "no capacity while insolvent");
        vm.warp(vm.getBlockTimestamp() + 2 days);
        feeds[0].setAnswer(300e8);
        feeds[1].setAnswer(250e8);
        assertEq(vault.maxRedeem(lp), 0);
        vm.prank(trader);
        vm.expectRevert(ILemniscateEngine.GlobalCapExceeded.selector);
        engine.buy(1, 10 * USDG, 0, trader, type(uint256).max);
    }

    /// A rally pushes a capped market's liability past its capacity while NAV stays positive: stored utilization
    /// clamps at 100% and open carry sits at its maximum.
    function testUtilizationClampsAfterRallyPastCapacity() public {
        (,,, uint256 maxIn) = engine.quoteBuy(0, USDG);
        _buy(0, maxIn * 99 / 100);
        feeds[0].setAnswer(115e8); // liability x1.32, beyond the 40% market capacity
        assertGt(vault.navView(), 0);
        engine.accrueAll();
        assertEq(engine.getState(0).lastUtilBps, 10_000);
        assertEq(engine.currentCarryWad(0), 5e15, "carry at max");
    }

    /// Book where LP exits need a forced hedge sale: two LPs, a hedged power position (150% hedge ratio), locks
    /// expired, fresh feed rounds, and the pool `poolDeviationBps` away from the oracle.
    function _cashShortBook(int256 poolDeviationBps) internal returns (address lp2) {
        lp2 = makeAddr("lp2");
        usdg.mint(lp2, 500_000 * USDG);
        vm.startPrank(lp2);
        usdg.approve(address(vault), type(uint256).max);
        vault.deposit(500_000 * USDG, lp2);
        vm.stopPrank();
        vault.setParams(1 days, 1_000, 15_000, 1_000, 100, uint128(2 * USDG), uint128(1_000_000_000 * USDG));
        _buy(0, 380_000 * USDG);
        vm.prank(KEEPER);
        vault.rebalance(0);
        vm.warp(vm.getBlockTimestamp() + 1 days + 1);
        feeds[0].setAnswer(100e8);
        feeds[1].setAnswer(250e8);
        _arbPool(0, poolDeviationBps);
    }

    /// An exact-shares redeem that forces a hedge sale below the oracle value pays the redeemer less (the execution
    /// shortfall), so the remaining LP's share value does not fall.
    function testRedeemChargesHedgeSaleShortfallToRedeemer() public {
        address lp2 = _cashShortBook(-50); // pool 0.5% under the oracle, inside the 1% slippage limit
        uint256 cash = usdg.balanceOf(address(vault));
        uint256 shares = vault.previewWithdraw(cash + 100_000 * USDG);
        if (shares > vault.maxRedeem(lp)) shares = vault.maxRedeem(lp);
        uint256 quoted = vault.previewRedeem(shares);
        assertGt(quoted, cash, "redeem needs a cash raise");
        uint256 pps = vault.navPerShareWad();
        uint256 lp2Value = vault.convertToAssets(vault.balanceOf(lp2));
        vm.prank(lp);
        uint256 paid = vault.redeem(shares, lp, lp);
        assertLt(paid, quoted, "shortfall not charged");
        assertGe(vault.navPerShareWad(), pps, "remaining LPs paid the shortfall");
        assertGe(vault.convertToAssets(vault.balanceOf(lp2)), lp2Value);
    }

    /// FINDING (open): an exact-assets withdraw that needs a forced hedge sale reverts whenever the sale fills below
    /// the oracle value, which a 5 bps pool fee alone guarantees. `_ensureCash` stops once cash + shortfall covers
    /// `assets`, then `_withdrawWith` (chargeShares) still transfers the full `assets` from cash that is `shortfall`
    /// short, so the transfer reverts and the shortfall-in-shares charge is unreachable. `maxWithdraw` advertises the
    /// amount; `redeem` works (see above). When fixed, assert the withdraw succeeds, burns more than
    /// previewWithdraw, and keeps the other LP's value.
    function testExactAssetWithdrawNeedingCashRaiseChargesExtraShares() public {
        _cashShortBook(0); // pool exactly at the oracle: the fee alone makes the sale fill short
        uint256 cash = usdg.balanceOf(address(vault));
        uint256 maxAssets = vault.maxWithdraw(lp);
        uint256 assets = cash + 100_000 * USDG < maxAssets ? cash + 100_000 * USDG : maxAssets;
        assertGt(assets, cash, "withdraw needs a cash raise");
        uint256 previewShares = vault.previewWithdraw(assets);
        uint256 navPerShareBefore = vault.navPerShareWad();
        uint256 before = usdg.balanceOf(lp);
        vm.prank(lp);
        uint256 burned = vault.withdraw(assets, lp, lp);
        assertEq(usdg.balanceOf(lp) - before, assets, "exact assets paid");
        assertGt(burned, previewShares, "shortfall charged in extra shares");
        assertGe(vault.navPerShareWad(), navPerShareBefore, "remaining LPs must not lose");
    }

    function testDepositCapAndMintCap() public {
        vault.setParams(1 days, 1_000, 10_000, 1_000, 100, uint128(2 * USDG), uint128(1_000_000 * USDG));
        assertEq(vault.maxDeposit(lp), 0, "cap reached");
        vault.setParams(1 days, 1_000, 10_000, 1_000, 100, uint128(2 * USDG), uint128(1_000_100 * USDG));
        uint256 maxShares = vault.maxMint(lp);
        vm.prank(lp);
        vm.expectRevert(
            abi.encodeWithSelector(
                bytes4(keccak256("ERC4626ExceededMaxMint(address,uint256,uint256)")), lp, maxShares + 1, maxShares
            )
        );
        vault.mint(maxShares + 1, lp);
        vm.prank(lp);
        uint256 paid = vault.mint(maxShares, lp);
        assertLe(paid, 100 * USDG);
    }

    // ------------------------------------------------------------------ allowances and locks on exits

    function testThirdPartyExitSpendsAllowanceAndZeroWithdrawHonoursLock() public {
        address spender = makeAddr("spender");
        vm.prank(lp);
        vm.expectRevert(IWriterPool.WithdrawalLocked.selector); // zero-asset exit still checks the lock
        vault.withdraw(0, lp, lp);

        vm.warp(vm.getBlockTimestamp() + 1 days);
        vm.prank(lp);
        vault.approve(spender, 5e14);
        vm.prank(spender);
        uint256 burned = vault.withdraw(100 * USDG, spender, lp);
        assertEq(vault.allowance(lp, spender), 5e14 - burned);
        assertEq(usdg.balanceOf(spender), 100 * USDG);
        uint256 all = vault.balanceOf(lp);
        vm.prank(spender);
        vm.expectRevert(); // ERC20InsufficientAllowance
        vault.redeem(all, spender, lp);
    }

    // ------------------------------------------------------------------ rebalance edges

    function testRebalanceSkipsDustAndRequiresRoute() public {
        // Tiny position: hedge difference below minHedgeTradeUsdg -> no-op.
        _buy(0, USDG);
        vm.prank(KEEPER);
        assertEq(vault.rebalance(0), 0);

        // A listed market without a route cannot be hedged.
        MockFeed f = new MockFeed(8, 50e8);
        MarketConfig memory c = _marketConfig(0);
        c.stock = IStockToken(address(new MockMisbehavingStock()));
        c.feed = f;
        uint8 id = engine.listMarket(c, "X", "X", 4e15);
        _buy(id, 100_000 * USDG);
        vm.prank(KEEPER);
        vm.expectRevert(IWriterPool.InvalidRoute.selector);
        vault.rebalance(id);
    }

    function testRebalanceBuyLimitedByCashBuffer() public {
        _buy(0, 380_000 * USDG);
        vault.setParams(1 days, 5_000, 15_000, 0, 100, uint128(2_000_000 * USDG), uint128(1_000_000_000 * USDG));
        vm.prank(KEEPER);
        assertEq(vault.rebalance(0), 0, "available cash below minimum trade");
    }

    function testSwapDeltaChecksRejectMisbehavingAdapters() public {
        MockBadAdapter bad = new MockBadAdapter();
        vault.setHedgeRoute(0, bad, 500);
        _buy(0, 200_000 * USDG);

        bad.setMode(MockBadAdapter.Mode.UnderPull);
        vm.prank(KEEPER);
        vm.expectRevert(IWriterPool.InsufficientLiquidity.selector);
        vault.rebalance(0);

        bad.setMode(MockBadAdapter.Mode.ShortDelivery);
        vm.prank(KEEPER);
        vm.expectRevert(IWriterPool.InsufficientLiquidity.selector);
        vault.rebalance(0);

        bad.setMode(MockBadAdapter.Mode.Honest);
        vm.prank(KEEPER);
        vault.rebalance(0);
        uint256 units = vault.hedgeUnits(0);
        assertGt(units, 0);
        assertEq(stocks[0].balanceOf(address(vault)), units);

        // A forced sale through a failing route is skipped; with no other hedge, the payment cannot be raised.
        bad.setMode(MockBadAdapter.Mode.Reverts);
        vm.startPrank(address(engine));
        uint256 cash = usdg.balanceOf(address(vault));
        vm.expectRevert(IWriterPool.InsufficientLiquidity.selector);
        vault.pay(trader, cash + 1, 0);
        bad.setMode(MockBadAdapter.Mode.ShortDelivery);
        vm.expectRevert(IWriterPool.InsufficientLiquidity.selector);
        vault.pay(trader, cash + 1, 0);
        bad.setMode(MockBadAdapter.Mode.Honest);
        uint256 paid = vault.pay(trader, cash + 1, 0); // the sale's execution shortfall is deducted
        assertLe(paid, cash + 1);
        assertGe(paid, cash);
        vm.stopPrank();
    }

    // ------------------------------------------------------------------ misbehaving dependencies

    function testRevertingStockViewsAndSequencerPauseTheMarket() public {
        MockMisbehavingStock s = new MockMisbehavingStock();
        MockFeed f = new MockFeed(8, 50e8);
        MarketConfig memory c = _marketConfig(0);
        c.stock = IStockToken(address(s));
        c.feed = f;
        uint8 id = engine.listMarket(c, "X", "X", 4e15);
        _buy(id, 10_000 * USDG);

        s.setReverts(false, true); // transfer-pause view down: buys close, sells stay open
        assertEq(uint8(engine.currentRegime(id)), uint8(Regime.OPEN));
        vm.prank(trader);
        vm.expectRevert(ILemniscateEngine.RegimePaused.selector);
        engine.buy(id, 10 * USDG, 0, trader, type(uint256).max);

        s.setReverts(true, false); // oracle-pause view down: treated as paused
        assertEq(uint8(engine.currentRegime(id)), uint8(Regime.PAUSED));
        vm.prank(trader);
        vm.expectRevert(ILemniscateEngine.RegimePaused.selector);
        engine.buy(id, 10 * USDG, 0, trader, type(uint256).max);
        s.setReverts(false, false);

        // A sequencer feed that reverts counts as sequencer down: every market pauses.
        engine.setGlobal(5_000, 2_000, TREASURY, address(hours_));
        assertEq(uint8(engine.currentRegime(0)), uint8(Regime.PAUSED));
        assertEq(uint8(engine.currentRegime(id)), uint8(Regime.PAUSED));
    }

    function testCarryViewsAndDustBuy() public {
        assertEq(engine.dailyCarryBps(0), engine.currentCarryWad(0) * 10_000 / 1e18);
        MarketConfig memory c = engine.getConfig(0);
        c.feeBps = 100;
        c.minTradeUsdg = 1;
        engine.setMarketConfig(0, c);
        (uint256 tokensOut, uint256 fee,,) = engine.quoteBuy(0, 1);
        assertEq(fee, 1, "fee rounds up to the whole input");
        assertEq(tokensOut, 0);
        vm.prank(trader);
        vm.expectRevert(ILemniscateEngine.Slippage.selector); // zero tokens out
        engine.buy(0, 1, 0, trader, type(uint256).max);
    }

    // ------------------------------------------------------------------ helpers, token, adapter

    function testGrossInputForRoomEdges() public {
        EngineHelper helper = new EngineHelper();
        assertEq(helper.grossInputForRoom(0, 1e12, 10, 50, 40, 100), 0);
        // Impact alone would exceed the fee-adjusted price: falls back to the band-capped input.
        assertEq(helper.grossInputForRoom(1e12, 1e10, 10, 1_000, 40, 100), uint256(1e12) * 10_100 / 9_990);
        // Zero capacity charges the full band.
        assertEq(helper.grossInputForRoom(1e6, 0, 10, 50, 40, 100), uint256(1e6) * 10_100 / 9_990);
    }

    function testEmptyVaultHasNoBuyCapacity() public {
        // Fresh system: no LP capital, so NAV is zero and maxUsdgIn is zero.
        SystemFixtureProbe probe = new SystemFixtureProbe();
        probe.check();
    }

    function testOptionTokenAndAdapterConstructorsAndSwapValidation() public {
        vm.expectRevert(OptionToken.InvalidEngine.selector);
        new OptionToken("X", "X", address(0));
        vm.expectRevert(UniswapV3HedgeAdapter.InvalidRouter.selector);
        new UniswapV3HedgeAdapter(ISwapRouter02(address(0)));
        vm.expectRevert(UniswapV3HedgeAdapter.InvalidRouter.selector);
        new UniswapV3HedgeAdapter(ISwapRouter02(address(0xBEEF)));

        UniswapV3HedgeAdapter a = adapters[0];
        address u = address(usdg);
        address s = address(stocks[0]);
        vm.expectRevert(UniswapV3HedgeAdapter.InvalidSwap.selector);
        a.swapExactIn(address(0), s, 500, 1, 0, trader);
        vm.expectRevert(UniswapV3HedgeAdapter.InvalidSwap.selector);
        a.swapExactIn(u, address(0), 500, 1, 0, trader);
        vm.expectRevert(UniswapV3HedgeAdapter.InvalidSwap.selector);
        a.swapExactIn(u, u, 500, 1, 0, trader);
        vm.expectRevert(UniswapV3HedgeAdapter.InvalidSwap.selector);
        a.swapExactIn(u, s, 500, 1, 0, address(0));
        vm.expectRevert(UniswapV3HedgeAdapter.InvalidSwap.selector);
        a.swapExactIn(u, s, 0, 1, 0, trader);
        vm.expectRevert(UniswapV3HedgeAdapter.InvalidSwap.selector);
        a.swapExactIn(u, s, 500, 0, 0, trader);
    }

    function testTwapReferenceOutOfRangeTicks() public {
        MockTwapFactory factory = new MockTwapFactory();
        address stockLow = address(0x1000);
        address usd = address(0x5000);
        UniswapV3TwapReference ref = new UniswapV3TwapReference(IUniswapV3FactoryLike(address(factory)), usd, 1800);
        MockTwapPool pool = new MockTwapPool(stockLow);
        factory.setPool(stockLow, usd, 3000, address(pool));
        pool.set(int56(887_273) * 1800, false); // mean tick beyond MAX_TICK
        assertEq(ref.referencePrice(stockLow, 3000), 0);
        pool.set(-int56(887_273) * 1800, false);
        assertEq(ref.referencePrice(stockLow, 3000), 0);
        pool.set(-int56(887_272) * 1800, false); // price underflows to zero in Q128
        assertEq(ref.referencePrice(stockLow, 3000), 0);
        vm.expectRevert(UniswapV3TwapReference.InvalidParams.selector);
        ref.priceX128AtTick(887_273);
        vm.expectRevert(UniswapV3TwapReference.InvalidParams.selector);
        ref.priceX128AtTick(-887_273);
    }

    // ------------------------------------------------------------------ LemniscateMath

    function testLemniscateMath() public {
        LemniscateMathHarness h = new LemniscateMathHarness();
        assertEq(h.mulWad(3e18, 2e18), 6e18);
        assertEq(h.divWad(6e18, 2e18), 3e18);
        vm.expectRevert(LemniscateMath.DivisionByZero.selector);
        h.divWad(1, 0);
        assertEq(h.bps(10_001, 10), 10); // floors
        assertEq(h.bpsUp(10_001, 10), 11); // ceils
        assertEq(h.bpsUp(0, 10), 0);
        assertEq(h.bpsUp(10, 0), 0);
        assertEq(h.feedToWad(123e8), 123e18);
        vm.expectRevert(LemniscateMath.InvalidFeedAnswer.selector);
        h.feedToWad(0);
        vm.expectRevert(LemniscateMath.InvalidFeedAnswer.selector);
        h.feedToWad(-1);
        assertEq(h.usdgToWad(5e6), 5e18);
        assertEq(h.wadToUsdg(5e18 + 1e12 - 1), 5e6);
    }

    // ------------------------------------------------------------------ LemniscateLens

    /// The lens reports exactly what the engine and vault report, field by field.
    function testLensMatchesEngineAndVault() public {
        _buy(0, 200_000 * USDG);
        vm.prank(KEEPER);
        vault.rebalance(0);
        stocks[1].setOraclePaused(true);
        LemniscateLens lens = new LemniscateLens();
        MarketView[] memory ms = lens.markets(ILemniscateEngine(address(engine)));
        assertEq(ms.length, 2);
        for (uint8 i; i < 2; ++i) {
            MarketView memory m = ms[i];
            MarketConfig memory c = engine.getConfig(i);
            assertEq(m.id, i);
            assertEq(m.token, address(c.token));
            assertEq(m.stock, address(c.stock));
            assertEq(m.symbol, "PWR");
            assertEq(m.scale, c.scale);
            assertEq(m.regime, uint8(engine.currentRegime(i)));
            assertEq(m.buysPaused, false);
            assertEq(m.index, engine.index(i));
            assertEq(m.normFactor, engine.currentNormFactor(i));
            assertEq(m.price, engine.tokenPrice(i));
            assertEq(m.carryWad, engine.currentCarryWad(i));
            assertEq(m.vaultShort, engine.getState(i).vaultShort);
            assertEq(m.liability, engine.liability(i));
            assertEq(m.hedgeUnits, vault.hedgeUnits(i));
            assertEq(m.hedgeTarget, engine.hedgeDelta(i) * vault.hedgeRatioBps() / 10_000);
            assertEq(m.multiplier, 1e18);
            assertEq(m.oraclePaused, i == 1);
        }
        (uint256 spot0,,) = engine.spotPrice(0);
        assertEq(ms[0].spot, spot0);
        assertEq(ms[1].spot, engine.getState(1).lastGoodPrice, "paused market shows last good price");
        (,,, uint256 maxIn) = engine.quoteBuy(0, USDG);
        assertEq(ms[0].capacityUsdg, maxIn);
        assertGt(ms[0].askPrice1, ms[0].price);
        assertLt(ms[0].bidPrice1, ms[0].price);
        assertEq(ms[1].askPrice1, 0, "no ask while paused");

        VaultView memory v = lens.vault(ILemniscateEngine(address(engine)));
        assertEq(v.nav, vault.navView());
        assertEq(v.totalAssets, vault.totalAssets());
        assertEq(v.totalSupply, vault.totalSupply());
        assertEq(v.navPerShare, vault.navPerShareWad());
        assertEq(v.usdgBalance, usdg.balanceOf(address(vault)));
        assertEq(v.totalLiability, engine.totalLiability());
        assertEq(v.maxGlobalExposureBps, engine.maxGlobalExposureBps());
        assertTrue(v.publicDeposits);

        AccountView memory acct = lens.account(ILemniscateEngine(address(engine)), trader);
        assertEq(acct.user, trader);
        assertEq(acct.usdgBalance, usdg.balanceOf(trader));
        assertEq(acct.usdgAllowanceEngine, type(uint256).max);
        assertEq(acct.powerBalances[0], tokens[0].balanceOf(trader));
        assertEq(acct.writerPoolShares, 0);
        AccountView memory lpView = lens.account(ILemniscateEngine(address(engine)), lp);
        assertEq(lpView.writerPoolShares, vault.balanceOf(lp));
        assertEq(lpView.writerPoolValue, vault.convertToAssets(vault.balanceOf(lp)));
        assertEq(lpView.unlockTime, vault.unlockTime(lp));
        assertFalse(lpView.isDepositor);
    }
}

/// @dev Deploys its own empty system to check quotes against a zero-NAV vault.
contract SystemFixtureProbe is SystemFixture {
    constructor() {
        _deploySystem();
    }

    function check() external view {
        (,,, uint256 maxIn) = engine.quoteBuy(0, USDG);
        require(maxIn == 0, "capacity without NAV");
    }
}

contract LemniscateMathHarness {
    function mulWad(uint256 x, uint256 y) external pure returns (uint256) {
        return LemniscateMath.mulWad(x, y);
    }

    function divWad(uint256 x, uint256 y) external pure returns (uint256) {
        return LemniscateMath.divWad(x, y);
    }

    function bps(uint256 a, uint256 r) external pure returns (uint256) {
        return LemniscateMath.bps(a, r);
    }

    function bpsUp(uint256 a, uint256 r) external pure returns (uint256) {
        return LemniscateMath.bpsUp(a, r);
    }

    function feedToWad(int256 answer) external pure returns (uint256) {
        return LemniscateMath.feedToWad(answer);
    }

    function usdgToWad(uint256 a) external pure returns (uint256) {
        return LemniscateMath.usdgToWad(a);
    }

    function wadToUsdg(uint256 a) external pure returns (uint256) {
        return LemniscateMath.wadToUsdg(a);
    }
}
