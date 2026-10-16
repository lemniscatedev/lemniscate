// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SystemFixture} from "./SystemFixture.sol";
import {IOptionEngine} from "../../src/interfaces/IOptionEngine.sol";
import {ISeriesRegistry} from "../../src/interfaces/ISeriesRegistry.sol";
import {Series} from "../../src/libs/OptionTypes.sol";

/// @dev Measures one call in its own frame (the caller's gas before and after).
contract SystemProbe {
    function nav(IOptionEngine, address pool) external view returns (uint256 used, int256 n) {
        uint256 g = gasleft();
        (bool ok, bytes memory ret) = pool.staticcall(abi.encodeWithSignature("nav()"));
        used = g - gasleft();
        require(ok, "nav");
        n = abi.decode(ret, (int256));
    }

    function liability(IOptionEngine e) external view returns (uint256 used, uint256 l) {
        uint256 g = gasleft();
        l = e.totalLiability();
        used = g - gasleft();
    }
}

/// @notice Todo 07b R1 (bookValueEverywhere), R2 (onlyLiveSeriesCost), R3 (seriesEpochs, end to end) and R5 (gasTable)
/// on the real system (SystemFixture). Gas tests run isolated (each top-level call its own transaction: cold storage
/// as on chain). Run `forge test --match-contract SystemGasTest -vv` for the table.
contract SystemGasTest is SystemFixture {
    SystemProbe internal probe;

    function setUp() public {
        _deploySystem(4, 10_000_000e6);
        probe = new SystemProbe();
    }

    /// @dev `perStock` series per name around the money (strikes 75%..125% of S, alternating Up/Down and Daily/Weekly),
    /// each bought with `units` by alice. Returns every id.
    function _book(uint256 perStock, uint256 units) internal returns (bytes32[] memory ids) {
        ids = new bytes32[](stocks.length * perStock);
        uint256 n;
        for (uint256 i; i < stocks.length; ++i) {
            for (uint256 j; j < perStock; ++j) {
                bytes32 id = _list(i, j % 2 == 0, _strike(i, j, perStock), j % 4 < 2 ? DAILY : WEEKLY);
                if (units != 0) _buy(alice, id, units);
                ids[n++] = id;
            }
        }
    }

    function _strike(uint256 i, uint256 j, uint256 perStock) internal view returns (uint128) {
        return uint128(px[i] * (7_500 + j * 5_000 / perStock) / 10_000);
    }

    /// @dev A fresh feed round on every name and new vol posts (the keeper and vol-engine keep both fresh).
    function _refresh() internal {
        for (uint256 i; i < stocks.length; ++i) {
            _setPrice(i, px[i]);
        }
        _refreshVols();
    }

    // ------------------------------------------------------------------------------------------------- R1

    /// forge-config: default.isolate = true
    function test_R1_sellGasWith200ListedSeries() public {
        bytes32[] memory ids = _book(50, 2e18); // 200 live series over 4 names
        skip(30 minutes);
        _refresh();
        uint256 tokens = _token(ids[7]).balanceOf(alice) / 2;
        _sell(alice, ids[7], tokens);
        uint256 sellGas = vm.lastCallGas().gasTotalUsed;
        emit log_named_uint("sell gas, 200 listed series, real pool", sellGas);
        assertLt(sellGas, 1_200_000, "sell < 1.2M gas with 200 listed series");
    }

    /// forge-config: default.isolate = true
    function test_R1_navGasWith1000Series() public {
        _book(250, 1e18); // 1,000 live series over 4 names
        skip(10 minutes);
        _refresh();
        (uint256 navGas, int256 n) = probe.nav(engine, address(pool));
        emit log_named_uint("pool.nav() gas, 1,000 live series", navGas);
        assertGt(n, 0);
        assertLt(navGas, 2_000_000, "NAV < 2M gas with 1,000 series");

        // The other pool paths read the same O(1) book value.
        _deposit(makeAddr("lp2"), 50_000e6);
        uint256 depositGas = vm.lastCallGas().gasTotalUsed;
        emit log_named_uint("pool.deposit gas, 1,000 live series", depositGas);
        assertLt(depositGas, 2_000_000);
    }

    /// bookValue == totalLiability right after the keeper accrues every live series (same block, same prices).
    function test_R1_bookValueEqualsTotalLiabilityAfterAccrueAll() public {
        _book(20, 3e18);
        skip(40 minutes);
        for (uint256 i; i < stocks.length; ++i) {
            _setPrice(i, px[i] * (i % 2 == 0 ? 103 : 98) / 100);
        }
        _refreshVols();
        uint256 before = engine.bookValue();
        uint256 exact = engine.totalLiability();
        assertTrue(before != exact, "stale between accruals");
        _accrueAll();
        assertApproxEqAbs(engine.bookValue(), engine.totalLiability(), 100, "equal after accrueMany of all series");
    }

    // ------------------------------------------------------------------------------------------------- R2

    /// Listing growth (about 100 new series a day) must not make any user path O(series ever listed): 1,000 extra
    /// listed, then archived, zero-supply series (Weekly Downs included, the shield list) change no path's gas by
    /// more than a few percent. accrueMany skips empty series for about one cold SLOAD each.
    /// forge-config: default.isolate = true
    function test_R2_onlyLiveSeriesCost() public {
        bytes32[] memory ids = _book(10, 2e18); // 40 live series
        bytes32 shieldId = _list(0, false, uint128(px[0] * 89 / 100), WEEKLY);
        uint256[5] memory before = _measure(ids, 0);

        // 1,000 more series listed and archived, never bought (Weekly Downs below the shield strike among them).
        bytes32[] memory dead = new bytes32[](1_000);
        vm.startPrank(keeper);
        for (uint256 j; j < 1_000; ++j) {
            uint256 i = j % stocks.length;
            dead[j] = registry.listSeries(
                address(stocks[i]), j % 3 == 0, uint128(px[i] * (5_000 + j) / 10_000 + 1), j % 2 == 0 ? WEEKLY : DAILY
            );
            registry.archive(dead[j]);
        }
        vm.stopPrank();
        engine.syncSeries(2_000); // the engine has seen them all (the worst case for its lists)
        assertGt(engine.shieldList(address(stocks[0])).length, 100, "shield list grew");
        engine.pruneShieldList(address(stocks[0]), 1_000);
        bytes32[] memory left = engine.shieldList(address(stocks[0]));
        assertEq(left.length, 3, "the two booked Weekly Downs and the shield strike are left");
        for (uint256 k; k < left.length; ++k) {
            assertFalse(registry.seriesOf(left[k]).archived, "no archived entry left");
        }
        assertEq(registry.seriesOf(shieldId).buyable, true);

        uint256[5] memory afterGrowth = _measure(ids, 1);
        string[5] memory names = ["buy", "sell", "accrueMany(live)", "totalLiability", "shield"];
        for (uint256 k; k < 5; ++k) {
            emit log_named_uint(string.concat(names[k], " gas before growth"), before[k]);
            emit log_named_uint(string.concat(names[k], " gas after 1,000 dead series"), afterGrowth[k]);
            assertLt(afterGrowth[k], before[k] * 105 / 100, names[k]);
        }

        // accrueMany over the dead ids themselves: about one SLOAD each.
        engine.accrueMany(dead);
        uint256 deadGas = vm.lastCallGas().gasTotalUsed;
        emit log_named_uint("accrueMany(1,000 dead series) gas", deadGas);
        assertLt(deadGas, 5_000 * 1_000, "< 5k gas per empty series");
    }

    function _measure(bytes32[] memory ids, uint256 round) internal returns (uint256[5] memory g) {
        skip(20 minutes);
        _refresh();
        _buy(alice, ids[1 + round], 1e18);
        g[0] = vm.lastCallGas().gasTotalUsed;
        _sell(alice, ids[5 + round], 1e17);
        g[1] = vm.lastCallGas().gasTotalUsed;
        skip(10 minutes);
        engine.accrueMany(_liveIds());
        g[2] = vm.lastCallGas().gasTotalUsed;
        (g[3],) = probe.liability(engine);
        address stock = address(stocks[0]);
        IERC20 st = IERC20(stock);
        if (st.balanceOf(alice) == 0) {
            vm.prank(address(router));
            st.transfer(alice, 10e18);
        }
        vm.prank(alice);
        engine.shield(stock, 1e18, 1_000, type(uint128).max, uint64(vm.getBlockTimestamp()));
        g[4] = vm.lastCallGas().gasTotalUsed;
    }

    // ------------------------------------------------------------------------------------------------- R3

    /// A Daily strike decays below the relist threshold; the keeper lists epoch 1 (fresh norm, buyable after
    /// setBuyable), epoch 0 is archived and its holder can still sell it.
    function test_R3_seriesEpochsEndToEnd() public {
        bytes32 e0 = _list(0, true, uint128(px[0]), DAILY);
        (, uint256 tokens) = _buy(alice, e0, 100e18);
        uint256 days_;
        while (registry.seriesOf(e0).norm >= registry.relistNormThreshold()) {
            skip(1 days);
            _refresh();
            engine.accrue(e0);
            require(++days_ < 60, "norm never decayed");
        }
        emit log_named_uint("days for an ATM Daily to reach norm < 0.001", days_);

        vm.prank(keeper);
        bytes32 e1 = registry.listSeries(address(stocks[0]), true, uint128(px[0]), DAILY);
        assertEq(registry.epochOf(e1), 1);
        assertEq(registry.idOf(address(stocks[0]), true, uint128(px[0]), DAILY), e1);
        Series memory old = registry.seriesOf(e0);
        assertTrue(old.archived && !old.buyable);

        // Old epoch: no buys, sells forever.
        vm.expectRevert(abi.encodeWithSelector(IOptionEngine.SeriesNotBuyable.selector, e0));
        _buy(alice, e0, 1e18);
        uint256 proceeds = _sell(alice, e0, tokens);
        assertGt(proceeds, 0, "old epoch sells");
        assertEq(_token(e0).totalSupply(), 0);
        assertEq(engine.liveSeries(address(stocks[0])).length, 0, "empty old epoch left the live list");

        // New epoch: fresh norm, buyable once the keeper turns it on.
        vm.prank(keeper);
        registry.setBuyable(e1, true);
        (, uint256 t1) = _buy(alice, e1, 1e18);
        assertEq(t1, 1e18, "norm 1: one token per unit");
    }

    // ------------------------------------------------------------------------------------------------- R5

    /// The gas table (200 live series over 4 names, real pool with reserve and fee router, isolated calls).
    /// forge-config: default.isolate = true
    function test_R5_gasTable() public {
        bytes32[] memory ids = _book(50, 2e18);
        skip(25 hours); // LP lock over
        _refresh();

        _buy(alice, ids[9], 3e18);
        uint256 buyGas = vm.lastCallGas().gasTotalUsed;
        skip(5 minutes);
        _refresh();
        _sell(alice, ids[9], 1e18);
        uint256 sellGas = vm.lastCallGas().gasTotalUsed;

        skip(30 minutes);
        _refresh();
        bytes32[] memory fifty = new bytes32[](50);
        for (uint256 i; i < 50; ++i) {
            fifty[i] = ids[i * 4];
        }
        engine.accrueMany(fifty);
        uint256 manyGas = vm.lastCallGas().gasTotalUsed;

        address lp2 = makeAddr("lp2");
        _deposit(lp2, 100_000e6);
        uint256 depositGas = vm.lastCallGas().gasTotalUsed;

        vm.prank(hedger);
        pool.rebalance(address(stocks[0]), 100e18, 0);
        uint256 rebalanceGas = vm.lastCallGas().gasTotalUsed;

        uint256 shares = pool.balanceOf(lp);
        vm.prank(lp);
        uint256 ticket = pool.requestWithdraw(shares / 100);
        skip(72 hours);
        _refresh();
        pool.claim(ticket);
        uint256 claimGas = vm.lastCallGas().gasTotalUsed;
        (uint256 navGas,) = probe.nav(engine, address(pool));
        (uint256 liabGas,) = probe.liability(engine);

        emit log_named_uint("buy", buyGas);
        emit log_named_uint("sell", sellGas);
        emit log_named_uint("accrueMany(50)", manyGas);
        emit log_named_uint("deposit", depositGas);
        emit log_named_uint("claim", claimGas);
        emit log_named_uint("rebalance (buy 100 units)", rebalanceGas);
        emit log_named_uint("pool.nav() view", navGas);
        emit log_named_uint("totalLiability() view, 200 series (monitoring)", liabGas);
        assertLt(buyGas, 3_000_000);
        assertLt(sellGas, 1_200_000);
        assertLt(manyGas, 20_000_000);
        assertLt(depositGas, 1_000_000);
        assertLt(claimGas, 1_000_000);
        assertLt(rebalanceGas, 1_000_000);
        assertLt(navGas, 500_000);
    }
}
