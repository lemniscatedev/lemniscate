// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {EngineBase} from "./EngineBase.sol";
import {IOptionEngine} from "../../src/interfaces/IOptionEngine.sol";
import {IPriceGuard} from "../../src/interfaces/IPriceGuard.sol";
import {IVolOracle} from "../../src/interfaces/IVolOracle.sol";
import {Funding} from "../../src/libs/Funding.sol";
import {Series, SessionKind, Speed} from "../../src/libs/OptionTypes.sol";

/// @notice Engine todo R10 (accrue first), R12 (funding flows to the pool), R19 (one read per stock per transaction),
/// R20 (stress re-checked on accrue).
contract EngineAccrueTest is EngineBase {
    bytes32 internal callD;
    bytes32 internal putW;

    function setUp() public override {
        super.setUp();
        callD = _list(address(nvda), true, 100e18, DAILY);
        putW = _list(address(nvda), false, 95e18, WEEKLY);
    }

    // ---------------------------------------------------------------------------------------------------- R10

    function test_R10_accrueFirst_buySellTransfer() public {
        (, uint256 tokens) = _buy(alice, callD, 100e18);
        // transfer accrues first
        skip(2 hours);
        uint256 n0 = registry.seriesOf(callD).norm;
        vm.expectEmit(true, false, false, false, address(engine));
        emit IOptionEngine.Accrued(callD, 0, 0, 0, SessionKind.REGULAR);
        IERC20 tok = _token(callD);
        vm.prank(alice);
        tok.transfer(bob, tokens / 2);
        Series memory s = registry.seriesOf(callD);
        assertLt(s.norm, n0);
        assertEq(s.lastAccrual, vm.getBlockTimestamp());
        // buy accrues first
        skip(1 hours);
        vm.expectEmit(true, false, false, false, address(engine));
        emit IOptionEngine.Accrued(callD, 0, 0, 0, SessionKind.REGULAR);
        _buy(alice, callD, 1e18);
        assertEq(registry.seriesOf(callD).lastAccrual, vm.getBlockTimestamp());
        // sell accrues first
        skip(1 hours);
        vm.expectEmit(true, false, false, false, address(engine));
        emit IOptionEngine.Accrued(callD, 0, 0, 0, SessionKind.REGULAR);
        _sell(bob, callD, tokens / 2);
        assertEq(registry.seriesOf(callD).lastAccrual, vm.getBlockTimestamp());
    }

    function test_R10_accrueIsNoOpWithinTheBlock() public {
        _buy(alice, callD, 100e18);
        skip(1 hours);
        engine.accrue(callD);
        uint256 n = registry.seriesOf(callD).norm;
        uint256 used = new AccrueProbe().measure(engine, callD);
        assertEq(registry.seriesOf(callD).norm, n);
        emit log_named_uint("accrue() already accrued this block (gas)", used);
        assertLt(used, 15_000, "cheap no-op (incl. cold proxy access)");
    }

    function test_R10_accrueMany50SeriesGas() public {
        bytes32[] memory ids = new bytes32[](50);
        for (uint256 i; i < 50; ++i) {
            address stock = i % 2 == 0 ? address(nvda) : address(tsla);
            uint256 s = i % 2 == 0 ? 100 : 200;
            uint128 k = uint128((s * 80 / 100 + i * (s / 100)) * 1e18);
            ids[i] = _list(stock, (i / 2) % 2 == 0, k, i % 8 < 4 ? DAILY : WEEKLY);
            _buy(alice, ids[i], 20e18);
        }
        skip(1 hours);
        uint256 g = gasleft();
        engine.accrueMany(ids);
        uint256 used = g - gasleft();
        emit log_named_uint("accrueMany(50 series, 2 names) gas (mock oracles)", used);
        assertLt(used, 16_000_000, "half of a 32M block");
        for (uint256 i; i < 50; ++i) {
            assertEq(registry.seriesOf(ids[i]).lastAccrual, vm.getBlockTimestamp());
        }
    }

    function test_R10_zeroSupplySeriesKeepsItsNorm() public {
        skip(30 days);
        engine.accrue(callD);
        Series memory s = registry.seriesOf(callD);
        assertEq(s.norm, 1e18, "no holders: nothing to fund, the norm stays fresh");
        assertEq(s.lastAccrual, vm.getBlockTimestamp());
    }

    function test_R10_noPriceDefersTheGap() public {
        _buy(alice, callD, 100e18);
        uint64 last = registry.seriesOf(callD).lastAccrual;
        skip(1 hours);
        vol.set(address(nvda), Speed.DAILY, 0, 0, uint64(vm.getBlockTimestamp() + 1 hours)); // no vol at all
        engine.accrue(callD); // never reverts (token transfers depend on it)
        assertEq(registry.seriesOf(callD).lastAccrual, last, "gap left for the next priced accrual");
        IERC20 tok = _token(callD);
        vm.prank(alice);
        tok.transfer(bob, 1e18);
        _setVol(address(nvda), 5000, 0);
        skip(1 hours);
        engine.accrue(callD);
        // the whole 2h gap is charged at once
        assertEq(registry.seriesOf(callD).lastAccrual, vm.getBlockTimestamp());
    }

    // ---------------------------------------------------------------------------------------------------- R12

    function test_R12_fundingFlowsToPool() public {
        _buy(alice, callD, 1_000e18);
        _buy(bob, putW, 2_000e18);
        skip(5 hours);
        guard.setS(address(nvda), 103e18);
        int256 navBefore = _nav();
        uint256 supply = _token(callD).totalSupply();
        uint256 n0 = registry.seriesOf(callD).norm;
        (uint256 v,,,) = engine.vMark(callD);
        uint256 calls0 = pool.fundingCalls();
        engine.accrue(callD);
        uint256 n1 = registry.seriesOf(callD).norm;
        uint256 lost = Math.mulDiv(Math.mulDiv(supply, n0, WAD), v, WAD) - Math.mulDiv(Math.mulDiv(supply, n1, WAD), v, WAD);
        int256 navAfter = _nav();
        assertGt(lost, 0);
        assertApproxEqAbs(uint256(navAfter - navBefore), lost, 2, "NAV rises by exactly the holders' loss");
        assertEq(pool.fundingCalls(), calls0 + 1, "pool.onFunding called");
        assertApproxEqAbs(pool.fundingUsdg(), lost / 1e12, 1);
    }

    function testFuzz_R12_fundingConservation(uint256 dt, uint256 s, uint256 units) public {
        dt = bound(dt, 1, 10 days);
        s = bound(s, 70e18, 130e18);
        units = bound(units, 1e18, 2_000e18);
        _buy(alice, callD, units);
        _buy(alice, putW, units);
        skip(dt);
        guard.setS(address(nvda), s);
        int256 navBefore = _nav();
        uint256 holdersBefore = _liabilityRef();
        bytes32[] memory ids = new bytes32[](2);
        ids[0] = callD;
        ids[1] = putW;
        engine.accrueMany(ids);
        uint256 holdersAfter = _liabilityRef();
        assertLe(holdersAfter, holdersBefore);
        assertApproxEqAbs(uint256(_nav() - navBefore), holdersBefore - holdersAfter, 2, "value moves holders -> pool");
        // totalLiability is the exact recomputation
        assertEq(engine.totalLiability(), holdersAfter);
    }

    function test_R12_failingPoolNeverBlocksAccrual() public {
        _buy(alice, callD, 1_000e18);
        pool.setFailFunding(true);
        skip(3 hours);
        IERC20 tok = _token(callD);
        vm.prank(alice);
        tok.transfer(bob, 1e18); // accrual inside the transfer still works
        assertEq(registry.seriesOf(callD).lastAccrual, vm.getBlockTimestamp());
        uint256 missed = pool.fundingUsdg();
        pool.setFailFunding(false);
        skip(1 hours);
        engine.accrue(callD);
        assertGt(pool.fundingUsdg(), missed, "the backlog is reported with the next accrual");
    }

    // ---------------------------------------------------------------------------------------------------- R19

    function test_R19_oneReadPerStockPerTx_accrueMany() public {
        bytes32 c2 = _list(address(nvda), true, 105e18, DAILY);
        bytes32 t1 = _list(address(tsla), true, 200e18, WEEKLY);
        _buy(alice, callD, 10e18);
        _buy(alice, putW, 10e18);
        _buy(alice, c2, 10e18);
        _buy(alice, t1, 10e18);
        skip(1 hours);
        bytes32[] memory ids = new bytes32[](4);
        ids[0] = callD;
        ids[1] = putW;
        ids[2] = c2;
        ids[3] = t1;
        vm.expectCall(address(guard), abi.encodeCall(IPriceGuard.readLite, (address(nvda))), 1);
        vm.expectCall(address(guard), abi.encodeCall(IPriceGuard.readLite, (address(tsla))), 1);
        vm.expectCall(address(guard), abi.encodeCall(IPriceGuard.read, (address(nvda))), 0);
        vm.expectCall(address(vol), abi.encodeCall(IVolOracle.read, (address(nvda), Speed.DAILY)), 1);
        vm.expectCall(address(vol), abi.encodeCall(IVolOracle.read, (address(nvda), Speed.WEEKLY)), 1);
        engine.accrueMany(ids);
    }

    function test_R19_oneReadPerStockPerTx_sell() public {
        (, uint256 tokens) = _buy(alice, callD, 10e18);
        skip(1 hours);
        vm.expectCall(address(guard), abi.encodeCall(IPriceGuard.readLite, (address(nvda))), 1);
        vm.expectCall(address(guard), abi.encodeCall(IPriceGuard.read, (address(nvda))), 0);
        _sell(alice, callD, tokens);
    }

    function test_R19_buyUsesTheFullRead() public {
        skip(1 hours);
        vm.expectCall(address(guard), abi.encodeCall(IPriceGuard.read, (address(nvda))), 1);
        vm.expectCall(address(guard), abi.encodeCall(IPriceGuard.readLite, (address(nvda))), 0);
        _buy(alice, callD, 10e18);
    }

    function test_R19_gas() public {
        (, uint256 tokens) = _buy(bob, callD, 10e18);
        skip(1 hours);
        vm.prank(alice);
        uint256 g = gasleft();
        engine.buy(callD, 10e18, type(uint128).max, uint64(vm.getBlockTimestamp()), alice);
        emit log_named_uint("buy (accrues first, mock oracles) gas", g - gasleft());
        skip(1 hours);
        vm.prank(bob);
        g = gasleft();
        engine.sell(callD, uint128(tokens), 0, uint64(vm.getBlockTimestamp()), bob);
        emit log_named_uint("sell (accrues first, mock oracles) gas", g - gasleft());
    }

    // ---------------------------------------------------------------------------------------------------- R20

    function test_R20_stressRecheckedOnAccrue() public {
        bytes32 t1 = _list(address(tsla), true, 200e18, DAILY);
        // ~$386k of up-gap loss against a $400k budget.
        _buy(alice, callD, 16_000e18);
        (bool g,,,) = engine.flags();
        assertFalse(g);
        (, bool stress,,) = engine.flags();
        assertFalse(stress);
        // The price runs 5% after the buys: the same book now loses more than 20% of NAV in the up gap.
        skip(1);
        guard.setS(address(nvda), 105e18);
        vm.expectEmit(true, false, false, false, address(engine));
        emit IOptionEngine.AutoPaused("STRESS");
        engine.accrue(callD);
        (, stress,,) = engine.flags();
        assertTrue(stress, "auto-paused");
        vm.expectRevert(abi.encodeWithSelector(IOptionEngine.BuysArePaused.selector, bytes32("STRESS")));
        vm.prank(bob);
        engine.buy(t1, 1e18, type(uint128).max, uint64(vm.getBlockTimestamp()), bob);
        // Sells are never affected, and selling back under the budget clears the pause.
        vm.expectEmit(true, false, false, false, address(engine));
        emit IOptionEngine.AutoResumed("STRESS");
        _sell(alice, callD, 3_000e18);
        (, stress,,) = engine.flags();
        assertFalse(stress);
        _buy(bob, t1, 1e18);
    }

    /// todo 23 (fork run): the stress re-check reads the pool's NAV inside try/catch. With just enough gas for the rest
    /// of accrue, that read ran out of gas, the catch returned early and the accrual "succeeded" without the re-check:
    /// eth_estimateGas finds exactly that cheaper path, so wallets and the keeper sent accruals that then failed on
    /// chain (the real path costs more), and a caller could pick the gas that skips the re-check. The cheapest gas at
    /// which accrue succeeds must still run the re-check.
    function test_R20_stressRecheckCannotBeSkippedWithTightGas() public {
        _buy(alice, callD, 16_000e18);
        skip(1);
        guard.setS(address(nvda), 105e18);
        guard.setReadGas(57_000); // the real PriceGuard read on a mainnet fork
        pool.setNavGas(170_000); // the real WriterPool.navFor with hedges on a mainnet fork
        bytes memory call = abi.encodeCall(engine.accrue, (callD));
        uint256 snap = vm.snapshotState();
        (bool full,) = address(engine).call{gas: 5_000_000}(call);
        assertTrue(full);
        vm.revertToState(snap);
        uint256 lo = 50_000;
        uint256 hi = 5_000_000;
        while (hi - lo > 1_000) {
            uint256 mid = (lo + hi) / 2;
            snap = vm.snapshotState();
            (bool ok,) = address(engine).call{gas: mid}(call);
            vm.revertToState(snap);
            if (ok) hi = mid;
            else lo = mid;
        }
        (bool ok2,) = address(engine).call{gas: hi}(call);
        assertTrue(ok2, "succeeds at the cheapest gas");
        (, bool stress,,) = engine.flags();
        assertTrue(stress, "the stress re-check ran even at the cheapest gas that succeeds");
    }

    /// todo 20c (merge of todo 19 into todo 23's fix): the sell's buyback report to the pool (writer-vault settlement)
    /// sits in try/catch too. With just enough gas for the rest of the sell, the hook ran out of gas, the catch
    /// swallowed it and the sell succeeded without settling the vaults' covered slice. The cheapest gas at which a sell
    /// succeeds must still deliver the buyback report.
    function test_R20_buybackReportCannotBeSkippedWithTightGas() public {
        (, uint256 tokens) = _buy(alice, callD, 1_000e18);
        skip(1);
        pool.setBuybackGas(3_000_000); // a vault registry settling many covered slices
        uint256 before = pool.buybackCalls();
        bytes memory call = abi.encodeCall(engine.sell, (callD, uint128(tokens / 2), 0, uint64(block.timestamp), alice));
        uint256 lo = 50_000;
        uint256 hi = 10_000_000;
        while (hi - lo > 1_000) {
            uint256 mid = (lo + hi) / 2;
            uint256 snap = vm.snapshotState();
            vm.prank(alice);
            (bool ok,) = address(engine).call{gas: mid}(call);
            vm.revertToState(snap);
            if (ok) hi = mid;
            else lo = mid;
        }
        vm.prank(alice);
        (bool ok2,) = address(engine).call{gas: hi}(call);
        assertTrue(ok2, "succeeds at the cheapest gas");
        assertEq(pool.buybackCalls(), before + 1, "the buyback report reached the pool even at the cheapest gas that succeeds");
    }

    function test_R20_priceRecoveryClearsOnNextAccrue() public {
        _buy(alice, callD, 16_000e18);
        skip(1);
        guard.setS(address(nvda), 105e18);
        engine.accrue(callD);
        (, bool stress,,) = engine.flags();
        assertTrue(stress);
        skip(1);
        guard.setS(address(nvda), 100e18);
        engine.accrue(callD);
        (, stress,,) = engine.flags();
        assertFalse(stress, "back under budget: buys resume by themselves");
    }
}

/// @dev Measures one accrue call from inside a contract (gas of the CALL only).
contract AccrueProbe {
    function measure(IOptionEngine e, bytes32 id) external returns (uint256 used) {
        uint256 g = gasleft();
        e.accrue(id);
        used = g - gasleft();
    }
}
