// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, console2} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {WriterPool} from "../src/WriterPool.sol";
import {LemniscateEngine} from "../src/LemniscateEngine.sol";
import {OptionToken} from "../src/OptionToken.sol";
import {UniswapV3HedgeAdapter} from "../src/UniswapV3HedgeAdapter.sol";
import {IWriterPool} from "../src/interfaces/IWriterPool.sol";
import {IMarketHours} from "../src/interfaces/IMarketHours.sol";
import {ILemniscateEngine} from "../src/interfaces/ILemniscateEngine.sol";
import {ISwapRouter02} from "../src/interfaces/ISwapRouter02.sol";
import {MarketConfig} from "../src/libs/LemniscateTypes.sol";
import {MockFeed} from "./mocks/MockFeed.sol";
import {MockMarketHours} from "./mocks/MockMarketHours.sol";
import {MockStockToken} from "./mocks/MockStockToken.sol";
import {MockUSDG} from "./mocks/MockUSDG.sol";
import {MockPriceReference} from "./mocks/MockPriceReference.sol";
import {CpmmRouter} from "./mocks/CpmmRouter.sol";

/// @dev Unprivileged power-token holder that wraps its own sell in a sandwich of the vault's cash-raise swap.
contract Sandwicher {
    LemniscateEngine public immutable engine;
    CpmmRouter public immutable router;
    IERC20 public immutable usdg;
    IERC20 public immutable stock;
    OptionToken public immutable token;

    constructor(LemniscateEngine e, CpmmRouter r, IERC20 u, IERC20 s, OptionToken t) {
        (engine, router, usdg, stock, token) = (e, r, u, s, t);
        u.approve(address(e), type(uint256).max);
        u.approve(address(r), type(uint256).max);
        s.approve(address(r), type(uint256).max);
    }

    function buyPower(uint256 usdgIn) external {
        engine.buy(0, usdgIn, 0, address(this), block.timestamp);
    }

    function plainSell() external {
        engine.sell(0, token.balanceOf(address(this)), 0, address(this), block.timestamp);
    }

    /// One transaction: push the pool down, trigger the vault's hedge sale through engine.sell, buy the stock back.
    function sandwichSell(uint256 frontRunStock) external {
        router.swap(address(stock), address(usdg), frontRunStock, 0, address(this));
        engine.sell(0, token.balanceOf(address(this)), 0, address(this), block.timestamp);
        router.swapExactOut(address(usdg), address(stock), frontRunStock, address(this));
    }
}

/// @dev LWP holder (lock expired) that self-sandwiches the cash raise its own redeem triggers. No power leg.
contract LpSandwicher {
    WriterPool public immutable vault;
    CpmmRouter public immutable router;
    IERC20 public immutable usdg;
    IERC20 public immutable stock;

    constructor(WriterPool v, CpmmRouter r, IERC20 u, IERC20 s) {
        (vault, router, usdg, stock) = (v, r, u, s);
        u.approve(address(r), type(uint256).max);
        s.approve(address(r), type(uint256).max);
    }

    function honestRedeem(uint256 shares) external {
        vault.redeem(shares, address(this), address(this));
    }

    function sandwichRedeem(uint256 frontRunStock, uint256 shares) external {
        router.swap(address(stock), address(usdg), frontRunStock, 0, address(this));
        vault.redeem(shares, address(this), address(this));
        router.swapExactOut(address(usdg), address(stock), frontRunStock, address(this));
    }
}

