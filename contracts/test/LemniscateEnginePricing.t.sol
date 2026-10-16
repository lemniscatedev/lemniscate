// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ILemniscateEngine} from "../src/interfaces/ILemniscateEngine.sol";
import {MarketConfig, Regime} from "../src/libs/LemniscateTypes.sol";
import {LemniscateEngineFixture} from "./LemniscateEngine.t.sol";

/// @notice Regression tests for stale-price and paused-sell pricing edges.
contract LemniscateEnginePricingTest is LemniscateEngineFixture {
    /// A market that fell while nobody accrued it must not pay paused sells at the older, higher accrued index.
    function testPausedSellUsesNewerLowerFeedRoundOverStaleAccruedIndex() public {
        uint256 tokens = _buy(20 * USDG);
        assertEq(engine.getState(0).lastGoodPrice, 100e18);

        vm.warp(block.timestamp + 3 hours);
        feed.setAnswer(9_000_000_000); // $90, not yet accrued
        (uint256 fairUsdgOut,,) = engine.quoteSell(0, tokens);
        assertEq(engine.getState(0).lastGoodPrice, 100e18);

        stock.setOraclePaused(true);
        assertEq(uint8(engine.currentRegime(0)), uint8(Regime.PAUSED));
        assertEq(engine.index(0), 90e18 * 90 / 1_000);

        uint256 before = usdg.balanceOf(ALICE);
        vm.prank(ALICE);
        engine.sell(0, tokens, 0, ALICE, block.timestamp + 1 hours);
        uint256 paid = usdg.balanceOf(ALICE) - before;
        // The paused spread (3%) is wider than the open spread, so a paused exit never beats the fair open exit.
        assertLe(paid, fairUsdgOut);
    }

    /// A newer round that is higher than the last good price is ignored while paused (the lower price wins).
    function testPausedMarkIgnoresNewerHigherRound() public {
        _buy(20 * USDG);
        vm.warp(block.timestamp + 1 hours);
        feed.setAnswer(11_000_000_000);
        stock.setOraclePaused(true);
        assertEq(engine.index(0), 100e18 * 100 / 1_000);
    }

    /// A drop of half the spot or more during an issuer pause is treated as a corporate-action transient.
    function testPausedMarkIgnoresCorporateActionSizedDrop() public {
        _buy(20 * USDG);
        vm.warp(block.timestamp + 1 hours);
        feed.setAnswer(5_000_000_000); // $50: e.g. a 2:1 split mid-transition
        stock.setOraclePaused(true);
        assertEq(engine.index(0), 100e18 * 100 / 1_000);
        assertEq(engine.liability(0), engine.getState(0).vaultShort * engine.tokenPrice(0) / WAD);
    }

    /// A round no newer than the last good accrual cannot lower the paused mark.
    function testPausedMarkIgnoresOlderRound() public {
        _buy(20 * USDG);
        feed.setAnswer(9_000_000_000);
        feed.setUpdatedAt(engine.getState(0).lastGoodAt);
        stock.setOraclePaused(true);
        assertEq(engine.index(0), 100e18 * 100 / 1_000);
    }

    /// Off-hours buys close once the held round is older than `offHoursBuyMaxAge`; sells stay open.
    function testOffHoursBuysCloseOnceFeedIsStale() public {
        MarketConfig memory config = _config();
        config.offHoursBuyMaxAge = 1 hours;
        _setConfig(config);
        uint256 tokens = _buy(20 * USDG);

        marketHours.setOpen(false);
        vm.warp(block.timestamp + 30 minutes);
        assertEq(uint8(engine.currentRegime(0)), uint8(Regime.OFF_HOURS));
        _buy(2 * USDG); // fresh enough

        vm.warp(block.timestamp + 31 minutes);
        assertEq(uint8(engine.currentRegime(0)), uint8(Regime.OFF_HOURS));
        vm.expectRevert(ILemniscateEngine.RegimePaused.selector);
        engine.quoteBuy(0, 2 * USDG);
        vm.prank(ALICE);
        vm.expectRevert(ILemniscateEngine.RegimePaused.selector);
        engine.buy(0, 2 * USDG, 0, ALICE, block.timestamp + 1 hours);

        vm.prank(ALICE);
        assertGt(engine.sell(0, tokens, 0, ALICE, block.timestamp + 1 hours), 0);

        // A fresh round re-opens buys; the limit never applies in the open session.
        feed.setAnswer(10_000_000_000);
        _buy(2 * USDG);
        vm.warp(block.timestamp + 2 hours);
        marketHours.setOpen(true);
        _buy(2 * USDG);
    }

    /// The weekend free option: buying Friday's held close before a known gap no longer works once the limit is set.
    function testWeekendHeldCloseCannotBeBoughtBeforeGap() public {
        MarketConfig memory config = _config();
        config.offHoursBuyMaxAge = 1 hours;
        _setConfig(config);
        marketHours.setOpen(false);
        vm.warp(block.timestamp + 30 hours);
        vm.prank(ALICE);
        vm.expectRevert(ILemniscateEngine.RegimePaused.selector);
        engine.buy(0, 20 * USDG, 0, ALICE, block.timestamp + 1 hours);
    }

    /// The paused-sell budget is a leaky bucket: two sells straddling a clock-hour boundary cannot exceed the cap.
    function testPausedSellBudgetCannotBeDoubledAcrossHourBoundary() public {
        vault.setNavWad(int256(1_000 * WAD));
        for (uint256 i; i < 5; ++i) {
            _buy(25 * USDG);
        }
        stock.setOraclePaused(true);
        uint256 hourEnd = (block.timestamp / 1 hours + 1) * 1 hours;
        vm.warp(hourEnd - 1);
        uint256 chunk = token.balanceOf(ALICE) * 45 / 120; // ~45 USDG gross, cap is 50
        vm.prank(ALICE);
        engine.sell(0, chunk, 0, ALICE, type(uint256).max);

        vm.warp(hourEnd);
        vm.prank(ALICE);
        vm.expectRevert(ILemniscateEngine.PausedSellCapExceeded.selector);
        engine.sell(0, chunk, 0, ALICE, type(uint256).max);

        // Half a window later about half the budget has drained back.
        vm.warp(hourEnd + 30 minutes);
        vm.prank(ALICE);
        vm.expectRevert(ILemniscateEngine.PausedSellCapExceeded.selector);
        engine.sell(0, chunk, 0, ALICE, type(uint256).max);
        vm.prank(ALICE);
        engine.sell(0, chunk / 2, 0, ALICE, type(uint256).max);

        // A full window after the last sell the whole budget is available again. (Absolute times: via-IR may cache
        // block.timestamp across warps inside one test.)
        vm.warp(hourEnd + 90 minutes);
        vm.prank(ALICE);
        engine.sell(0, chunk, 0, ALICE, type(uint256).max);
    }

    function testGlobalSettersAreBounded() public {
        vm.expectRevert(ILemniscateEngine.InvalidMarketConfig.selector);
        engine.setGlobal(0, 0, TREASURY, address(0));
        vm.expectRevert(ILemniscateEngine.InvalidMarketConfig.selector);
        engine.setGlobal(999, 0, TREASURY, address(0));
        vm.expectRevert(ILemniscateEngine.InvalidMarketConfig.selector);
        engine.setGlobal(10_001, 0, TREASURY, address(0));
        vm.expectRevert(ILemniscateEngine.InvalidMarketConfig.selector);
        engine.setGlobal(5_000, 5_001, TREASURY, address(0));
        vm.expectRevert(ILemniscateEngine.InvalidMarketConfig.selector);
        engine.setGlobal(5_000, 0, address(0), address(0));
        engine.setGlobal(1_000, 5_000, TREASURY, address(0));
        assertEq(engine.maxGlobalExposureBps(), 1_000);
        assertEq(engine.protocolFeeShareBps(), 5_000);
    }
}
