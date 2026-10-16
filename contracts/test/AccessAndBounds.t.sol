// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {WriterPool} from "../src/WriterPool.sol";
import {MarketHours} from "../src/MarketHours.sol";
import {LemniscateEngine} from "../src/LemniscateEngine.sol";
import {IWriterPool} from "../src/interfaces/IWriterPool.sol";
import {IAggregatorV3} from "../src/interfaces/IAggregatorV3.sol";
import {IHedgeAdapter} from "../src/interfaces/IHedgeAdapter.sol";
import {IMarketHours} from "../src/interfaces/IMarketHours.sol";
import {ILemniscateEngine} from "../src/interfaces/ILemniscateEngine.sol";
import {IPriceReference} from "../src/interfaces/IPriceReference.sol";
import {IStockToken} from "../src/interfaces/IStockToken.sol";
import {MarketConfig, MarketState, Session} from "../src/libs/LemniscateTypes.sol";
import {MockFeed} from "./mocks/MockFeed.sol";
import {MockStockToken} from "./mocks/MockStockToken.sol";
import {SystemFixture} from "./utils/SystemFixture.sol";

/// @notice Every privileged entry point rejects unauthorized callers, every bound accepts its limit and rejects the
/// next value, initializers cannot be re-run, implementations are locked, and upgrades are admin-only.
contract AccessAndBoundsTest is SystemFixture {
    address internal stranger = makeAddr("stranger");
    MarketHours internal mh;
    address internal mhAdmin = makeAddr("mhAdmin");
    address internal mhKeeper = makeAddr("mhKeeper");

    function setUp() public {
        _deploySystem();
        mh = MarketHours(
            address(new ERC1967Proxy(address(new MarketHours()), abi.encodeCall(MarketHours.initialize, (mhAdmin, mhKeeper))))
        );
    }

    function _unauthorized(address who, bytes32 role) internal {
        vm.expectRevert(abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, who, role));
    }

    function _impl(address proxy) internal view returns (address) {
        return address(uint160(uint256(vm.load(proxy, 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc)))); // not-a-key
    }

    // =================================================================== initializers and upgrades

    function testInitializersCannotBeRerunOnProxies() public {
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        engine.initialize(address(this), IERC20(address(usdg)), IWriterPool(address(vault)), IMarketHours(address(hours_)), TREASURY);
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        vault.initialize(address(this), IERC20(address(usdg)), ILemniscateEngine(address(engine)));
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        mh.initialize(mhAdmin, mhKeeper);
    }

    function testImplementationsAreLocked() public {
        LemniscateEngine engineImpl = LemniscateEngine(_impl(address(engine)));
        WriterPool vaultImpl = WriterPool(_impl(address(vault)));
        MarketHours mhImpl = MarketHours(_impl(address(mh)));
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        engineImpl.initialize(stranger, IERC20(address(usdg)), IWriterPool(address(vault)), IMarketHours(address(hours_)), stranger);
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        vaultImpl.initialize(stranger, IERC20(address(usdg)), ILemniscateEngine(address(engine)));
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        mhImpl.initialize(stranger, stranger);
        assertFalse(engineImpl.hasRole(bytes32(0), stranger));
    }

    function testInitializersRejectZeroAddresses() public {
        address impl = address(new LemniscateEngine());
        IERC20 u = IERC20(address(usdg));
        IWriterPool v = IWriterPool(address(vault));
        IMarketHours h = IMarketHours(address(hours_));
        bytes[5] memory calls = [
            abi.encodeCall(LemniscateEngine.initialize, (address(0), u, v, h, TREASURY)),
            abi.encodeCall(LemniscateEngine.initialize, (address(this), IERC20(address(0)), v, h, TREASURY)),
            abi.encodeCall(LemniscateEngine.initialize, (address(this), u, IWriterPool(address(0)), h, TREASURY)),
            abi.encodeCall(LemniscateEngine.initialize, (address(this), u, v, IMarketHours(address(0)), TREASURY)),
            abi.encodeCall(LemniscateEngine.initialize, (address(this), u, v, h, address(0)))
        ];
        for (uint256 i; i < calls.length; ++i) {
            vm.expectRevert(ILemniscateEngine.ZeroAddress.selector);
            new ERC1967Proxy(impl, calls[i]);
        }

        impl = address(new WriterPool());
        ILemniscateEngine e = ILemniscateEngine(address(engine));
        vm.expectRevert(IWriterPool.InvalidAdmin.selector);
        new ERC1967Proxy(impl, abi.encodeCall(WriterPool.initialize, (address(0), u, e)));
        vm.expectRevert(IWriterPool.InvalidEngine.selector);
        new ERC1967Proxy(impl, abi.encodeCall(WriterPool.initialize, (address(this), u, ILemniscateEngine(address(0)))));
        vm.expectRevert(IWriterPool.InvalidParams.selector);
        new ERC1967Proxy(impl, abi.encodeCall(WriterPool.initialize, (address(this), IERC20(address(0)), e)));

        impl = address(new MarketHours());
        vm.expectRevert(IMarketHours.InvalidAdmin.selector);
        new ERC1967Proxy(impl, abi.encodeCall(MarketHours.initialize, (address(0), mhKeeper)));
        vm.expectRevert(IMarketHours.InvalidKeeper.selector);
        new ERC1967Proxy(impl, abi.encodeCall(MarketHours.initialize, (mhAdmin, address(0))));
    }

    function testUpgradesAreAdminOnlyAndPreserveState() public {
        address engineImpl = address(new LemniscateEngine());
        address vaultImpl = address(new WriterPool());
        _unauthorized(stranger, bytes32(0));
        vm.prank(stranger);
        engine.upgradeToAndCall(engineImpl, "");
        _unauthorized(stranger, bytes32(0));
        vm.prank(stranger);
        vault.upgradeToAndCall(vaultImpl, "");
        // A keeper or guardian is not an admin either.
        _unauthorized(GUARDIAN, bytes32(0));
        vm.prank(GUARDIAN);
        engine.upgradeToAndCall(engineImpl, "");
        _unauthorized(KEEPER, bytes32(0));
        vm.prank(KEEPER);
        vault.upgradeToAndCall(vaultImpl, "");

        MarketConfig memory before = engine.getConfig(1);
        engine.upgradeToAndCall(engineImpl, "");
        vault.upgradeToAndCall(vaultImpl, "");
        assertEq(_impl(address(engine)), engineImpl);
        assertEq(_impl(address(vault)), vaultImpl);
        assertEq(address(engine.getConfig(1).token), address(before.token));
        assertEq(engine.maxGlobalExposureBps(), 5_000);
        assertEq(address(vault.engine()), address(engine));
    }

    // =================================================================== LemniscateEngine

    function testEngineAdminSettersRejectStrangers() public {
        MarketConfig memory c = engine.getConfig(0);
        _unauthorized(stranger, bytes32(0));
        vm.prank(stranger);
        engine.setMarketConfig(0, c);
        _unauthorized(stranger, bytes32(0));
        vm.prank(stranger);
        engine.setGlobal(5_000, 0, TREASURY, address(0));
        MarketConfig memory fresh = _marketConfig(0);
        fresh.stock = new MockStockToken();
        _unauthorized(stranger, bytes32(0));
        vm.prank(stranger);
        engine.listMarket(fresh, "X", "X", 4e15);
    }

    function testEngineKeeperAndGuardianSettersRejectOthers() public {
        bytes32 keeperRole = engine.KEEPER_ROLE();
        bytes32 guardianRole = engine.GUARDIAN_ROLE();
        _unauthorized(stranger, keeperRole);
        vm.prank(stranger);
        engine.setBaseCarry(0, 4e15);
        // The admin is not implicitly a keeper or guardian.
        _unauthorized(address(this), keeperRole);
        engine.setBaseCarry(0, 4e15);
        _unauthorized(address(this), guardianRole);
        engine.setBuysPaused(0, true);
        _unauthorized(KEEPER, guardianRole);
        vm.prank(KEEPER);
        engine.setGlobalBuysPaused(true);
        _unauthorized(stranger, guardianRole);
        vm.prank(stranger);
        engine.setBuysPaused(0, true);
    }

    function testGuardianPausesAreIdempotentAndCheckMarket() public {
        vm.startPrank(GUARDIAN);
        vm.expectRevert(ILemniscateEngine.MarketNotFound.selector);
        engine.setBuysPaused(2, true);
        engine.setBuysPaused(0, true);
        engine.setBuysPaused(0, true);
        assertTrue(engine.getState(0).buysPaused);
        engine.setGlobalBuysPaused(true);
        engine.setGlobalBuysPaused(true);
        assertTrue(engine.globalBuysPaused());
        engine.setGlobalBuysPaused(false);
        engine.setBuysPaused(0, false);
        vm.stopPrank();
        assertFalse(engine.globalBuysPaused());
    }

    function testSetGlobalBoundsAtAndBeyondLimits() public {
        vm.expectRevert(ILemniscateEngine.InvalidMarketConfig.selector);
        engine.setGlobal(999, 0, TREASURY, address(0));
        engine.setGlobal(1_000, 0, TREASURY, address(0));
        vm.expectRevert(ILemniscateEngine.InvalidMarketConfig.selector);
        engine.setGlobal(10_001, 0, TREASURY, address(0));
        engine.setGlobal(10_000, 0, TREASURY, address(0));
        vm.expectRevert(ILemniscateEngine.InvalidMarketConfig.selector);
        engine.setGlobal(5_000, 5_001, TREASURY, address(0));
        engine.setGlobal(5_000, 5_000, TREASURY, address(0));
        vm.expectRevert(ILemniscateEngine.InvalidMarketConfig.selector);
        engine.setGlobal(5_000, 0, address(0), address(0));
        engine.setGlobal(5_000, 0, stranger, address(hours_));
        assertEq(engine.treasury(), stranger);
        assertEq(address(engine.sequencerFeed()), address(hours_));
    }

    /// Each MarketConfig bound: the limit value is accepted, the next value is rejected.
    function testMarketConfigBoundsAtAndBeyondLimits() public {
        for (uint256 field; field < 20; ++field) {
            (MarketConfig memory ok, MarketConfig memory bad) = _boundPair(field);
            engine.setMarketConfig(0, ok);
            vm.expectRevert(ILemniscateEngine.InvalidMarketConfig.selector);
            engine.setMarketConfig(0, bad);
        }
    }

    function _boundPair(uint256 field) internal view returns (MarketConfig memory ok, MarketConfig memory bad) {
        ok = _marketConfig(0);
        ok.token = engine.getConfig(0).token;
        bad = _marketConfig(0);
        bad.token = ok.token;
        if (field == 0) (ok.feeBps, bad.feeBps) = (100, 101);
        else if (field == 1) (ok.impactBps, bad.impactBps) = (1_000, 1_001);
        else if (field == 2) (ok.openBandBps, bad.openBandBps) = (1_000, 1_001);
        else if (field == 3) (ok.openSpreadBps, bad.openSpreadBps) = (ok.openBandBps, ok.openBandBps + 1);
        else if (field == 4) (ok.offHoursBandBps, bad.offHoursBandBps) = (1_000, 1_001);
        else if (field == 5) (ok.offHoursSpreadBps, bad.offHoursSpreadBps) = (ok.offHoursBandBps, ok.offHoursBandBps + 1);
        else if (field == 6) (ok.pausedSpreadBps, bad.pausedSpreadBps) = (300, 301);
        else if (field == 7) (ok.maxMarketExposureBps, bad.maxMarketExposureBps) = (10_000, 10_001);
        else if (field == 8) (ok.maxMarketExposureBps, bad.maxMarketExposureBps) = (1, 0);
        else if (field == 9) (ok.minTradeUsdg, bad.minTradeUsdg) = (1, 0);
        else if (field == 10) (ok.maxTradeUsdg, bad.maxTradeUsdg) = (ok.minTradeUsdg, ok.minTradeUsdg - 1);
        else if (field == 11) (ok.pausedSellCapPerBlockUsdg, bad.pausedSellCapPerBlockUsdg) = (1, 0);
        else if (field == 12) (ok.maxAgeOpen, bad.maxAgeOpen) = (1, 0);
        else if (field == 13) (ok.maxAgeOffHours, bad.maxAgeOffHours) = (1, 0);
        else if (field == 14) (ok.minCarryWad, bad.minCarryWad) = (0, -1);
        else if (field == 15) (ok.offHoursCarryWad, bad.offHoursCarryWad) = (0, -1);
        else if (field == 16) (ok.skewCarryWad, bad.skewCarryWad) = (0, -1);
        else if (field == 17) (ok.maxCarryWad, bad.maxCarryWad) = (ok.minCarryWad, ok.minCarryWad - 1);
        else if (field == 18) (ok.baseCarryMinWad, bad.baseCarryMinWad) = (0, -1);
        else if (field == 19) {
            (ok.baseCarryMinWad, ok.baseCarryMaxWad) = (4e15, 4e15); // must still contain the current 4e15
            (bad.baseCarryMinWad, bad.baseCarryMaxWad) = (4e15, 4e15 - 1);
        }
        if (field == 3) bad.openBandBps = ok.openBandBps;
        if (field == 5) bad.offHoursBandBps = ok.offHoursBandBps;
        if (field == 10) bad.minTradeUsdg = ok.minTradeUsdg;
        if (field == 17) bad.minCarryWad = ok.minCarryWad;
    }

    function testMarketConfigRejectsIdentityChangesAndUnsupportedKinds() public {
        MarketConfig memory c = engine.getConfig(0);
        MarketConfig memory m;
        for (uint256 i; i < 7; ++i) {
            m = engine.getConfig(0);
            if (i == 0) m.stock = stocks[1];
            if (i == 1) m.feed = feeds[1];
            if (i == 2) m.token = engine.getConfig(1).token;
            if (i == 3) m.scale = c.scale + 1;
            if (i == 4) m.kind = 1;
            if (i == 5) m.feed2 = address(1);
            if (i == 6) m.offHoursSpreadBps = m.offHoursBandBps + 1;
            vm.expectRevert(ILemniscateEngine.InvalidMarketConfig.selector);
            engine.setMarketConfig(0, m);
        }
        vm.expectRevert(ILemniscateEngine.MarketNotFound.selector);
        engine.setMarketConfig(2, c);
        // The stored base carry must stay inside new carry bounds.
        m = engine.getConfig(0);
        m.baseCarryMinWad = 4e15 + 1;
        m.baseCarryMaxWad = 5e15;
        vm.expectRevert(ILemniscateEngine.CarryOutOfBounds.selector);
        engine.setMarketConfig(0, m);
    }

    function testListMarketValidation() public {
        MockStockToken s = new MockStockToken();
        MockFeed f = new MockFeed(8, 50e8);
        MarketConfig memory c = _marketConfig(0);
        c.stock = s;
        c.feed = f;

        MarketConfig memory m = _copy(c);
        m.token = engine.getConfig(0).token;
        vm.expectRevert(ILemniscateEngine.InvalidMarketConfig.selector);
        engine.listMarket(m, "X", "X", 4e15);

        m = _copy(c);
        m.stock = stocks[0]; // one market per stock token
        vm.expectRevert(ILemniscateEngine.InvalidMarketConfig.selector);
        engine.listMarket(m, "X", "X", 4e15);

        vm.expectRevert(ILemniscateEngine.CarryOutOfBounds.selector);
        engine.listMarket(c, "X", "X", 3e15 - 1);
        vm.expectRevert(ILemniscateEngine.CarryOutOfBounds.selector);
        engine.listMarket(c, "X", "X", 5e15 + 1);

        m = _copy(c);
        m.feed = new MockFeed(18, 50e8); // feed must have 8 decimals
        vm.expectRevert(ILemniscateEngine.InvalidMarketConfig.selector);
        engine.listMarket(m, "X", "X", 4e15);
        m.feed = IAggregatorV3(address(hours_)); // no decimals() at all
        vm.expectRevert(ILemniscateEngine.InvalidMarketConfig.selector);
        engine.listMarket(m, "X", "X", 4e15);
        m = _copy(c);
        m.stock = IStockToken(address(usdg)); // stock must have 18 decimals
        vm.expectRevert(ILemniscateEngine.InvalidMarketConfig.selector);
        engine.listMarket(m, "X", "X", 4e15);
        m.stock = IStockToken(address(hours_));
        vm.expectRevert(ILemniscateEngine.InvalidMarketConfig.selector);
        engine.listMarket(m, "X", "X", 4e15);
        m = _copy(c);
        m.stock = IStockToken(address(0));
        vm.expectRevert(ILemniscateEngine.InvalidMarketConfig.selector);
        engine.listMarket(m, "X", "X", 4e15);
        m = _copy(c);
        m.scale = 0;
        vm.expectRevert(ILemniscateEngine.InvalidMarketConfig.selector);
        engine.listMarket(m, "X", "X", 4e15);

        f.setAnswer(0); // listing needs a valid round
        vm.expectRevert(ILemniscateEngine.OracleInvalid.selector);
        engine.listMarket(c, "X", "X", 4e15);
        f.setAnswer(50e8);

        uint8 id = engine.listMarket(c, "X", "X", 3e15);
        assertEq(id, 2);
        assertEq(engine.marketIdOf(address(engine.getConfig(id).token)), id);
        vm.expectRevert(ILemniscateEngine.MarketNotFound.selector);
        engine.marketIdOf(address(usdg));
    }

    function _copy(MarketConfig memory c) internal pure returns (MarketConfig memory m) {
        m = abi.decode(abi.encode(c), (MarketConfig));
    }

    /// Market ids are uint8: listing stops at 255 markets. (Listing 253 real markets exceeds the test gas limit, so
    /// the `_configs` length — slot 5 in the storage layout — is set directly.)
    function testMarketCountIsCappedAt255() public {
        vm.store(address(engine), bytes32(uint256(5)), bytes32(uint256(255)));
        assertEq(engine.marketCount(), 255);
        MarketConfig memory c = _marketConfig(0);
        c.stock = new MockStockToken();
        vm.expectRevert(ILemniscateEngine.InvalidMarketConfig.selector);
        engine.listMarket(c, "X", "X", 4e15);
    }

    function testSetBaseCarryBoundsCadenceAndStep() public {
        MarketConfig memory c = engine.getConfig(0);
        c.baseCarryMinWad = 0;
        c.baseCarryMaxWad = 1e16;
        engine.setMarketConfig(0, c);
        uint256 t0 = vm.getBlockTimestamp();

        vm.startPrank(KEEPER);
        vm.expectRevert(ILemniscateEngine.CarryOutOfBounds.selector);
        engine.setBaseCarry(0, 1e16 + 1);
        vm.expectRevert(ILemniscateEngine.CarryOutOfBounds.selector);
        engine.setBaseCarry(0, -1);
        engine.setBaseCarry(0, 4e15); // unchanged value is a no-op even inside the cooldown
        vm.expectRevert(ILemniscateEngine.CarryChangeTooFast.selector);
        engine.setBaseCarry(0, 5e15); // listed at t0: cooldown runs until t0 + 1 day

        vm.warp(t0 + 1 days);
        vm.expectRevert(ILemniscateEngine.CarryChangeTooFast.selector);
        engine.setBaseCarry(0, 5e15 + 1); // 25% of 4e15 is the largest step
        engine.setBaseCarry(0, 5e15);
        assertEq(engine.getState(0).baseCarryWad, 5e15);

        vm.warp(t0 + 2 days - 1);
        vm.expectRevert(ILemniscateEngine.CarryChangeTooFast.selector);
        engine.setBaseCarry(0, 3.75e15);
        vm.warp(t0 + 2 days);
        engine.setBaseCarry(0, 3.75e15); // exactly -25%
        vm.expectRevert(ILemniscateEngine.MarketNotFound.selector);
        engine.setBaseCarry(2, 0);
    }

    function testTradeGuards() public {
        address u = makeAddr("u");
        usdg.mint(u, 10_000_000 * USDG);
        vm.startPrank(u);
        usdg.approve(address(engine), type(uint256).max);
        uint256 ts = vm.getBlockTimestamp();
        vm.expectRevert(ILemniscateEngine.Expired.selector);
        engine.buy(0, 10 * USDG, 0, u, ts - 1);
        vm.expectRevert(ILemniscateEngine.ZeroAddress.selector);
        engine.buy(0, 10 * USDG, 0, address(0), ts);
        vm.expectRevert(ILemniscateEngine.TradeTooSmall.selector);
        engine.buy(0, USDG - 1, 0, u, ts);
        vm.expectRevert(ILemniscateEngine.TradeTooLarge.selector);
        engine.buy(0, 2_000_000 * USDG + 1, 0, u, ts);
        vm.expectRevert(ILemniscateEngine.MarketNotFound.selector);
        engine.buy(2, 10 * USDG, 0, u, ts);
        vm.expectRevert(ILemniscateEngine.GlobalCapExceeded.selector); // empty vault: NAV is zero
        engine.buy(0, USDG, 0, u, ts);
        vm.stopPrank();

        usdg.mint(address(this), 10_000_000 * USDG);
        usdg.approve(address(vault), type(uint256).max);
        vault.deposit(10_000_000 * USDG, address(this));
        vm.startPrank(u);
        (uint256 quoted,,,) = engine.quoteBuy(0, 10 * USDG);
        vm.expectRevert(ILemniscateEngine.Slippage.selector);
        engine.buy(0, 10 * USDG, quoted + 1, u, ts);
        uint256 tokensOut = engine.buy(0, USDG, 0, u, ts); // exactly the minimum trade
        vm.expectRevert(ILemniscateEngine.TradeTooSmall.selector);
        engine.sell(0, 0, 0, u, ts);
        vm.expectRevert(ILemniscateEngine.TradeTooLarge.selector);
        engine.sell(0, tokensOut + 1, 0, u, ts);
        vm.expectRevert(ILemniscateEngine.Expired.selector);
        engine.sell(0, tokensOut, 0, u, ts - 1);
        vm.expectRevert(ILemniscateEngine.ZeroAddress.selector);
        engine.sell(0, tokensOut, 0, address(0), ts);
        (uint256 out,,) = engine.quoteSell(0, tokensOut);
        vm.expectRevert(ILemniscateEngine.Slippage.selector);
        engine.sell(0, tokensOut, out + 1, u, ts);
        vm.expectRevert(ILemniscateEngine.MarketNotFound.selector);
        engine.sell(3, tokensOut, 0, u, ts);
        vm.stopPrank();

        vm.prank(GUARDIAN);
        engine.setBuysPaused(0, true);
        vm.prank(u);
        vm.expectRevert(ILemniscateEngine.BuysPausedErr.selector);
        engine.buy(0, 10 * USDG, 0, u, ts);
        vm.prank(GUARDIAN);
        engine.setBuysPaused(0, false);
        vm.prank(GUARDIAN);
        engine.setGlobalBuysPaused(true);
        vm.prank(u);
        vm.expectRevert(ILemniscateEngine.BuysPausedErr.selector);
        engine.buy(1, 10 * USDG, 0, u, ts);

        vm.expectRevert(ILemniscateEngine.MarketNotFound.selector);
        engine.accrue(2);
        vm.expectRevert(ILemniscateEngine.MarketNotFound.selector);
        engine.getState(2);
        vm.expectRevert(ILemniscateEngine.MarketNotFound.selector);
        engine.quoteSell(2, 1);
        vm.expectRevert(ILemniscateEngine.MarketNotFound.selector);
        engine.tokenPrice(2);
    }

    // =================================================================== WriterPool

    function testVaultAdminSettersRejectStrangers() public {
        vm.startPrank(stranger);
        _unauthorized(stranger, bytes32(0));
        vault.setDepositor(stranger, true);
        _unauthorized(stranger, bytes32(0));
        vault.setPublicDeposits(false);
        _unauthorized(stranger, bytes32(0));
        vault.setParams(1 days, 1_000, 10_000, 1_000, 100, 0, 0);
        _unauthorized(stranger, bytes32(0));
        vault.setNavGuard(50, 300);
        _unauthorized(stranger, bytes32(0));
        vault.setPriceReference(IPriceReference(address(0)));
        _unauthorized(stranger, bytes32(0));
        vault.setHedgeRoute(0, adapters[0], 500);
        _unauthorized(stranger, bytes32(0));
        vault.syncHedgeUnits(0);
        _unauthorized(stranger, vault.KEEPER_ROLE());
        vault.rebalance(0);
        vm.stopPrank();
        // A keeper is not an admin.
        vm.prank(KEEPER);
        _unauthorized(KEEPER, bytes32(0));
        vault.setNavGuard(50, 300);
    }

    function testVaultParamBoundsAtAndBeyondLimits() public {
        vault.setParams(30 days, 5_000, 15_000, 10_000, 500, 0, 0);
        assertEq(vault.lockSeconds(), 30 days);
        vm.expectRevert(IWriterPool.InvalidParams.selector);
        vault.setParams(30 days + 1, 5_000, 15_000, 10_000, 500, 0, 0);
        vm.expectRevert(IWriterPool.InvalidParams.selector);
        vault.setParams(30 days, 5_001, 15_000, 10_000, 500, 0, 0);
        vm.expectRevert(IWriterPool.InvalidParams.selector);
        vault.setParams(30 days, 5_000, 15_001, 10_000, 500, 0, 0);
        vm.expectRevert(IWriterPool.InvalidParams.selector);
        vault.setParams(30 days, 5_000, 15_000, 10_001, 500, 0, 0);
        vm.expectRevert(IWriterPool.InvalidParams.selector);
        vault.setParams(30 days, 5_000, 15_000, 10_000, 501, 0, 0);
        vault.setParams(0, 0, 0, 0, 0, 0, 0);
        assertEq(vault.maxDeposit(address(this)), 0, "zero deposit cap closes deposits");

        vault.setNavGuard(2_000, 2_000);
        vm.expectRevert(IWriterPool.InvalidParams.selector);
        vault.setNavGuard(2_001, 0);
        vm.expectRevert(IWriterPool.InvalidParams.selector);
        vault.setNavGuard(0, 2_001);
        vault.setNavGuard(0, 0);
        assertEq(vault.navGuardOpenBps(), 0);

        vm.expectRevert(IWriterPool.InvalidParams.selector);
        vault.setDepositor(address(0), true);
        vault.setDepositor(stranger, true);
        assertTrue(vault.isDepositor(stranger));
        vault.setPublicDeposits(false);
        assertFalse(vault.publicDeposits());
    }

    function testHedgeRouteAndSyncValidation() public {
        vm.expectRevert(IWriterPool.InvalidRoute.selector);
        vault.setHedgeRoute(2, adapters[0], 500);
        vm.expectRevert(IWriterPool.InvalidRoute.selector);
        vault.setHedgeRoute(0, IHedgeAdapter(address(0)), 500);
        vm.expectRevert(IWriterPool.InvalidRoute.selector);
        vault.setHedgeRoute(0, IHedgeAdapter(stranger), 500);
        vm.expectRevert(IWriterPool.InvalidRoute.selector);
        vault.setHedgeRoute(0, adapters[0], 0);
        vault.setHedgeRoute(0, adapters[1], 3_000);
        (IHedgeAdapter a, uint24 fee) = vault.routeForMarket(0);
        assertEq(address(a), address(adapters[1]));
        assertEq(fee, 3_000);

        vm.expectRevert(IWriterPool.InvalidMarketId.selector);
        vault.syncHedgeUnits(2);
        stocks[0].mint(address(vault), 7e18); // donation
        vault.syncHedgeUnits(0);
        assertEq(vault.hedgeUnits(0), 7e18);

        vm.prank(KEEPER);
        vm.expectRevert(IWriterPool.InvalidMarketId.selector);
        vault.rebalance(2);
    }

    function testPayIsEngineOnlyAndRejectsZeroRecipient() public {
        vm.expectRevert(IWriterPool.NotEngine.selector);
        vault.pay(stranger, 1, 0);
        vm.prank(address(engine));
        vm.expectRevert(IWriterPool.InvalidParams.selector);
        vault.pay(address(0), 1, 0);
        vm.prank(address(engine));
        vm.expectRevert(IWriterPool.InsufficientLiquidity.selector); // empty vault cannot pay
        vault.pay(stranger, 1, 0);
    }

    function testDepositRulesAndLockBoundaries() public {
        usdg.mint(stranger, 1_000 * USDG);
        vm.startPrank(stranger);
        usdg.approve(address(vault), type(uint256).max);
        vm.expectRevert(IWriterPool.InvalidParams.selector); // must self-receive
        vault.deposit(100 * USDG, address(this));
        vm.expectRevert(IWriterPool.InvalidParams.selector);
        vault.mint(1e12, address(this));
        vault.deposit(100 * USDG, stranger);
        uint256 t = vm.getBlockTimestamp();
        assertEq(vault.unlockTime(stranger), t + 1 days);
        vm.warp(t + 1 days - 1);
        vm.expectRevert(IWriterPool.WithdrawalLocked.selector);
        vault.transfer(address(this), 1);
        assertEq(vault.maxRedeem(stranger), 0);
        assertEq(vault.maxWithdraw(stranger), 0);
        vm.warp(t + 1 days);
        vault.transfer(address(this), 1);
        vault.redeem(vault.maxRedeem(stranger), stranger, stranger);
        vm.stopPrank();

        vault.setPublicDeposits(false);
        assertEq(vault.maxDeposit(stranger), 0);
        assertEq(vault.maxMint(stranger), 0);
        vm.prank(stranger);
        vm.expectRevert();
        vault.deposit(USDG, stranger);
    }

    // =================================================================== MarketHours

    function testMarketHoursBoundsAtAndBeyondLimits() public {
        uint64 t = uint64(vm.getBlockTimestamp());
        Session[] memory one = new Session[](1);

        one[0] = Session({open: t, close: t + uint64(mh.MAX_SESSION_LENGTH())});
        vm.prank(mhKeeper);
        mh.setSessions(one);
        one[0].close += 1;
        vm.prank(mhKeeper);
        vm.expectRevert(abi.encodeWithSelector(IMarketHours.SessionTooLong.selector, 0));
        mh.setSessions(one);

        one[0] = Session({open: t + 30 days - 1, close: t + 30 days});
        vm.prank(mhKeeper);
        mh.setSessions(one);
        one[0] = Session({open: t + 30 days, close: t + 30 days + 1});
        vm.prank(mhKeeper);
        vm.expectRevert(abi.encodeWithSelector(IMarketHours.SessionTooFar.selector, 0));
        mh.setSessions(one);

        Session[] memory many = new Session[](32);
        for (uint256 i; i < 32; ++i) {
            many[i] = Session({open: t + uint64(i) * 10, close: t + uint64(i) * 10 + 10}); // back-to-back is fine
        }
        vm.prank(mhKeeper);
        mh.setSessions(many);
        assertEq(mh.sessions().length, 32);
        assertTrue(mh.isOpen(t + 315));
        assertFalse(mh.isOpen(t + 320));

        vm.prank(mhKeeper);
        mh.setSessions(new Session[](0));
        assertEq(mh.sessions().length, 0);
        assertFalse(mh.isOpen(t));
        (bool openNow,,, uint64 nextOpen) = mh.currentSession();
        assertFalse(openNow);
        assertEq(nextOpen, 0);

        _unauthorized(mhAdmin, mh.KEEPER_ROLE());
        vm.prank(mhAdmin);
        mh.setSessions(one);
        address mhImpl = address(new MarketHours());
        _unauthorized(mhKeeper, bytes32(0));
        vm.prank(mhKeeper);
        mh.upgradeToAndCall(mhImpl, "");
        vm.prank(mhAdmin);
        mh.upgradeToAndCall(mhImpl, "");
        assertEq(_impl(address(mh)), mhImpl);
    }
}
