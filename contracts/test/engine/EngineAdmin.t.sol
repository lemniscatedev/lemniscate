// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {Vm} from "forge-std/Vm.sol";
import {EngineBase} from "./EngineBase.sol";
import {LemniscateEngine} from "../../src/LemniscateEngine.sol";
import {EngineHelper} from "../../src/EngineHelper.sol";
import {IOptionEngine} from "../../src/interfaces/IOptionEngine.sol";
import {IPool} from "../../src/interfaces/IPool.sol";
import {IPriceGuard} from "../../src/interfaces/IPriceGuard.sol";
import {ISeriesRegistry} from "../../src/interfaces/ISeriesRegistry.sol";
import {IVolOracle} from "../../src/interfaces/IVolOracle.sol";
import {SessionKind} from "../../src/libs/OptionTypes.sol";

contract LemniscateEngineV2 is LemniscateEngine {
    function version() external pure returns (uint256) {
        return 2;
    }
}

/// @notice Engine todo R14 (upgradeability), R15 (events match the interface), roles and parameter bounds.
contract EngineAdminTest is EngineBase {
    // ---------------------------------------------------------------------------------------------------- R14

    function test_R14_upgradeability() public {
        bytes32 id = _list(address(nvda), true, 100e18, DAILY);
        (, uint256 tokens) = _buy(alice, id, 10e18);
        LemniscateEngineV2 v2 = new LemniscateEngineV2();
        // Only the admin.
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, alice, bytes32(0))
        );
        vm.prank(alice);
        engine.upgradeToAndCall(address(v2), "");
        vm.prank(admin);
        engine.upgradeToAndCall(address(v2), "");
        assertEq(LemniscateEngineV2(address(engine)).version(), 2);
        // State survives (namespaced storage).
        assertEq(engine.bookValue() > 0, true);
        assertEq(address(engine.pool()), address(pool));
        assertGt(_sell(alice, id, tokens), 0);
        // Freeze: one way, then every upgrade reverts.
        vm.expectRevert();
        vm.prank(alice);
        engine.freezeUpgrades();
        vm.prank(admin);
        engine.freezeUpgrades();
        (,,, bool frozen) = engine.flags();
        assertTrue(frozen);
        LemniscateEngineV2 v3 = new LemniscateEngineV2();
        vm.expectRevert(LemniscateEngine.UpgradesAreFrozen.selector);
        vm.prank(admin);
        engine.upgradeToAndCall(address(v3), "");
    }

    function test_R14_implementationInitializerDisabled() public {
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        impl.initialize(
            admin,
            IERC20(address(usdg)),
            IPool(address(pool)),
            ISeriesRegistry(address(registry)),
            IPriceGuard(address(guard)),
            IVolOracle(address(vol))
        );
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        engine.initialize(
            admin,
            IERC20(address(usdg)),
            IPool(address(pool)),
            ISeriesRegistry(address(registry)),
            IPriceGuard(address(guard)),
            IVolOracle(address(vol))
        );
    }

    function test_R14_storageGapAndNamespace() public view {
        // The engine keeps its state in the ERC-7201 slot and a 50-slot gap in its own layout.
        bytes32 slot = 0xb5f0e3dfa5c5f6c3b52e8dd8b159b6dbf0474bd4b0fadb6ac62bee348f97c000; // not-a-key
        assertEq(address(uint160(uint256(vm.load(address(engine), slot)))), address(usdg), "usdg at slot 0");
        assertEq(
            slot,
            keccak256(abi.encode(uint256(keccak256("lemniscate.storage.Engine")) - 1)) & ~bytes32(uint256(0xff))
        );
    }

    // ---------------------------------------------------------------------------------------------------- R15

    function test_R15_eventsMatchInterface() public {
        bytes32 id = _list(address(nvda), true, 100e18, DAILY);
        IOptionEngine.Quote memory q = engine.quote(id, 10e18, true);
        vm.expectEmit(true, true, false, true, address(engine));
        emit IOptionEngine.Bought(id, alice, alice, 10e18, 10e18, q.usdg, q.vMarkWad, q.sigmaBps, SessionKind.REGULAR);
        vm.prank(alice);
        engine.buy(id, 10e18, type(uint128).max, uint64(vm.getBlockTimestamp()), alice);

        skip(1 hours);
        uint256 n = _normAfter(id);
        (uint256 v, uint256 payoff,,) = engine.vMark(id);
        vm.expectEmit(true, false, false, true, address(engine));
        emit IOptionEngine.Accrued(id, uint128(n), v, payoff, SessionKind.REGULAR);
        engine.accrue(id);

        uint256 units = Math.mulDiv(10e18, n, WAD);
        IOptionEngine.Quote memory s = engine.quote(id, units, false);
        vm.expectEmit(true, true, false, true, address(engine));
        emit IOptionEngine.Sold(id, alice, bob, units, 10e18, s.usdg, s.vMarkWad, s.sigmaBps, SessionKind.REGULAR);
        vm.prank(alice);
        engine.sell(id, 10e18, 0, uint64(vm.getBlockTimestamp()), bob);

        vm.expectEmit(false, true, false, true, address(engine));
        emit IOptionEngine.BuysPaused(true, bytes32(0), true);
        vm.prank(guardian);
        engine.setBuysPaused(true);
        vm.expectEmit(false, true, false, true, address(engine));
        emit IOptionEngine.BuysPaused(false, id, true);
        vm.prank(guardian);
        engine.setSeriesBuysPaused(id, true);
    }

    function _normAfter(bytes32 id) internal returns (uint256 n) {
        uint256 snap = vm.snapshotState();
        engine.accrue(id);
        n = registry.seriesOf(id).norm;
        vm.revertToState(snap);
    }

    /// @dev Topic layout the indexer decodes (todo 11): SellQueued(ticket, id, seller indexed; recipient, tokens,
    /// queuedAt data), QueuedSellFilled(ticket indexed; filler, usdgOut data), QueuedSellCancelled(ticket indexed).
    function test_R15_queueEventTopics() public {
        bytes32 id = _list(address(nvda), true, 100e18, DAILY);
        (, uint256 tokens) = _buy(alice, id, 10e18);
        guard.setSession(address(nvda), SessionKind.HALTED);
        vm.recordLogs();
        _sell(alice, id, tokens);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 sig = keccak256("SellQueued(uint256,bytes32,address,address,uint128,uint64)");
        assertEq(sig, IOptionEngine.SellQueued.selector);
        bool seen;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] != sig) continue;
            seen = true;
            assertEq(logs[i].emitter, address(engine));
            assertEq(logs[i].topics.length, 4);
            assertEq(uint256(logs[i].topics[1]), 1);
            assertEq(logs[i].topics[2], id);
            assertEq(address(uint160(uint256(logs[i].topics[3]))), alice);
            (address recipient, uint128 tok, uint64 at) = abi.decode(logs[i].data, (address, uint128, uint64));
            assertEq(recipient, alice);
            assertEq(tok, tokens);
            assertEq(at, vm.getBlockTimestamp());
        }
        assertTrue(seen);
        assertEq(keccak256("QueuedSellFilled(uint256,address,uint256)"), IOptionEngine.QueuedSellFilled.selector);
        assertEq(keccak256("QueuedSellCancelled(uint256)"), IOptionEngine.QueuedSellCancelled.selector);
        // filler is NOT indexed: topics = [sig, ticket]
        guard.setSession(address(nvda), SessionKind.REGULAR);
        vm.recordLogs();
        engine.fillQueued(1);
        logs = vm.getRecordedLogs();
        seen = false;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] != IOptionEngine.QueuedSellFilled.selector) continue;
            seen = true;
            assertEq(logs[i].topics.length, 2);
        }
        assertTrue(seen);
    }

    /// @dev netGreeks is the outstanding options' (holders') aggregate: a long call book has positive delta.
    function test_R15_netGreeksAreTheHoldersSide() public {
        bytes32 c = _list(address(nvda), true, 100e18, DAILY);
        bytes32 p = _list(address(nvda), false, 100e18, WEEKLY);
        _buy(alice, c, 100e18);
        (int256 d, int256 g, int256 v) = engine.netGreeks(address(nvda));
        assertGt(d, 0);
        assertGt(g, 0);
        assertGt(v, 0);
        assertApproxEqRel(uint256(d), 100e18 * 5046 / 10_000, 0.01e18, "~0.5046 per Daily ATM call");
        _buy(alice, p, 300e18);
        (d,,) = engine.netGreeks(address(nvda));
        assertLt(d, 0, "puts dominate");
    }

    // ------------------------------------------------------------------------------------------- roles, params

    function test_guardianMayOnlyPause() public {
        EngineHelper.Params memory cur = engine.params();
        vm.startPrank(guardian);
        engine.setBuysPaused(true);
        vm.expectRevert(LemniscateEngine.NotGuardian.selector);
        engine.setBuysPaused(false);
        vm.expectRevert();
        engine.setParams(cur);
        vm.stopPrank();
        vm.expectRevert(LemniscateEngine.NotGuardian.selector);
        vm.prank(alice);
        engine.setBuysPaused(true);
        vm.prank(admin);
        engine.setBuysPaused(false);
        (bool g,,,) = engine.flags();
        assertFalse(g);
    }

    function test_paramsValidated() public {
        EngineHelper.Params memory p = engine.params();
        assertEq(p.feeBps, 3);
        assertEq(p.spreadAtmBps, 150);
        assertEq(p.spreadFarBps, 400);
        assertEq(p.seriesCapWad, 40_000e18);
        assertEq(p.accountCapWad, 25_000e18);
        assertEq(p.stressBudgetBps, 2000);
        p.spreadFarBps = 100; // below ATM
        vm.expectRevert(abi.encodeWithSelector(EngineHelper.InvalidParams.selector, bytes32("spreadFarBps")));
        vm.prank(admin);
        engine.setParams(p);
        p = engine.params();
        p.stressBudgetBps = 9000;
        vm.expectRevert(abi.encodeWithSelector(EngineHelper.InvalidParams.selector, bytes32("stressBudgetBps")));
        vm.prank(admin);
        engine.setParams(p);
        p = engine.params();
        p.feeBps = 5;
        vm.prank(admin);
        engine.setParams(p);
        assertEq(engine.params().feeBps, 5);
    }
}
