// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Test} from "forge-std/Test.sol";
import {IWriterPool} from "../src/interfaces/IWriterPool.sol";
import {IMarketHours} from "../src/interfaces/IMarketHours.sol";
import {ILemniscateEngine} from "../src/interfaces/ILemniscateEngine.sol";
import {MarketConfig, MarketState, Regime} from "../src/libs/LemniscateTypes.sol";
import {LemniscateEngine} from "../src/LemniscateEngine.sol";
import {OptionToken} from "../src/OptionToken.sol";
import {MockFeed} from "./mocks/MockFeed.sol";
import {MockMarketHours} from "./mocks/MockMarketHours.sol";
import {MockStockToken} from "./mocks/MockStockToken.sol";
import {MockUSDG} from "./mocks/MockUSDG.sol";
import {MockVault} from "./mocks/MockVault.sol";

abstract contract LemniscateEngineFixture is Test {
    uint256 internal constant WAD = 1e18;
    uint256 internal constant USDG = 1e6;
    uint256 internal constant BASE_CARRY = 4e15;
    uint256 internal constant SKEW_CARRY = 2e15;

    address internal constant ALICE = address(0xA11CE);
    address internal constant GUARDIAN = address(0xB0B);
    address internal constant KEEPER = address(0xCAFE);
    address internal constant TREASURY = address(0x5151);

    MockUSDG internal usdg;
    MockVault internal vault;
    MockMarketHours internal marketHours;
    MockFeed internal feed;
    MockStockToken internal stock;
    LemniscateEngine internal engine;
    OptionToken internal token;

    function setUp() public virtual {
        vm.warp(1_800_000_000);
        usdg = new MockUSDG();
        vault = new MockVault(IERC20(address(usdg)));
        vault.setNavWad(int256(100 * WAD));
        usdg.mint(address(vault), 100 * USDG);
        marketHours = new MockMarketHours();
        feed = new MockFeed(8, 10_000_000_000); // $100.00
        stock = new MockStockToken();

        LemniscateEngine implementation = new LemniscateEngine();
        bytes memory initData = abi.encodeCall(
            LemniscateEngine.initialize,
            (
                address(this),
                IERC20(address(usdg)),
                IWriterPool(address(vault)),
                IMarketHours(address(marketHours)),
                TREASURY
            )
        );
        engine = LemniscateEngine(address(new ERC1967Proxy(address(implementation), initData)));
        vault.setEngine(address(engine));
        engine.grantRole(engine.GUARDIAN_ROLE(), GUARDIAN);
        engine.grantRole(engine.KEEPER_ROLE(), KEEPER);

        MarketConfig memory config;
        config.stock = stock;
        config.feed = feed;
        config.scale = 1_000;
        config.feeBps = 10;
        config.openSpreadBps = 40;
        config.offHoursSpreadBps = 150;
        config.pausedSpreadBps = 300;
        config.openBandBps = 100;
        config.offHoursBandBps = 300;
        config.impactBps = 50;
        config.maxMarketExposureBps = 2_500;
        config.maxTradeUsdg = uint128(25 * USDG);
        config.minTradeUsdg = uint128(USDG);
        config.pausedSellCapPerBlockUsdg = uint128(50 * USDG);
        config.offHoursCarryWad = int64(int256(BASE_CARRY));
        config.skewCarryWad = int64(int256(SKEW_CARRY));
        config.minCarryWad = 0;
        config.maxCarryWad = 5e15;
        config.baseCarryMinWad = 3e15;
        config.baseCarryMaxWad = 5e15;
        config.maxAgeOpen = 26 hours;
        config.maxAgeOffHours = 4 days;
        engine.listMarket(config, unicode"NVDA² Power Token", "NVDA2", int64(int256(BASE_CARRY)));
        MarketConfig memory listed = engine.getConfig(0);
        token = listed.token;

        usdg.mint(ALICE, 1_000 * USDG);
        vm.prank(ALICE);
        usdg.approve(address(engine), type(uint256).max);
    }

    function _buy(uint256 amount) internal returns (uint256) {
        vm.prank(ALICE);
        return engine.buy(0, amount, 0, ALICE, block.timestamp + 1 days);
    }

    function _config() internal view returns (MarketConfig memory) {
        return engine.getConfig(0);
    }

    function _setConfig(MarketConfig memory config) internal {
        engine.setMarketConfig(0, config);
    }
}