/// @notice Forced hedge sales (cash raises) cannot be sandwiched at the LPs' expense.
contract VaultCashRaiseTest is Test {
    uint256 constant USDG = 1e6;
    address constant TREASURY = address(0x5151);
    address alice = makeAddr("alice");

    MockUSDG usdg;
    MockStockToken stock;
    MockFeed feed;
    MockMarketHours hours_;
    WriterPool vault;
    LemniscateEngine engine;
    OptionToken token;
    CpmmRouter router;
    UniswapV3HedgeAdapter adapter;
    Sandwicher attacker;
    MockPriceReference twap;

    function setUp() public {
        vm.warp(1_800_000_000);
        usdg = new MockUSDG();
        stock = new MockStockToken();
        feed = new MockFeed(8, 100e8); // $100
        hours_ = new MockMarketHours();

        WriterPool vaultImpl = new WriterPool();
        LemniscateEngine engineImpl = new LemniscateEngine();
        address predictedEngine = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);
        vault = WriterPool(
            address(
                new ERC1967Proxy(
                    address(vaultImpl),
                    abi.encodeCall(
                        WriterPool.initialize, (address(this), IERC20(address(usdg)), ILemniscateEngine(predictedEngine))
                    )
                )
            )
        );
        engine = LemniscateEngine(
            address(
                new ERC1967Proxy(
                    address(engineImpl),
                    abi.encodeCall(
                        LemniscateEngine.initialize,
                        (
                            address(this),
                            IERC20(address(usdg)),
                            IWriterPool(address(vault)),
                            IMarketHours(address(hours_)),
                            TREASURY
                        )
                    )
                )
            )
        );
        assertEq(address(engine), predictedEngine);

        MarketConfig memory c;
        c.stock = stock;
        c.feed = feed;
        c.scale = 100;
        c.feeBps = 10;
        c.openSpreadBps = 40;
        c.offHoursSpreadBps = 150;
        c.pausedSpreadBps = 300;
        c.openBandBps = 100;
        c.offHoursBandBps = 300;
        c.impactBps = 50;
        c.maxMarketExposureBps = 5_000;
        c.maxTradeUsdg = uint128(10_000_000 * USDG);
        c.minTradeUsdg = uint128(USDG);
        c.pausedSellCapPerBlockUsdg = uint128(10_000_000 * USDG);
        c.offHoursCarryWad = 4e15;
        c.skewCarryWad = 2e15;
        c.maxCarryWad = 5e15;
        c.baseCarryMinWad = 3e15;
        c.baseCarryMaxWad = 5e15;
        c.maxAgeOpen = 26 hours;
        c.maxAgeOffHours = 4 days;
        engine.listMarket(c, "NVDA2", "NVDA2", 4e15);
        token = engine.getConfig(0).token;

        router = new CpmmRouter(address(usdg), address(stock));
        usdg.mint(address(router), 1e12 * USDG);
        stock.mint(address(router), 1e30);
        router.setReserves(100_000_000 * USDG, 1_000_000e18); // $100, deep pool
        adapter = new UniswapV3HedgeAdapter(ISwapRouter02(address(router)));

        // Deployment defaults from initialize(), plus a deposit cap and the route.
        vault.setParams(1 days, 1_000, 10_000, 1_000, 100, uint128(2 * USDG), uint128(100_000_000 * USDG));
        vault.setHedgeRoute(0, adapter, 500);
        vault.setPublicDeposits(true);
        twap = new MockPriceReference();

        // Honest LP.
        usdg.mint(alice, 1_000_000 * USDG);
        vm.startPrank(alice);
        usdg.approve(address(vault), type(uint256).max);
        vault.deposit(1_000_000 * USDG, alice);
        vm.stopPrank();

        // Attacker opens a large power position (unprivileged, public engine.buy).
        attacker = new Sandwicher(engine, router, IERC20(address(usdg)), IERC20(address(stock)), token);
        usdg.mint(address(attacker), 450_000 * USDG);
        attacker.buyPower(450_000 * USDG);

        // Keeper hedges; arbitrage returns the pool to the oracle price.
        vault.rebalance(0);
        router.setReserves(100_000_000 * USDG, 1_000_000e18);

        // Underlying rallies 20%; pool follows; keeper re-hedges. Vault cash is now below the power book.
        feed.setAnswer(120e8);
        router.setReserves(120_000_000 * USDG, 1_000_000e18);
        vault.rebalance(0);
        router.setReserves(120_000_000 * USDG, 1_000_000e18);

        // Attacker stock inventory used only as sandwich working capital (returned in full).
        stock.mint(address(attacker), 50_000e18);
    }

    function _attackerUsdg() private view returns (uint256) {
        return usdg.balanceOf(address(attacker));
    }

    function testOpenMarketSandwichLosesAndLpsLoseNothing() public {
        assertLt(usdg.balanceOf(address(vault)), engine.liability(0) / 1e12, "vault cash below power book");
        uint256 stockBefore = stock.balanceOf(address(attacker));

        // A: honest sell.
        uint256 snap = vm.snapshotState();
        attacker.plainSell();
        uint256 honestUsdg = _attackerUsdg();
        int256 honestNav = vault.navView();
        vm.revertToState(snap);

        // B: same sell, sandwiched in one transaction. Largest front-run the vault's minOut still accepts.
        uint256 lo;
        uint256 hi = 50_000e18;
        while (hi - lo > 1e18) {
            uint256 mid = (lo + hi) / 2;
            uint256 s = vm.snapshotState();
            try attacker.sandwichSell(mid) {
                lo = mid;
            } catch {
                hi = mid;
            }
            vm.revertToState(s);
        }
        attacker.sandwichSell(lo);
        uint256 sandwichUsdg = _attackerUsdg();
        int256 sandwichNav = vault.navView();

        assertEq(stock.balanceOf(address(attacker)), stockBefore, "stock inventory fully restored");
        console2.log("front-run stock units", lo / 1e18);
        // Without any TWAP: the execution shortfall is charged to the seller, so the sandwich nets a loss.
        assertLe(sandwichUsdg, honestUsdg, "sandwich must not beat an honest sell");
        assertGe(sandwichNav, honestNav, "remaining LPs must not lose");
    }

    /// Accepted (SECURITY.md): LP exits are gated by power-book utilization with no deleveraging path; after the
    /// rally the honest LP (lock long expired) cannot withdraw while the power position stays open.
    function testLpExitsAreGatedByPowerBookUtilization() public {
        vm.warp(block.timestamp + 2 days);
        feed.setAnswer(120e8);
        assertEq(vault.unlockTime(alice) < block.timestamp, true);
        assertGt(vault.navView(), 0);
        assertEq(vault.maxWithdraw(alice), 0);
        assertEq(vault.maxRedeem(alice), 0);
        vm.prank(alice);
        vm.expectRevert();
        vault.redeem(1e12, alice, alice);
    }

    struct LpRun {
        uint256 shares;
        uint256 holdPool;
        uint256 honestOut;
        uint256 sandOut;
        uint256 bobOracleHonest;
        uint256 bobOracleSand;
        uint256 bobPoolHonest;
        uint256 bobPoolSand;
        uint256 frontRun;
        uint256 unitsSold;
    }

    address bob = makeAddr("bob");

    /// Off-hours keeper-lag state: power book exited in the open session, vault still holds the hedge, Bob's fresh
    /// deposit is the only cash. Feed holds $120 close (OFF_HOURS), pool reprices. Alice (lock expired) redeems.
    function _offHoursLpState(uint256 poolUsdg, uint256 poolPrice) private returns (LpSandwicher lp) {
        attacker.plainSell(); // power holder exits honestly at $120 in the open market; liability -> 0
        router.setReserves(120_000_000 * USDG, 1_000_000e18);
        usdg.mint(bob, 200_000 * USDG);
        vm.startPrank(bob);
        usdg.approve(address(vault), type(uint256).max);
        vault.deposit(200_000 * USDG, bob);
        vm.stopPrank();
        feed.setAnswer(120e8); // Friday close
        hours_.setOpen(false);
        vm.warp(block.timestamp + 1 days + 1 hours);
        router.setReserves(poolUsdg, poolUsdg * 1e12 / poolPrice);
        // The pool has sat at the new level for the whole window, so its TWAP is there too.
        vault.setPriceReference(twap);
        twap.setPrice(poolPrice * 1e18);
        lp = new LpSandwicher(vault, router, IERC20(address(usdg)), IERC20(address(stock)));
        uint256 aliceShares = vault.balanceOf(alice);
        vm.prank(alice);
        vault.transfer(address(lp), aliceShares); // alice unlocked: no lock propagates
        stock.mint(address(lp), 50_000e18); // working capital, restored in full
    }

    function _poolNav() private view returns (uint256) {
        uint256 units = vault.hedgeUnits(0);
        return usdg.balanceOf(address(vault)) + units * router.rA() / router.rB() - engine.liability(0) / 1e12;
    }

    function _runLp(uint256 poolUsdg) private returns (LpRun memory r) {
        LpSandwicher lp = _offHoursLpState(poolUsdg, 132);
        assertEq(engine.liability(0), 0);
        uint256 target = vault.previewWithdraw(500_000 * USDG);
        r.shares = target < vault.maxRedeem(address(lp)) ? target : vault.maxRedeem(address(lp));
        assertGt(vault.previewRedeem(r.shares), usdg.balanceOf(address(vault)), "redeem needs a cash raise");
        r.holdPool = _poolNav() * r.shares / vault.totalSupply();
        console2.log("  Bob value @pool if Alice holds", _poolNav() * vault.balanceOf(bob) / vault.totalSupply() / USDG);
        console2.log("  Bob value @oracle if Alice holds", vault.convertToAssets(vault.balanceOf(bob)) / USDG);
        uint256 unitsBefore = vault.hedgeUnits(0);
        uint256 stockBefore = stock.balanceOf(address(lp));

        uint256 snap = vm.snapshotState();
        lp.honestRedeem(r.shares);
        r.honestOut = usdg.balanceOf(address(lp));
        r.bobOracleHonest = vault.convertToAssets(vault.balanceOf(bob));
        r.bobPoolHonest = _poolNav() * vault.balanceOf(bob) / vault.totalSupply();
        r.unitsSold = unitsBefore - vault.hedgeUnits(0);
        vm.revertToState(snap);

        uint256 lo;
        uint256 hi = 50_000e18;
        while (hi - lo > 1e18) {
            uint256 mid = (lo + hi) / 2;
            uint256 s = vm.snapshotState();
            try lp.sandwichRedeem(mid, r.shares) {
                lo = mid;
            } catch {
                hi = mid;
            }
            vm.revertToState(s);
        }
        lp.sandwichRedeem(lo, r.shares);
        r.frontRun = lo;
        assertEq(stock.balanceOf(address(lp)), stockBefore, "stock restored");
        r.sandOut = usdg.balanceOf(address(lp));
        r.bobOracleSand = vault.convertToAssets(vault.balanceOf(bob));
        r.bobPoolSand = _poolNav() * vault.balanceOf(bob) / vault.totalSupply();
    }

    function _assertLpRunBounded(LpRun memory r) private pure {
        assertLe(r.sandOut, r.honestOut, "sandwiched redeem must not beat an honest redeem");
        assertGe(r.bobOracleSand, r.bobOracleHonest, "remaining LP must not lose");
    }

    function _log(string memory tag, LpRun memory r) private pure {
        console2.log(tag);
        console2.log("  hedge units sold by vault", r.unitsSold / 1e18);
        console2.log("  front-run units", r.frontRun / 1e18);
        console2.log("  LP: hold value @pool", r.holdPool / USDG);
        console2.log("  LP: honest redeem USDG", r.honestOut / USDG);
        console2.log("  LP: sandwich redeem USDG", r.sandOut / USDG);
        console2.logInt(int256(r.bobOracleHonest) - int256(r.bobOracleSand));
        console2.logInt(int256(r.bobPoolHonest) - int256(r.bobPoolSand));
        console2.log("  Bob value @pool honest", r.bobPoolHonest / USDG);
        console2.log("  Bob value @pool sandwich", r.bobPoolSand / USDG);
    }

    function testOffHoursLpRedeemSandwichWithTwapFloor() public {
        LpRun memory r = _runLp(132_000_000 * USDG); // ~$264M TVL pool
        _log("deep pool ($264M TVL, 5 bps)", r);
        _assertLpRunBounded(r);

    }

    /// In a thin pool the TWAP floor turns an oversized forced sale into a revert instead of a dump below the
    /// reference price; a smaller exit still fills.
    function testOffHoursLargeRedeemInThinPoolRevertsInsteadOfDumping() public {
        LpSandwicher lp = _offHoursLpState(10_000_000 * USDG, 132); // ~$20M TVL pool
        uint256 target = vault.previewWithdraw(500_000 * USDG);
        uint256 shares = target < vault.maxRedeem(address(lp)) ? target : vault.maxRedeem(address(lp));
        vm.expectRevert(IWriterPool.InsufficientLiquidity.selector);
        lp.honestRedeem(shares);

        uint256 navPerShareBefore = vault.navPerShareWad();
        lp.honestRedeem(vault.previewWithdraw(250_000 * USDG));
        assertGe(vault.navPerShareWad(), navPerShareBefore, "remaining LPs must not lose");
    }

    /// Accepted (SECURITY.md, L-06): with cash short and the pool more than the slippage allowance below the held
    /// close, an off-hours redeem reverts even though maxRedeem advertises it.
    function testOffHoursRedeemRevertsWhenPoolIsBelowHeldClose() public {
        LpSandwicher lp = _offHoursLpState(110_000_000 * USDG, 110);
        uint256 target = vault.previewWithdraw(500_000 * USDG);
        uint256 shares = target < vault.maxRedeem(address(lp)) ? target : vault.maxRedeem(address(lp));
        assertGt(shares, 0, "maxRedeem still advertises the exit");
        vm.expectRevert(IWriterPool.InsufficientLiquidity.selector);
        lp.honestRedeem(shares);
    }

    function testOffHoursSandwichWithTwapFloorIsBoundedBySlippage() public {
        vault.setPriceReference(twap);
        twap.setPrice(132e18); // the pool's pre-attack level: one transaction cannot move a TWAP
        // Weekend: feed holds Friday's $120 close (OFF_HOURS regime, 4-day max age); the 24/7 pool reprices to
        // $132 on news. The vault's cash-raise minOut is anchored to the held close.
        hours_.setOpen(false);
        vm.warp(block.timestamp + 1 days);
        router.setReserves(132_000_000 * USDG, 1_000_000e18);
        uint256 stockBefore = stock.balanceOf(address(attacker));

        uint256 snap = vm.snapshotState();
        attacker.plainSell();
        uint256 honestUsdg = _attackerUsdg();
        int256 honestNav = vault.navView();
        vm.revertToState(snap);

        uint256 lo;
        uint256 hi = 50_000e18;
        while (hi - lo > 1e18) {
            uint256 mid = (lo + hi) / 2;
            uint256 s = vm.snapshotState();
            try attacker.sandwichSell(mid) {
                lo = mid;
            } catch {
                hi = mid;
            }
            vm.revertToState(s);
        }
        attacker.sandwichSell(lo);
        assertEq(stock.balanceOf(address(attacker)), stockBefore);
        int256 profit = int256(_attackerUsdg()) - int256(honestUsdg);
        int256 lpLoss = (honestNav - vault.navView()) / 1e12;
        console2.log("off-hours with TWAP floor: attacker extra / LP loss vs honest (USDG wei)");
        console2.logInt(profit);
        console2.logInt(lpLoss);
        assertLe(profit, 0, "sandwich must not beat an honest sell");
        assertLe(lpLoss, 0, "remaining LPs must not lose");
    }

    function testRevertingPriceReferenceFallsBackToOracle() public {
        vault.setPriceReference(twap);
        twap.setReverts(true);
        attacker.plainSell();
        assertEq(token.balanceOf(address(attacker)), 0);
    }

    function testPriceReferenceIsAdminOnlyAndMustBeAContract() public {
        vm.expectRevert(IWriterPool.InvalidParams.selector);
        vault.setPriceReference(MockPriceReference(address(0xBEEF)));
        vm.prank(alice);
        vm.expectRevert();
        vault.setPriceReference(twap);
        vault.setPriceReference(MockPriceReference(address(0)));
        assertEq(address(vault.priceReference()), address(0));
    }
}
