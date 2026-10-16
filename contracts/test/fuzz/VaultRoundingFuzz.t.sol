// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {SystemFixture} from "../utils/SystemFixture.sol";

/// @notice Fuzz properties of WriterPool share/asset conversion against the real engine: whatever state the book is in,
/// entering and leaving at the same mark never profits, and previews round in the vault's favour.
contract VaultRoundingFuzzTest is SystemFixture {
    address internal lp1 = makeAddr("lp1");
    address internal lp2 = makeAddr("lp2");
    address internal trader = makeAddr("trader");

    function setUp() public {
        _deploySystem();
        // No lock, so an entry and exit can share one block (and one mark).
        vault.setParams(0, 1_000, 10_000, 1_000, 100, uint128(2 * USDG), uint128(1_000_000_000 * USDG));
        address[3] memory who = [lp1, lp2, trader];
        for (uint256 i; i < 3; ++i) {
            usdg.mint(who[i], 100_000_000 * USDG);
            vm.startPrank(who[i]);
            usdg.approve(address(vault), type(uint256).max);
            usdg.approve(address(engine), type(uint256).max);
            vm.stopPrank();
        }
    }

    /// Builds an arbitrary book: LP capital, an open power position (maybe hedged), a price move, and elapsed carry.
    function _scenario(uint256 seedDeposit, uint256 seedBuy, int256 moveBps, uint256 elapsed, bool hedge) internal {
        vm.prank(lp1);
        vault.deposit(bound(seedDeposit, 1_000 * USDG, 20_000_000 * USDG), lp1);
        uint256 buyIn = bound(seedBuy, 0, 2_000_000 * USDG);
        if (buyIn >= USDG) {
            vm.prank(trader);
            try engine.buy(0, buyIn, 0, trader, type(uint256).max) {} catch {}
        }
        if (hedge) {
            vm.prank(KEEPER);
            try vault.rebalance(0) {} catch {}
        }
        uint256 t = vm.getBlockTimestamp() + bound(elapsed, 0, 3 days);
        vm.warp(t);
        (, int256 answer,,,) = feeds[0].latestRoundData();
        feeds[0].setAnswer(answer * (10_000 + bound(moveBps, -2_000, 2_000)) / 10_000);
        feeds[1].setAnswer(250e8);
        _arbPool(0, 0);
    }

    /// @notice Deposit then immediately redeem every share (same block, same mark) never returns more than deposited.
    function testFuzz_depositRedeemRoundTripNeverProfits(
        uint256 seedDeposit,
        uint256 seedBuy,
        int256 moveBps,
        uint256 elapsed,
        bool hedge,
        uint256 amount
    ) public {
        _scenario(seedDeposit, seedBuy, moveBps, elapsed, hedge);
        amount = bound(amount, 1, 5_000_000 * USDG);
        vm.assume(vault.maxDeposit(lp2) >= amount && vault.previewDeposit(amount) > 0);
        uint256 before = usdg.balanceOf(lp2);
        vm.startPrank(lp2);
        uint256 shares = vault.deposit(amount, lp2);
        uint256 redeemable = vault.maxRedeem(lp2);
        uint256 toRedeem = shares < redeemable ? shares : redeemable;
        if (toRedeem != 0) vault.redeem(toRedeem, lp2, lp2);
        vm.stopPrank();
        uint256 got = usdg.balanceOf(lp2) + amount - before; // USDG received back
        // Pro rata: assets out per share redeemed never exceed assets in per share minted.
        assertLe(got * shares, amount * toRedeem, "deposit->redeem profit");
    }

    /// @notice Mint then withdraw the same assets: the shares burned are at least the shares minted for them.
    function testFuzz_mintWithdrawRoundTripNeverProfits(
        uint256 seedDeposit,
        uint256 seedBuy,
        int256 moveBps,
        uint256 elapsed,
        uint256 shares
    ) public {
        _scenario(seedDeposit, seedBuy, moveBps, elapsed, false);
        shares = bound(shares, 1e6, 5_000_000 * 1e12);
        vm.assume(vault.maxMint(lp2) >= shares);
        vm.startPrank(lp2);
        uint256 paid = vault.mint(shares, lp2);
        uint256 maxW = vault.maxWithdraw(lp2);
        vm.assume(maxW != 0);
        uint256 out = paid < maxW ? paid : maxW;
        uint256 burned = vault.withdraw(out, lp2, lp2);
        vm.stopPrank();
        // Shares burned per asset withdrawn are at least shares minted per asset paid.
        assertGe(burned * paid, shares * out, "mint->withdraw profit");
    }

    /// @notice Previews round in the vault's favour at any book state: entry quotes at navHigh and exit at navLow, so
    /// assets->shares->assets never grows, and the exact-assets/exact-shares pairs bracket each other.
    function testFuzz_previewsRoundTowardVault(
        uint256 seedDeposit,
        uint256 seedBuy,
        int256 moveBps,
        uint256 elapsed,
        bool hedge,
        uint256 assets
    ) public {
        _scenario(seedDeposit, seedBuy, moveBps, elapsed, hedge);
        (int256 nav,,) = vault.navBand();
        vm.assume(nav > 0);
        assets = bound(assets, 1, 10_000_000 * USDG);
        uint256 sharesIn = vault.previewDeposit(assets);
        assertLe(vault.previewRedeem(sharesIn), assets, "redeem(deposit(a)) > a");
        assertGe(vault.previewMint(sharesIn), vault.previewRedeem(sharesIn), "mint cheaper than redeem");
        assertGe(vault.previewWithdraw(assets), sharesIn, "withdraw burns fewer shares than deposit mints");
        // convertTo* use mid NAV and sit between the guarded previews.
        assertLe(vault.convertToShares(assets), vault.previewWithdraw(assets) + 1);
        assertGe(vault.convertToShares(assets) + 1, sharesIn);
    }

    /// @notice A third party's deposit, then its redeem, at the same mark never lowers an existing LP's share value.
    function testFuzz_otherLpFlowsDoNotDilute(
        uint256 seedDeposit,
        uint256 seedBuy,
        int256 moveBps,
        uint256 elapsed,
        uint256 amount
    ) public {
        _scenario(seedDeposit, seedBuy, moveBps, elapsed, true);
        (int256 nav,,) = vault.navBand();
        vm.assume(nav > 0);
        amount = bound(amount, USDG, 5_000_000 * USDG);
        vm.assume(vault.maxDeposit(lp2) >= amount && vault.previewDeposit(amount) > 0);
        uint256 lp1Value = vault.convertToAssets(vault.balanceOf(lp1));
        uint256 pps = vault.navPerShareWad();
        vm.startPrank(lp2);
        uint256 shares = vault.deposit(amount, lp2);
        assertGe(vault.navPerShareWad() + 1 + pps / 1e12, pps, "deposit diluted");
        uint256 redeemable = vault.maxRedeem(lp2);
        if (redeemable != 0) vault.redeem(shares < redeemable ? shares : redeemable, lp2, lp2);
        vm.stopPrank();
        assertGe(vault.navPerShareWad() + 1 + pps / 1e12, pps, "exit diluted");
        assertGe(vault.convertToAssets(vault.balanceOf(lp1)) + 1, lp1Value, "existing LP lost value");
    }
}