contract LemniscateEngineTest is LemniscateEngineFixture {
    function testFirstBuyAfterLongIdleAccruesAndSubsequentPositionStillDecays() public {
        // No holder pays for the idle interval. The first buy must match the
        // live quote even after the engine's seven-day projection cap.
        vm.warp(block.timestamp + 10 days);
        feed.setAnswer(10_000_000_000);
        uint256 projected = engine.currentNormFactor(0);
        assertEq(projected, WAD - BASE_CARRY * 7);
        assertEq(token.totalSupply(), 0);
        (uint256 quoted,,,) = engine.quoteBuy(0, 2 * USDG);
        uint256 bought = _buy(2 * USDG);
        assertEq(bought, quoted);
        MarketState memory state = engine.getState(0);
        assertEq(state.normFactor, projected);
        assertEq(state.lastAccrual, block.timestamp);
        assertEq(state.vaultShort, token.totalSupply());

        // Once supply exists, normal keeper accrual and a full exit still work.
        vm.warp(block.timestamp + 6 hours);
        engine.accrueAll();
        assertLt(engine.getState(0).normFactor, projected);
        (uint256 sellQuote,,) = engine.quoteSell(0, bought);
        vm.prank(ALICE);
        assertEq(engine.sell(0, bought, sellQuote, ALICE, block.timestamp + 1 hours), sellQuote);
        assertEq(token.totalSupply(), 0);
        assertEq(engine.getState(0).vaultShort, 0);

        // A second prolonged idle period also permits trading without a poke.
        vm.warp(block.timestamp + 21 days);
        feed.setAnswer(10_000_000_000);
        (quoted,,,) = engine.quoteBuy(0, 2 * USDG);
        assertEq(_buy(2 * USDG), quoted);
        assertEq(engine.getState(0).lastAccrual, block.timestamp);
    }

    function testIndexMathAndContinuousFeedIndex() public {
        assertEq(engine.index(0), 10 * WAD);
        feed.setAnswer(20_000_000_000); // $200.00: 200^2 / 1000 = 40
        assertEq(engine.index(0), 40 * WAD);
        uint256 before = engine.index(0);
        vm.warp(block.timestamp + 1 hours);
        assertEq(engine.index(0), before);
    }

    function testCarryUsesRegimeUtilizationClampAndSingleLinearDay() public {
        assertEq(engine.currentCarryWad(0), int256(BASE_CARRY));
        _buy(20 * USDG);
        MarketState memory state = engine.getState(0);
        assertGt(state.lastUtilBps, 0);
        assertEq(engine.currentCarryWad(0), int256(5e15)); // base + skew is clamped at max

        int256 openCarry = engine.currentCarryWad(0);
        vault.setNavWad(int256(1_000 * WAD));
        assertEq(engine.currentCarryWad(0), openCarry); // no live NAV recursion into the stored utilization

        vm.warp(block.timestamp + 1 days);
        uint256 projected = engine.currentNormFactor(0);
        assertApproxEqAbs(projected, WAD - uint256(openCarry), 1e4);
        vm.roll(block.number + 1);
        engine.accrue(0);
        assertEq(engine.getState(0).normFactor, projected);
        assertLt(uint256(engine.getState(0).lastUtilBps), uint256(state.lastUtilBps));

        marketHours.setOpen(false);
        assertEq(engine.currentCarryWad(0), int256(BASE_CARRY));
    }

    function testCarryAccrualViewMatchesStoredAccrualForOneDay() public {
        vm.warp(block.timestamp + 1 days);
        uint256 projected = engine.currentNormFactor(0);
        assertApproxEqAbs(projected, WAD - BASE_CARRY, 1e4);
        vm.roll(block.number + 1);
        engine.accrue(0);
        assertEq(engine.getState(0).normFactor, projected);
    }

    function testBaseCarryIsOneBoundedStepPerTwentyFourHours() public {
        vm.expectRevert(ILemniscateEngine.CarryChangeTooFast.selector);
        vm.prank(KEEPER);
        engine.setBaseCarry(0, int64(41e14));

        vm.warp(block.timestamp + 1 days);
        vm.prank(KEEPER);
        engine.setBaseCarry(0, int64(41e14));
        assertEq(engine.getState(0).baseCarryWad, int64(41e14));

        vm.expectRevert(ILemniscateEngine.CarryChangeTooFast.selector);
        vm.prank(KEEPER);
        engine.setBaseCarry(0, int64(42e14));
    }

    function testRegimeOpenOffHoursStalePausedAndCalendarFailure() public {
        assertEq(uint8(engine.currentRegime(0)), uint8(Regime.OPEN));
        marketHours.setOpen(false);
        assertEq(uint8(engine.currentRegime(0)), uint8(Regime.OFF_HOURS));
        feed.setUpdatedAt(block.timestamp - 4 days);
        assertEq(uint8(engine.currentRegime(0)), uint8(Regime.OFF_HOURS)); // the age boundary is inclusive
        feed.setUpdatedAt(block.timestamp - 4 days - 1);
        assertEq(uint8(engine.currentRegime(0)), uint8(Regime.PAUSED));
        feed.setAnswer(10_000_000_000);
        marketHours.setShouldRevert(true);
        assertEq(uint8(engine.currentRegime(0)), uint8(Regime.OFF_HOURS));
        marketHours.setShouldRevert(false);
        marketHours.setOpen(true);

        feed.setUpdatedAt(block.timestamp - 26 hours - 1);
        assertEq(uint8(engine.currentRegime(0)), uint8(Regime.PAUSED));
        feed.setAnswer(0);
        assertEq(uint8(engine.currentRegime(0)), uint8(Regime.PAUSED));
        (,, bool zeroAnswerValid) = engine.spotPrice(0);
        assertFalse(zeroAnswerValid);
        feed.setAnswer(10_000_000_000);
        feed.setUpdatedAt(block.timestamp + 1);
        assertEq(uint8(engine.currentRegime(0)), uint8(Regime.PAUSED));
        (,, bool futureRoundValid) = engine.spotPrice(0);
        assertFalse(futureRoundValid);
        feed.setAnswer(10_000_000_000);
        stock.setOraclePaused(true);
        assertEq(uint8(engine.currentRegime(0)), uint8(Regime.PAUSED));
        (,, bool rawFeedValid) = engine.spotPrice(0);
        assertTrue(rawFeedValid); // validity means a well-formed feed round; check regime for staleness/pauses
    }

    function testSequencerDownAndGracePeriodPauseMarket() public {
        MockFeed sequencer = new MockFeed(8, 1);
        engine.setGlobal(5_000, 0, TREASURY, address(sequencer));
        assertEq(uint8(engine.currentRegime(0)), uint8(Regime.PAUSED));
        sequencer.setAnswer(0);
        assertEq(uint8(engine.currentRegime(0)), uint8(Regime.PAUSED)); // up, but still in the one-hour grace period
        sequencer.setUpdatedAt(block.timestamp - 1 hours - 1);
        assertEq(uint8(engine.currentRegime(0)), uint8(Regime.OPEN));
    }

    function testQuotesUseCorrectSidesAndSellImpactGrowsWithNotional() public view {
        uint256 fair = engine.tokenPrice(0);
        (,, uint256 buyPrice,) = engine.quoteBuy(0, USDG);
        (,, uint256 maxBuyPrice,) = engine.quoteBuy(0, 25 * USDG);
        (uint256 smallOut, uint256 smallFee, uint256 smallSellPrice) = engine.quoteSell(0, 1e15);
        (uint256 largeOut, uint256 largeFee, uint256 largeSellPrice) = engine.quoteSell(0, 10 * WAD);
        assertGt(buyPrice, fair);
        assertLe(maxBuyPrice, fair * 10_100 / 10_000);
        assertLt(smallSellPrice, fair);
        assertLt(largeSellPrice, smallSellPrice);
        assertGe(smallSellPrice, fair * 9_900 / 10_000);
        assertEq(largeSellPrice, fair * 9_900 / 10_000);
        assertGt(smallOut, 0);
        assertGt(largeOut, smallOut);
        assertGt(smallFee, 0);
        assertGt(largeFee, smallFee);
    }

    function testBuySellAndSupplyTracksVaultShort() public {
        uint256 received = _buy(5 * USDG);
        assertEq(token.balanceOf(ALICE), received);
        assertEq(token.totalSupply(), engine.getState(0).vaultShort);

        uint256 startingUsdg = usdg.balanceOf(ALICE);
        vm.prank(ALICE);
        uint256 sold = engine.sell(0, received / 2, 0, ALICE, block.timestamp + 1 days);
        assertGt(sold, 0);
        assertGt(usdg.balanceOf(ALICE), startingUsdg);
        assertEq(token.totalSupply(), engine.getState(0).vaultShort);
    }

    function testBuyWithPermitUsesPermitAllowance() public {
        uint256 privateKey = 0xA11CE;
        address owner = vm.addr(privateKey);
        uint256 amount = 5 * USDG;
        uint256 permitDeadline = block.timestamp + 1 days;
        usdg.mint(owner, amount);
        uint256 nonce = usdg.nonces(owner);
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)"),
                owner,
                address(engine),
                amount,
                nonce,
                permitDeadline
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", usdg.DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(privateKey, digest);
        vm.prank(owner);
        uint256 received = engine.buyWithPermit(0, amount, 0, owner, block.timestamp + 1 days, permitDeadline, v, r, s);
        assertEq(token.balanceOf(owner), received);
    }

    function testBuyBoundsDeadlineAndSlippage() public {
        vm.expectRevert(ILemniscateEngine.TradeTooSmall.selector);
        _buy(USDG - 1);
        vm.expectRevert(ILemniscateEngine.TradeTooLarge.selector);
        _buy(26 * USDG);
        vm.expectRevert(ILemniscateEngine.Expired.selector);
        vm.prank(ALICE);
        engine.buy(0, USDG, 0, ALICE, block.timestamp - 1);
        vm.expectRevert(ILemniscateEngine.Slippage.selector);
        vm.prank(ALICE);
        engine.buy(0, USDG, WAD, ALICE, block.timestamp + 1 days);
    }

    function testMarketAndGlobalExposureCaps() public {
        MarketConfig memory config = _config();
        config.maxMarketExposureBps = 1_000;
        _setConfig(config);
        vm.expectRevert(ILemniscateEngine.MarketCapExceeded.selector);
        _buy(20 * USDG);

        config.maxMarketExposureBps = 2_500;
        _setConfig(config);
        engine.setGlobal(1_000, 0, TREASURY, address(0));
        vm.expectRevert(ILemniscateEngine.GlobalCapExceeded.selector);
        _buy(15 * USDG);
    }

    function testGuardianBuyPauseDoesNotChangeRegimeOrRestrictHolderSell() public {
        uint256 received = _buy(5 * USDG);
        MarketConfig memory config = _config();
        config.pausedSellCapPerBlockUsdg = uint128(500_000);
        _setConfig(config);

        vm.prank(GUARDIAN);
        engine.setBuysPaused(0, true);
        assertEq(uint8(engine.currentRegime(0)), uint8(Regime.OPEN));
        vm.expectRevert(ILemniscateEngine.BuysPausedErr.selector);
        _buy(USDG);

        (,, uint256 sellPrice) = engine.quoteSell(0, received / 2);
        assertGt(sellPrice, engine.tokenPrice(0) * 98 / 100);
        vm.prank(ALICE);
        engine.sell(0, received / 2, 0, ALICE, block.timestamp + 1 days);
    }

    function testGlobalBuyPauseStillAllowsHolderSell() public {
        uint256 received = _buy(5 * USDG);
        vm.prank(GUARDIAN);
        engine.setGlobalBuysPaused(true);
        assertTrue(engine.globalBuysPaused());
        vm.expectRevert(ILemniscateEngine.BuysPausedErr.selector);
        _buy(USDG);
        vm.prank(ALICE);
        engine.sell(0, received / 2, 0, ALICE, block.timestamp + 1 days);
        assertEq(token.totalSupply(), engine.getState(0).vaultShort);
    }

    function testOraclePausedSellUsesLastGoodPriceAndPerBlockCap() public {
        uint256 received = _buy(25 * USDG);
        feed.setAnswer(12_000_000_000); // $120, not yet accepted as last-good
        stock.setOraclePaused(true);
        assertEq(uint8(engine.currentRegime(0)), uint8(Regime.PAUSED));
        assertEq(engine.index(0), 10 * WAD);
        (,, uint256 pausedSellPrice) = engine.quoteSell(0, received / 3);
        assertEq(pausedSellPrice, engine.tokenPrice(0) * 9_700 / 10_000);

        MarketConfig memory config = _config();
        config.pausedSellCapPerBlockUsdg = uint128(10 * USDG);
        _setConfig(config);
        vm.prank(ALICE);
        engine.sell(0, 7e17, 0, ALICE, block.timestamp + 1 days);
        vm.expectRevert(ILemniscateEngine.PausedSellCapExceeded.selector);
        vm.prank(ALICE);
        engine.sell(0, 7e17, 0, ALICE, block.timestamp + 1 days);
    }

    function testPausedSellCapIsTimeWindowedNotBlockWindowed() public {
        _buy(25 * USDG);
        stock.setOraclePaused(true);
        MarketConfig memory config = _config();
        config.pausedSellCapPerBlockUsdg = uint128(10 * USDG);
        _setConfig(config);

        vm.prank(ALICE);
        engine.sell(0, 7e17, 0, ALICE, block.timestamp + 1 days);
        vm.roll(block.number + 100);
        vm.warp(block.timestamp + 10 minutes);
        vm.expectRevert(ILemniscateEngine.PausedSellCapExceeded.selector);
        vm.prank(ALICE);
        engine.sell(0, 7e17, 0, ALICE, block.timestamp + 1 days);

        vm.warp(block.timestamp + 1 hours);
        vm.prank(ALICE);
        engine.sell(0, 7e17, 0, ALICE, block.timestamp + 1 days);
    }

    function testStockTransferPauseBlocksBuysButNotSells() public {
        uint256 received = _buy(5 * USDG);
        stock.setPaused(true);
        vm.expectRevert(ILemniscateEngine.RegimePaused.selector);
        engine.quoteBuy(0, USDG);
        vm.expectRevert(ILemniscateEngine.RegimePaused.selector);
        _buy(USDG);

        vm.warp(block.timestamp + 1);
        vm.prank(ALICE);
        engine.sell(0, received, 0, ALICE, block.timestamp + 1 days);
        assertEq(token.balanceOf(ALICE), 0);
    }

    function testListingRejectsDuplicateStockAndOversizedPausedSpread() public {
        MarketConfig memory config = _config();
        config.token = OptionToken(address(0));
        vm.expectRevert(ILemniscateEngine.InvalidMarketConfig.selector);
        engine.listMarket(config, "Dup", "DUP", int64(int256(BASE_CARRY)));

        config = _config();
        config.pausedSpreadBps = 301;
        vm.expectRevert(ILemniscateEngine.InvalidMarketConfig.selector);
        engine.setMarketConfig(0, config);
    }

    function testBaseCarryCanLeaveZero() public {
        MarketConfig memory config = _config();
        config.token = OptionToken(address(0));
        config.stock = new MockStockToken();
        config.baseCarryMinWad = 0;
        uint8 id = engine.listMarket(config, "Zero", "ZERO", 0);

        vm.warp(block.timestamp + 1 days);
        vm.prank(KEEPER);
        engine.setBaseCarry(id, int64(1e15)); // <= 25% of baseCarryMaxWad (5e15)
        assertEq(engine.getState(id).baseCarryWad, int64(1e15));
    }

    function testOnlySellingHolderCanBurnThroughEngine() public {
        uint256 received = _buy(5 * USDG);
        uint256 holderBalance = token.balanceOf(ALICE);
        vm.expectRevert(OptionToken.NotEngine.selector);
        token.burn(ALICE, received);

        engine.accrue(0);
        engine.accrueAll();
        engine.setGlobal(5_000, 0, TREASURY, address(0));
        engine.setMarketConfig(0, _config());
        vm.warp(block.timestamp + 1 days);
        vm.prank(KEEPER);
        engine.setBaseCarry(0, int64(41e14));
        vm.prank(GUARDIAN);
        engine.setBuysPaused(0, true);
        vm.prank(GUARDIAN);
        engine.setGlobalBuysPaused(true);
        assertEq(token.balanceOf(ALICE), holderBalance);

        uint256 soldAmount = received / 3;
        vm.prank(ALICE);
        engine.sell(0, soldAmount, 0, address(0xD00D), block.timestamp + 1 days);
        assertEq(token.balanceOf(ALICE), holderBalance - soldAmount);
        assertEq(token.totalSupply(), engine.getState(0).vaultShort);
    }
}

