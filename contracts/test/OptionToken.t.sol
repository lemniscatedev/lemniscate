// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {SeriesRegistry} from "../src/SeriesRegistry.sol";
import {OptionToken} from "../src/OptionToken.sol";
import {OptionTokenFactory} from "../src/OptionTokenFactory.sol";
import {ISeriesRegistry} from "../src/interfaces/ISeriesRegistry.sol";
import {IPriceGuard} from "../src/interfaces/IPriceGuard.sol";
import {MockLastGoodPrice} from "./mocks/MockLastGoodPrice.sol";
import {MockFundingEngine} from "./mocks/MockFundingEngine.sol";

/// @notice The per-series ERC-20 clone (todo 05 OptionToken; see OptionToken.sol for the name).
contract OptionTokenTest is Test {
    SeriesRegistry internal registry;
    MockFundingEngine internal engine;
    OptionToken internal token;
    bytes32 internal id;
    address internal admin = makeAddr("admin");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal nvda = makeAddr("nvda");

    function setUp() public {
        vm.warp(1_800_000_000);
        MockLastGoodPrice guard = new MockLastGoodPrice();
        guard.setLast(nvda, 100e18);
        registry = new SeriesRegistry(admin, IPriceGuard(address(guard)));
        engine = new MockFundingEngine(ISeriesRegistry(address(registry)));
        vm.startPrank(admin);
        registry.setEngine(address(engine));
        registry.grantRole(registry.KEEPER_ROLE(), admin);
        registry.setStock(nvda, true, 0, "NVDA");
        id = registry.listSeries(nvda, true, 110e18, 604_800);
        vm.stopPrank();
        token = OptionToken(registry.seriesOf(id).token);
        engine.setMark(2e18, 0);
    }

    // ------------------------------------------------------------------------------------------------------ R3

    function test_R3_cloneInitializesOnce() public {
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        token.initialize(address(this), id, "X", "X");

        // The implementation behind every clone is locked too.
        OptionToken impl = OptionToken(registry.factory().implementation());
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        impl.initialize(address(this), id, "X", "X");

        // The clone is a minimal proxy (45 bytes of EIP-1167 code).
        assertEq(address(token).code.length, 45);
    }

    function test_R3_decimals18AndMetadata() public view {
        assertEq(token.decimals(), 18);
        assertEq(token.engine(), address(engine));
        assertEq(token.seriesId(), id);
    }

    function test_R3_onlyEngineMintsAndBurns() public {
        engine.mint(id, alice, 10e18);
        assertEq(token.balanceOf(alice), 10e18);

        vm.expectRevert(OptionToken.NotEngine.selector);
        vm.prank(alice);
        token.mint(alice, 1e18);

        vm.expectRevert(OptionToken.NotEngine.selector);
        vm.prank(alice);
        token.burn(alice, 1e18);

        engine.burn(id, alice, 3e18);
        assertEq(token.balanceOf(alice), 7e18);
        assertEq(token.totalSupply(), 7e18);
    }

    function test_R3_factoryOnlyOwnerDeploysAndRejectsZeroEngine() public {
        OptionTokenFactory factory = registry.factory();
        vm.expectRevert(OptionTokenFactory.NotOwner.selector);
        factory.deploy(bytes32(uint256(1)), address(engine), "X", "X");

        // A factory owned by this test can show the zero-engine check of initialize.
        OptionTokenFactory own = new OptionTokenFactory();
        vm.expectRevert(OptionToken.InvalidEngine.selector);
        own.deploy(bytes32(uint256(1)), address(0), "X", "X");
    }

    // ------------------------------------------------------------------------------------------------------ R4

    function test_R4_accrueHookBeforeBalanceChange() public {
        // mint: accrue runs while the balance is still the old one.
        engine.watch(alice);
        uint256 calls = engine.accrueCalls();
        engine.mint(id, alice, 10e18);
        assertEq(engine.accrueCalls(), calls + 1, "mint accrues");
        assertEq(engine.watchedBalanceAtAccrue(), 0, "accrue before mint");
        assertEq(engine.supplyAtAccrue(), 0);

        // transfer
        vm.warp(block.timestamp + 1 hours);
        vm.prank(alice);
        token.transfer(bob, 4e18);
        assertEq(engine.accrueCalls(), calls + 2, "transfer accrues");
        assertEq(engine.watchedBalanceAtAccrue(), 10e18, "accrue before transfer");
        assertEq(registry.seriesOf(id).lastAccrual, block.timestamp, "norm current at transfer");

        // transferFrom
        vm.prank(alice);
        token.approve(bob, 2e18);
        assertEq(engine.accrueCalls(), calls + 2, "approve does not move balances");
        vm.warp(block.timestamp + 1 hours);
        vm.prank(bob);
        token.transferFrom(alice, bob, 2e18);
        assertEq(engine.accrueCalls(), calls + 3, "transferFrom accrues");
        assertEq(engine.watchedBalanceAtAccrue(), 6e18, "accrue before transferFrom");

        // burn
        engine.burn(id, alice, 1e18);
        assertEq(engine.accrueCalls(), calls + 4, "burn accrues");
        assertEq(engine.watchedBalanceAtAccrue(), 4e18, "accrue before burn");
        assertEq(engine.supplyAtAccrue(), 10e18);
    }

    function test_R4_revertingAccrueBlocksEveryBalanceChange() public {
        engine.mint(id, alice, 10e18);
        vm.prank(alice);
        token.approve(bob, 5e18);
        engine.setFail(true);

        vm.expectRevert(MockFundingEngine.AccrueFailed.selector);
        vm.prank(alice);
        token.transfer(bob, 1e18);

        vm.expectRevert(MockFundingEngine.AccrueFailed.selector);
        vm.prank(bob);
        token.transferFrom(alice, bob, 1e18);

        vm.expectRevert(MockFundingEngine.AccrueFailed.selector);
        engine.mint(id, alice, 1e18);

        vm.expectRevert(MockFundingEngine.AccrueFailed.selector);
        engine.burn(id, alice, 1e18);

        assertEq(token.balanceOf(alice), 10e18);
        assertEq(token.balanceOf(bob), 0);
        assertEq(token.totalSupply(), 10e18);
    }

    function test_R4_transferAccruesFundingIntoNorm() public {
        engine.mint(id, alice, 10e18);
        vm.warp(block.timestamp + 1 days);
        vm.prank(alice);
        token.transfer(bob, 1e18);
        // Weekly, far out of the money: one day shrinks the norm to e^(-1/7).
        assertApproxEqRel(registry.seriesOf(id).norm, 866877899750181628, 1e9);
    }
}
