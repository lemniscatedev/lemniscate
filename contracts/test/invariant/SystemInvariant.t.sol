// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {console2} from "forge-std/Test.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {MarketConfig, MarketState, ValuationMark} from "../../src/libs/LemniscateTypes.sol";
import {OptionToken} from "../../src/OptionToken.sol";
import {CpmmRouter} from "../mocks/CpmmRouter.sol";
import {MockFeed} from "../mocks/MockFeed.sol";
import {MockStockToken} from "../mocks/MockStockToken.sol";
import {SystemFixture} from "../utils/SystemFixture.sol";
import {SystemHandler} from "./SystemHandler.sol";

/// @notice Stateful invariants of the real LemniscateEngine + WriterPool pair (both behind proxies) under random trading,
/// LP flows, keeper hedging, oracle/regime changes, time, and pool moves. Deep run: `FOUNDRY_PROFILE=deep forge test
/// --match-contract SystemInvariantTest`.
contract SystemInvariantTest is SystemFixture {
    SystemHandler internal handler;
    uint256 internal constant MIN_NORM_FACTOR = 1e12;

    function setUp() public {
        _deploySystem();
        MockFeed[2] memory f = [feeds[0], feeds[1]];
        MockStockToken[2] memory s = [stocks[0], stocks[1]];
        OptionToken[2] memory t = [tokens[0], tokens[1]];
        CpmmRouter[2] memory r = [routers[0], routers[1]];
        handler = new SystemHandler(engine, vault, usdg, hours_, f, s, t, r, usdg.totalSupply());

        // Seed liquidity: three LPs deposit and their locks run out; traders open positions; the keeper hedges.
        for (uint256 i; i < 3; ++i) {
            handler.deposit(i, 2_000_000 * USDG);
        }
        vm.warp(vm.getBlockTimestamp() + 1 days + 1);
        for (uint256 i; i < 2; ++i) {
            feeds[i].setAnswer(i == 0 ? int256(100e8) : int256(250e8));
            handler.buy(i, i, 300_000 * USDG);
            handler.rebalance(i);
            handler.repricePool(i, 0);
        }

        targetContract(address(handler));
        bytes4[] memory selectors = new bytes4[](15);
        selectors[0] = SystemHandler.buy.selector;
        selectors[1] = SystemHandler.sell.selector;
        selectors[2] = SystemHandler.roundTrip.selector;
        selectors[3] = SystemHandler.deposit.selector;
        selectors[4] = SystemHandler.withdraw.selector;
        selectors[5] = SystemHandler.redeem.selector;
        selectors[6] = SystemHandler.transferShares.selector;
        selectors[7] = SystemHandler.rebalance.selector;
        selectors[8] = SystemHandler.setBaseCarry.selector;
        selectors[9] = SystemHandler.accrueAll.selector;
        selectors[10] = SystemHandler.movePrice.selector;
        selectors[11] = SystemHandler.repricePool.selector;
        selectors[12] = SystemHandler.setOpen.selector;
        selectors[13] = SystemHandler.toggleOraclePaused.selector;
        selectors[14] = SystemHandler.warp.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: selectors}));
    }

    /// @notice Protects token accounting: every OptionToken in circulation is a short the vault carries.
    function invariant_powerSupplyEqualsVaultShort() public view {
        for (uint8 i; i < MARKETS; ++i) {
            assertEq(tokens[i].totalSupply(), engine.getState(i).vaultShort, "supply != vaultShort");
        }
    }

    /// @notice Protects NAV from phantom hedges: tracked hedge units are always backed by stock the vault holds.
    function invariant_hedgeUnitsBackedByStock() public view {
        for (uint8 i; i < MARKETS; ++i) {
            assertLe(vault.hedgeUnits(i), stocks[i].balanceOf(address(vault)), "phantom hedge");
        }
    }

    /// @notice Protects solvency accounting: NAV equals cash + hedge value at the regime spot - liability, with the
    /// liability recomputed independently as vaultShort * normFactor * index.
    function invariant_navMatchesIndependentRecomputation() public view {
        (uint256 total, ValuationMark[] memory marks) = engine.valuation();
        int256 gross = int256(usdg.balanceOf(address(vault)) * 1e12);
        uint256 liability;
        for (uint8 i; i < MARKETS; ++i) {
            gross += int256(Math.mulDiv(vault.hedgeUnits(i), marks[i].spot, WAD));
            uint256 price = Math.mulDiv(engine.currentNormFactor(i), engine.index(i), WAD);
            uint256 marketLiability = Math.mulDiv(engine.getState(i).vaultShort, price, WAD);
            assertEq(marketLiability, marks[i].liability, "market liability");
            liability += marketLiability;
        }
        assertEq(liability, total, "total liability");
        assertEq(gross - int256(liability), vault.navView(), "nav");
    }

    /// @notice Protects LP pricing: entries price at or above mid NAV and exits at or below it.
    function invariant_navBandBracketsNav() public view {
        (int256 nav, int256 low, int256 high) = vault.navBand();
        assertLe(low, nav, "navLow > nav");
        assertLe(nav, high, "nav > navHigh");
    }

    /// @notice Protects against value extraction: a buy followed by a sell at the same mark never returns more USDG.
    function invariant_noRoundTripProfit() public view {
        assertEq(handler.ghostRoundTripProfits(), 0, "round trip profited");
    }

    /// @notice Protects existing LPs: another LP's deposit, withdraw, or redeem at a constant mark never lowers NAV per
    /// share beyond virtual-share rounding.
    function invariant_lpOperationsDoNotDiluteSharePrice() public view {
        assertEq(handler.ghostSharePriceDrops(), 0, "share price dropped on LP op");
    }

    /// @notice Protects deposit locks: shares of a locked account never moved (transfer, withdraw, redeem).
    function invariant_lockedSharesNeverMove() public view {
        assertEq(handler.ghostLockedMoves(), 0, "locked shares moved");
    }

    /// @notice Protects USDG conservation: every minted USDG sits with a known holder; the engine and adapters
    /// never retain any.
    function invariant_usdgConserved() public view {
        uint256 sum = usdg.balanceOf(address(vault)) + usdg.balanceOf(TREASURY) + usdg.balanceOf(address(handler))
            + usdg.balanceOf(address(this));
        for (uint256 i; i < 3; ++i) {
            sum += usdg.balanceOf(handler.trader(i)) + usdg.balanceOf(handler.lp(i));
        }
        for (uint256 i; i < MARKETS; ++i) {
            sum += usdg.balanceOf(address(routers[i]));
            assertEq(usdg.balanceOf(address(adapters[i])), 0, "adapter holds USDG");
        }
        assertEq(usdg.balanceOf(address(engine)), 0, "engine holds USDG");
        assertEq(sum, usdg.totalSupply(), "USDG leaked");
        assertEq(usdg.totalSupply(), handler.ghostMinted(), "unexpected mint");
    }

    /// @notice Protects the share ledger: LWP supply is exactly the LPs' balances (no shares minted elsewhere).
    function invariant_writerPoolSupplyMatchesHolders() public view {
        uint256 sum;
        for (uint256 i; i < 3; ++i) {
            sum += vault.balanceOf(handler.lp(i));
        }
        assertEq(sum, vault.totalSupply(), "LWP supply");
    }

    /// @notice Protects carry math: normFactor stays in [MIN_NORM_FACTOR, 1e18] and never increases.
    function invariant_normFactorBoundedAndMonotone() public view {
        for (uint8 i; i < MARKETS; ++i) {
            MarketState memory s = engine.getState(i);
            assertLe(s.normFactor, WAD, "normFactor > 1");
            assertGe(s.normFactor, MIN_NORM_FACTOR, "normFactor < min");
            assertGe(engine.currentNormFactor(i), MIN_NORM_FACTOR, "projected normFactor < min");
            assertLe(engine.currentNormFactor(i), s.normFactor, "projection rises");
        }
        assertEq(handler.ghostNormFactorIncreases(), 0, "stored normFactor rose");
    }

    /// @notice Protects stored risk state: utilization is a fraction and the paused-sell bucket never exceeds its cap.
    function invariant_storedStateBounded() public view {
        for (uint8 i; i < MARKETS; ++i) {
            MarketState memory s = engine.getState(i);
            MarketConfig memory c = engine.getConfig(i);
            assertLe(s.lastUtilBps, 10_000, "util > 100%");
            assertLe(s.pausedSellUsed, c.pausedSellCapPerBlockUsdg, "paused bucket over cap");
        }
    }

    /// @notice Protects against stuck approvals: the vault leaves no allowance on any adapter after a swap.
    function invariant_noDanglingApprovals() public view {
        for (uint256 i; i < MARKETS; ++i) {
            assertEq(usdg.allowance(address(vault), address(adapters[i])), 0, "usdg allowance");
            assertEq(stocks[i].allowance(address(vault), address(adapters[i])), 0, "stock allowance");
            assertEq(usdg.allowance(address(adapters[i]), address(routers[i])), 0, "adapter usdg allowance");
            assertEq(stocks[i].allowance(address(adapters[i]), address(routers[i])), 0, "adapter stock allowance");
        }
    }

    /// @notice Protects against arithmetic bugs: no handler action ever hit a Panic (overflow, div by zero, enum).
    /// Also: the treasury balance never decreases.
    /// No panics, the treasury never loses USDG, and an exact-assets withdraw within maxWithdraw never fails on
    /// a short-filled cash raise.
    function invariant_noPanicsAndTreasuryMonotone() public view {
        assertEq(handler.ghostPanics(), 0, "panic");
        assertEq(handler.ghostTreasuryDecreases(), 0, "treasury decreased");
        assertEq(handler.ghostWithdrawCashShortReverts(), 0, "withdraw reverted on a short cash raise");
    }

    function afterInvariant() external view {
        for (uint256 i; i < handler.revertSelectorCount(); ++i) {
            bytes4 selector = handler.revertSelectors(i);
            console2.log(
                string.concat("REVERT ", vm.toString(abi.encodePacked(selector))), handler.revertCounts(selector)
            );
        }
        console2.log(
            string.concat(
                "STATS roundTrips=",
                vm.toString(handler.ghostRoundTrips()),
                " maxRoundTripGain=",
                vm.toString(handler.ghostMaxRoundTripGain()),
                " sharePriceChecks=",
                vm.toString(handler.ghostSharePriceChecks()),
                " maxSharePriceDrop=",
                vm.toString(handler.ghostMaxSharePriceDrop()),
                " lockedRejections=",
                vm.toString(handler.ghostLockedRejections()),
                " withdrawCashShortReverts=",
                vm.toString(handler.ghostWithdrawCashShortReverts()),
                " liability=",
                vm.toString(engine.totalLiability() / 1e18),
                " supply0=",
                vm.toString(tokens[0].totalSupply() / 1e18),
                " hedge0=",
                vm.toString(vault.hedgeUnits(0) / 1e18)
            )
        );
    }
}