contract LemniscateEngineHandler {
    LemniscateEngine private immutable engine;
    MockUSDG private immutable usdg;
    OptionToken private immutable token;

    constructor(LemniscateEngine engine_, MockUSDG usdg_, OptionToken token_) {
        engine = engine_;
        usdg = usdg_;
        token = token_;
        usdg.approve(address(engine_), type(uint256).max);
    }

    function buy(uint256 rawAmount) external {
        uint256 amount = 1e6 + (rawAmount % (24e6 + 1));
        usdg.mint(address(this), amount);
        try engine.buy(0, amount, 0, address(this), block.timestamp + 1 days) returns (uint256) {} catch {}
    }

    function sell(uint256 rawAmount) external {
        uint256 balance = token.balanceOf(address(this));
        if (balance == 0) return;
        uint256 amount = rawAmount % balance + 1;
        try engine.sell(0, amount, 0, address(this), block.timestamp + 1 days) returns (uint256) {} catch {}
    }
}

contract LemniscateEngineInvariantTest is LemniscateEngineFixture {
    LemniscateEngineHandler internal handler;

    function setUp() public override {
        super.setUp();
        handler = new LemniscateEngineHandler(engine, usdg, token);
        targetContract(address(handler));
    }

    function invariantOptionTokenSupplyMatchesVaultShort() public view {
        assertEq(token.totalSupply(), engine.getState(0).vaultShort);
    }
}
