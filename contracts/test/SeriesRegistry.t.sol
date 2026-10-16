// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SeriesRegistry} from "../src/SeriesRegistry.sol";
import {ISeriesRegistry} from "../src/interfaces/ISeriesRegistry.sol";
import {IPriceGuard} from "../src/interfaces/IPriceGuard.sol";
import {IOptionToken} from "../src/interfaces/IOptionToken.sol";
import {Series, Speed} from "../src/libs/OptionTypes.sol";
import {MockLastGoodPrice} from "./mocks/MockLastGoodPrice.sol";
import {MockFundingEngine} from "./mocks/MockFundingEngine.sol";

contract SeriesRegistryTest is Test {
    SeriesRegistry internal registry;
    MockLastGoodPrice internal guard;
    MockFundingEngine internal engine;
    address internal admin = makeAddr("admin");
    address internal lister = makeAddr("lister");
    address internal nvda = makeAddr("nvda");
    address internal tsla = makeAddr("tsla");

    uint32 internal constant DAILY = 86_400;
    uint32 internal constant WEEKLY = 604_800;

    function setUp() public {
        vm.warp(1_800_000_000);
        guard = new MockLastGoodPrice();
        registry = new SeriesRegistry(admin, IPriceGuard(address(guard)));
        engine = new MockFundingEngine(ISeriesRegistry(address(registry)));
        vm.startPrank(admin);
        registry.setEngine(address(engine));
        registry.grantRole(registry.KEEPER_ROLE(), lister);
        registry.setStock(nvda, true, 0, "NVDA");
        vm.stopPrank();
        guard.setLast(nvda, 100e18);
    }

    function _list(bool isCall, uint128 strike, uint32 tau) internal returns (bytes32) {
        vm.prank(lister);
        return registry.listSeries(nvda, isCall, strike, tau);
    }

    // ------------------------------------------------------------------------------------------------------ R1

    function test_R1_seriesIdDeterministic() public {
        bytes32 id = _list(true, 110e18, WEEKLY);
        assertEq(id, keccak256(abi.encode(nvda, true, uint128(110e18), WEEKLY)));
        assertEq(id, registry.idOf(nvda, true, 110e18, WEEKLY));
        assertEq(registry.seriesCount(), 1);
        assertEq(registry.seriesIdAt(0), id);

        vm.expectRevert(abi.encodeWithSelector(ISeriesRegistry.SeriesExists.selector, id));
        _list(true, 110e18, WEEKLY);

        // Any field change is a different series.
        assertTrue(_list(false, 110e18, WEEKLY) != id);
        assertTrue(_list(true, 110e18, DAILY) != id);
        assertTrue(_list(true, 120e18, WEEKLY) != id);
        assertEq(registry.seriesCount(), 4);
    }

    function testFuzz_R1_idMatchesAbiEncode(address stock, bool isCall, uint128 strike, uint32 tau) public view {
        assertEq(registry.idOf(stock, isCall, strike, tau), keccak256(abi.encode(stock, isCall, strike, tau)));
    }

    function test_R1_listingStoresSeriesAndToken() public {
        bytes32 id = _list(true, 110e18, WEEKLY);
        Series memory s = registry.seriesOf(id);
        assertEq(s.stock, nvda);
        assertTrue(s.isCall);
        assertEq(uint8(s.speed), uint8(Speed.WEEKLY));
        assertEq(s.tauSeconds, WEEKLY);
        assertEq(s.strike, 110e18);
        assertEq(s.norm, 1e18);
        assertEq(s.lastAccrual, block.timestamp);
        assertEq(s.listedAt, block.timestamp);
        assertFalse(s.buyable, "listed non-buyable until SeriesBuyableSet");
        assertFalse(s.archived);
        assertEq(s.token, registry.predictToken(id));
        assertEq(IOptionToken(s.token).seriesId(), id);
        assertEq(IOptionToken(s.token).engine(), address(engine));
        assertEq(IERC20Metadata(s.token).name(), "Lemniscate NVDA Up 110 Weekly");
        assertEq(IERC20Metadata(s.token).symbol(), "eNVDA-C-110-W");
        assertEq(IERC20Metadata(s.token).decimals(), 18);
    }

    function test_R1_namesForPutsDailyAndFractionalStrikes() public {
        bytes32 id = _list(false, 112.5e18, DAILY);
        address token = registry.seriesOf(id).token;
        assertEq(IERC20Metadata(token).name(), "Lemniscate NVDA Down 112.5 Daily");
        assertEq(IERC20Metadata(token).symbol(), "eNVDA-P-112.5-D");
        id = _list(true, 99.05e18, DAILY);
        assertEq(IERC20Metadata(registry.seriesOf(id).token).symbol(), "eNVDA-C-99.05-D");
    }

    // ------------------------------------------------------------------------------------------------------ R2

    function test_R2_onlyListerLists() public {
        // The lister is the keeper key: the role id is the shared KEEPER_ROLE.
        assertEq(registry.KEEPER_ROLE(), keccak256("KEEPER_ROLE"));
        address outsider = makeAddr("outsider");
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, outsider, registry.KEEPER_ROLE())
        );
        vm.prank(outsider);
        registry.listSeries(nvda, true, 110e18, WEEKLY);

        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, outsider, registry.KEEPER_ROLE())
        );
        vm.prank(outsider);
        registry.setBuyable(bytes32(0), false);

        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, outsider, registry.KEEPER_ROLE())
        );
        vm.prank(outsider);
        registry.archive(bytes32(0));

        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, outsider, registry.DEFAULT_ADMIN_ROLE()
            )
        );
        vm.prank(outsider);
        registry.setStock(tsla, true, 0, "TSLA");
    }

    function test_R2_onlyEngineStoresAccrual() public {
        bytes32 id = _list(true, 110e18, WEEKLY);
        vm.expectRevert(SeriesRegistry.NotEngine.selector);
        vm.prank(lister);
        registry.storeAccrual(id, 0.9e18, uint64(block.timestamp));

        vm.prank(address(engine));
        registry.storeAccrual(id, 0.9e18, uint64(block.timestamp + 1));
        assertEq(registry.seriesOf(id).norm, 0.9e18);

        // The norm only falls and the accrual clock only moves forward.
        vm.startPrank(address(engine));
        vm.expectRevert(abi.encodeWithSelector(SeriesRegistry.NormRises.selector, uint128(0.9e18), uint128(0.95e18)));
        registry.storeAccrual(id, 0.95e18, uint64(block.timestamp + 2));
        vm.expectRevert(abi.encodeWithSelector(SeriesRegistry.NormRises.selector, uint128(0.9e18), uint128(0)));
        registry.storeAccrual(id, 0, uint64(block.timestamp + 2));
        vm.expectRevert(
            abi.encodeWithSelector(
                SeriesRegistry.AccrualBackwards.selector, uint64(block.timestamp + 1), uint64(block.timestamp)
            )
        );
        registry.storeAccrual(id, 0.9e18, uint64(block.timestamp));
        vm.expectRevert(abi.encodeWithSelector(ISeriesRegistry.SeriesUnknown.selector, bytes32(uint256(1))));
        registry.storeAccrual(bytes32(uint256(1)), 0.9e18, uint64(block.timestamp + 2));
        vm.stopPrank();
    }

    function test_R2_engineSetOnceAndRequired() public {
        SeriesRegistry fresh = new SeriesRegistry(admin, IPriceGuard(address(guard)));
        vm.startPrank(admin);
        fresh.grantRole(fresh.KEEPER_ROLE(), lister);
        fresh.setStock(nvda, true, 0, "NVDA");
        vm.stopPrank();
        vm.expectRevert(SeriesRegistry.EngineNotSet.selector);
        vm.prank(lister);
        fresh.listSeries(nvda, true, 110e18, WEEKLY);
        // Before an engine is set, storeAccrual from address(0) is impossible and any caller is refused.
        vm.expectRevert(SeriesRegistry.NotEngine.selector);
        fresh.storeAccrual(bytes32(0), 1, 1);

        vm.expectRevert(SeriesRegistry.EngineAlreadySet.selector);
        vm.prank(admin);
        registry.setEngine(makeAddr("other"));
    }

    function test_R2_listingNeedsAllowedStock() public {
        vm.expectRevert(abi.encodeWithSelector(ISeriesRegistry.StockNotAllowed.selector, tsla));
        vm.prank(lister);
        registry.listSeries(tsla, true, 110e18, WEEKLY);

        vm.prank(admin);
        registry.setStock(nvda, false, 0, "NVDA");
        assertFalse(registry.allowedStock(nvda));
        vm.expectRevert(abi.encodeWithSelector(ISeriesRegistry.StockNotAllowed.selector, nvda));
        _list(true, 110e18, WEEKLY);
    }

    function test_R2_strikeInsideTenToThousandPercent() public {
        // S = 100: strikes 10 and 1000 are the inclusive ends.
        _list(true, 10e18, WEEKLY);
        _list(true, 1000e18, WEEKLY);
        vm.expectRevert(abi.encodeWithSelector(ISeriesRegistry.StrikeInvalid.selector, uint128(10e18 - 1)));
        _list(true, 10e18 - 1, WEEKLY);
        vm.expectRevert(abi.encodeWithSelector(ISeriesRegistry.StrikeInvalid.selector, uint128(1000e18 + 1)));
        _list(true, 1000e18 + 1, WEEKLY);
        vm.expectRevert(abi.encodeWithSelector(ISeriesRegistry.StrikeInvalid.selector, uint128(0)));
        _list(true, 0, WEEKLY);
    }

    function test_R2_strikeStepCheckedWhenSet() public {
        vm.prank(admin);
        registry.setStock(nvda, true, 5e18, "NVDA");
        _list(true, 105e18, WEEKLY);
        vm.expectRevert(abi.encodeWithSelector(ISeriesRegistry.StrikeInvalid.selector, uint128(107e18)));
        _list(true, 107e18, WEEKLY);
    }

    function test_R2_tauMustBeDailyOrWeekly() public {
        vm.expectRevert(abi.encodeWithSelector(SeriesRegistry.TauInvalid.selector, uint32(3600)));
        _list(true, 110e18, 3600);
    }

    function test_R2_noLastGoodPriceFallsBackToFreshReading() public {
        vm.prank(admin);
        registry.setStock(tsla, true, 0, "TSLA");
        vm.expectRevert(abi.encodeWithSelector(SeriesRegistry.NoPrice.selector, tsla));
        vm.prank(lister);
        registry.listSeries(tsla, true, 300e18, WEEKLY);

        guard.setCurrent(tsla, 250e18, false);
        vm.expectRevert(abi.encodeWithSelector(SeriesRegistry.NoPrice.selector, tsla));
        vm.prank(lister);
        registry.listSeries(tsla, true, 300e18, WEEKLY);

        guard.setCurrent(tsla, 250e18, true);
        vm.prank(lister);
        bytes32 id = registry.listSeries(tsla, true, 300e18, WEEKLY);
        assertEq(IERC20Metadata(registry.seriesOf(id).token).symbol(), "eTSLA-C-300-W");
    }

    function test_R2_tickerRequired() public {
        vm.startPrank(admin);
        vm.expectRevert(SeriesRegistry.TickerInvalid.selector);
        registry.setStock(tsla, true, 0, "");
        vm.expectRevert(SeriesRegistry.TickerInvalid.selector);
        registry.setStock(tsla, true, 0, "ABCDEFGHIJKLM");
        vm.stopPrank();
    }

    // ----------------------------------------------------------------------------------------------------- R10

    function test_R10_archivedSeriesStaysSellableData() public {
        bytes32 id = _list(true, 110e18, WEEKLY);
        vm.prank(lister);
        registry.setBuyable(id, true);
        Series memory before = registry.seriesOf(id);
        address holder = makeAddr("holder");
        engine.mint(id, holder, 5e18);

        vm.expectEmit(true, false, false, true, address(registry));
        emit ISeriesRegistry.SeriesBuyableSet(id, false);
        vm.expectEmit(true, false, false, false, address(registry));
        emit ISeriesRegistry.SeriesArchived(id);
        vm.prank(lister);
        registry.archive(id);

        Series memory s = registry.seriesOf(id);
        assertFalse(s.buyable);
        assertTrue(s.archived);
        assertEq(s.token, before.token);
        assertEq(s.stock, before.stock);
        assertEq(s.strike, before.strike);
        assertEq(s.norm, before.norm);
        assertEq(registry.seriesCount(), 1);

        // Token still works: the holder can transfer and the engine can still burn on a sell; accrual continues.
        vm.warp(block.timestamp + 1 days);
        engine.setMark(2e18, 0);
        vm.prank(holder);
        IERC20Metadata(s.token).transfer(makeAddr("other"), 1e18);
        engine.burn(id, holder, 4e18);
        assertEq(IERC20Metadata(s.token).totalSupply(), 1e18);
        assertLt(registry.seriesOf(id).norm, before.norm);

        // Archived cannot be made buyable again.
        vm.expectRevert(abi.encodeWithSelector(SeriesRegistry.SeriesIsArchived.selector, id));
        vm.prank(lister);
        registry.setBuyable(id, true);
    }

    function test_R10_setBuyableTogglesAndUnknownReverts() public {
        bytes32 id = _list(true, 110e18, WEEKLY);
        vm.startPrank(lister);
        registry.setBuyable(id, false);
        assertFalse(registry.seriesOf(id).buyable);
        registry.setBuyable(id, true);
        assertTrue(registry.seriesOf(id).buyable);
        vm.expectRevert(abi.encodeWithSelector(ISeriesRegistry.SeriesUnknown.selector, bytes32(uint256(7))));
        registry.setBuyable(bytes32(uint256(7)), true);
        vm.expectRevert(abi.encodeWithSelector(ISeriesRegistry.SeriesUnknown.selector, bytes32(uint256(7))));
        registry.archive(bytes32(uint256(7)));
        vm.stopPrank();
    }

    function test_constructorRejectsZero() public {
        vm.expectRevert(SeriesRegistry.ZeroAddress.selector);
        new SeriesRegistry(address(0), IPriceGuard(address(guard)));
        vm.expectRevert(SeriesRegistry.ZeroAddress.selector);
        new SeriesRegistry(admin, IPriceGuard(address(0)));
    }
}
