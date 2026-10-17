// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {PoolFixture} from "./PoolFixture.sol";
import {WriterPool} from "../../src/WriterPool.sol";
import {FeeRouter} from "../../src/FeeRouter.sol";
import {Reserve} from "../../src/Reserve.sol";
import {UniswapV3HedgeAdapter} from "../../src/UniswapV3HedgeAdapter.sol";
import {MockUSDG} from "../mocks/MockUSDG.sol";
import {MockStockToken} from "../mocks/MockStockToken.sol";
import {MockSwapRouter} from "../mocks/MockSwapRouter.sol";
import {MockPoolEngine, MockPoolPriceGuard} from "./PoolMocks.sol";
import {SessionKind} from "../../src/libs/OptionTypes.sol";

/// @dev Drives LPs, the engine (buys, sells, accruals), the hedger and the fee router at random. Every legitimate
/// revert is swallowed; the invariants below must hold after every call.
contract PoolHandler is Test {
    uint256 internal constant USDG = 1e6;

    WriterPool public pool;
    MockUSDG public usdg;
    MockStockToken public stock;
    MockPoolEngine public engine;
    MockPoolPriceGuard public guard;
    MockSwapRouter public swapRouter;
    FeeRouter public fees;
    address public hedger;

    address[] public actors;
    uint256[] public tickets;
    uint256 public minted; // all USDG ever minted (to anyone)
    mapping(bytes32 action => uint256) public ok; // successful calls, to check the run is not all reverts

    constructor(
        WriterPool pool_,
        MockUSDG usdg_,
        MockStockToken stock_,
        MockPoolEngine engine_,
        MockPoolPriceGuard guard_,
        MockSwapRouter router_,
        FeeRouter fees_,
        address hedger_,
        address[] memory actors_,
        uint256 alreadyMinted
    ) {
        pool = pool_;
        usdg = usdg_;
        stock = stock_;
        engine = engine_;
        guard = guard_;
        swapRouter = router_;
        fees = fees_;
        hedger = hedger_;
        actors = actors_;
        minted = alreadyMinted;
    }

    function actorCount() external view returns (uint256) {
        return actors.length;
    }

    function ticketCount() external view returns (uint256) {
        return tickets.length;
    }

    function _mint(address to, uint256 amount) private {
        usdg.mint(to, amount);
        minted += amount;
    }

    function deposit(uint256 who, uint256 amount) external {
        address a = actors[who % actors.length];
        amount = bound(amount, 1 * USDG, 200_000 * USDG);
        _mint(a, amount);
        vm.startPrank(a);
        usdg.approve(address(pool), amount);
        try pool.deposit(amount, a) {
            ++ok["deposit"];
        } catch {}
        usdg.approve(address(pool), 0);
        vm.stopPrank();
    }

    function request(uint256 who, uint256 frac) external {
        address a = actors[who % actors.length];
        uint256 bal = pool.balanceOf(a);
        uint256 shares = bal * bound(frac, 1, 100) / 100;
        if (shares == 0) return;
        if (pool.unlockTime(a) > vm.getBlockTimestamp()) vm.warp(pool.unlockTime(a));
        vm.prank(a);
        try pool.requestWithdraw(shares) returns (uint256 t) {
            tickets.push(t);
            ++ok["request"];
        } catch {}
    }

    function claim(uint256 idx) external {
        if (tickets.length == 0) return;
        (,, uint64 at) = pool.ticketOf(tickets[idx % tickets.length]);
        if (at > vm.getBlockTimestamp()) vm.warp(at);
        { (address owner_,,) = pool.ticketOf(tickets[idx % tickets.length]); vm.prank(owner_); }
        try pool.claim(tickets[idx % tickets.length]) {
            ++ok["claim"];
        } catch {}
    }

    function transferShares(uint256 from, uint256 to, uint256 frac) external {
        address a = actors[from % actors.length];
        address b = actors[to % actors.length];
        uint256 shares = pool.balanceOf(a) * bound(frac, 0, 100) / 100;
        vm.prank(a);
        try pool.transfer(b, shares) {} catch {}
    }

    function engineBuy(uint256 amount, uint256 spreadPct) external {
        amount = bound(amount, 1, 50_000 * USDG);
        uint256 spread = amount * bound(spreadPct, 0, 10) / 100;
        address buyer = address(0xB0B);
        _mint(buyer, amount);
        vm.startPrank(buyer);
        usdg.approve(address(engine), amount);
        try engine.buy(bytes32("s"), amount, spread, (amount - spread) * 1e12) {} catch {}
        usdg.approve(address(engine), 0);
        vm.stopPrank();
    }

    function engineSell(uint256 amount) external {
        uint256 liab = engine.totalLiability() / 1e12;
        if (liab == 0) return;
        amount = bound(amount, 1, liab);
        try engine.sell(address(0x5E11), amount, amount / 50, amount * 1e12) {
            ++ok["sell"];
        } catch {}
    }

    function accrue(uint256 amount) external {
        uint256 liab = engine.totalLiability() / 1e12;
        if (liab == 0) return;
        try engine.accrue(bytes32("s"), bound(amount, 0, liab / 10)) {} catch {}
    }

    function rebalance(uint256 units) external {
        units = bound(units, 0, 5_000e18);
        vm.prank(hedger);
        try pool.rebalance(address(stock), units, 0) {
            ++ok["rebalance"];
        } catch {}
    }

    function movePrice(uint256 pct, bool up) external {
        (uint256 s,,,) = guard.p(address(stock));
        uint256 m = bound(pct, 0, 10);
        uint256 next = up ? s * (100 + m) / 100 : s * (100 - m) / 100;
        if (next < 1e18) next = 1e18;
        guard.set(address(stock), next, SessionKind.REGULAR, true);
        swapRouter.setRate(address(usdg), address(stock), 500, 1e48 / next);
        swapRouter.setRate(address(stock), address(usdg), 500, next / 1e12);
    }

    function warp(uint256 secs) external {
        vm.warp(vm.getBlockTimestamp() + bound(secs, 1, 4 days));
    }

    function distribute() external {
        try fees.distribute() {
            ++ok["distribute"];
        } catch {}
    }

    function checkpoint() external {
        try pool.checkpoint() {} catch {}
    }
}

/// R12: invariants with the pool, reserve, fee router and a real adapter under random flows.
/// forge-config: default.invariant.runs = 64
/// forge-config: default.invariant.depth = 120
contract PoolInvariantTest is PoolFixture {
    PoolHandler internal handler;
    address[] internal actors;

    function setUp() public {
        _deploy();
        actors.push(alice);
        actors.push(bob);
        actors.push(carol);
        uint256 alreadyMinted = usdg.totalSupply();
        handler = new PoolHandler(
            pool, usdg, stock, engine, guard, swapRouter, fees, hedger, actors, alreadyMinted
        );
        targetContract(address(handler));
    }

    /// Shares: supply equals the sum of holders (actors plus the pool's own queue escrow), and the escrow equals the
    /// open tickets.
    function invariant_R12_sharesSupplyEqualsHolders() public view {
        uint256 sum = pool.balanceOf(address(pool));
        for (uint256 i; i < actors.length; ++i) {
            sum += pool.balanceOf(actors[i]);
        }
        assertEq(pool.totalSupply(), sum);
        assertEq(pool.balanceOf(address(pool)), pool.queuedShares());
        uint256 open;
        for (uint256 i; i < handler.ticketCount(); ++i) {
            (, uint256 left,) = pool.ticketOf(handler.tickets(i));
            open += left;
        }
        assertEq(open, pool.queuedShares());
    }

    /// USDG is conserved: everything minted sits with a known holder; the engine and the adapter hold none.
    function invariant_R12_usdgConserved() public view {
        uint256 sum = usdg.balanceOf(address(pool)) + usdg.balanceOf(address(reserve)) + usdg.balanceOf(address(fees))
            + usdg.balanceOf(address(swapRouter)) + usdg.balanceOf(treasury) + usdg.balanceOf(address(0xB0B))
            + usdg.balanceOf(address(0x5E11));
        for (uint256 i; i < actors.length; ++i) {
            sum += usdg.balanceOf(actors[i]);
        }
        assertEq(usdg.balanceOf(address(engine)), 0);
        assertEq(usdg.balanceOf(address(adapter)), 0);
        assertEq(sum, handler.minted());
        assertEq(sum, usdg.totalSupply());
    }

    /// No allowance is left from the pool to the adapter or from the adapter to the router.
    function invariant_R12_noDanglingApprovals() public view {
        assertEq(usdg.allowance(address(pool), address(adapter)), 0);
        assertEq(stock.allowance(address(pool), address(adapter)), 0);
        assertEq(usdg.allowance(address(adapter), address(swapRouter)), 0);
        assertEq(stock.allowance(address(adapter), address(swapRouter)), 0);
    }

    function afterInvariant() external {
        emit log_named_uint("deposits", handler.ok("deposit"));
        emit log_named_uint("requests", handler.ok("request"));
        emit log_named_uint("claims", handler.ok("claim"));
        emit log_named_uint("sells", handler.ok("sell"));
        emit log_named_uint("rebalances", handler.ok("rebalance"));
        emit log_named_uint("distributions", handler.ok("distribute"));
    }

    /// Tracked hedge is backed by held stock (no phantom hedge).
    function invariant_R12_hedgeUnitsBackedByStock() public view {
        assertLe(pool.hedgeUnits(address(stock)), stock.balanceOf(address(pool)));
    }

    /// NAV = independent recomputation (R4 under random flows) and the reserve share never exceeds the reserve.
    function invariant_R12_navMatchesRecomputation() public view {
        (uint256 s,,,) = guard.p(address(stock));
        (uint256 eq,) = pool.hedgeEquity();
        int256 raw = int256(usdg.balanceOf(address(pool)) * 1e12)
            + int256(pool.hedgeUnits(address(stock)) * s / 1e18) + (pool.hedgeStale() ? int256(0) : int256(eq * 1e12))
            - int256(pool.feeOwed() * 1e12) - int256(engine.totalLiability());
        (int256 gotRaw, uint256 rs) = pool.navParts();
        assertEq(gotRaw, raw);
        assertLe(rs, usdg.balanceOf(address(reserve)) * 1e12);
        assertEq(pool.nav(), raw + int256(rs));
        (int256 mid, int256 low, int256 high) = pool.navBand();
        assertLe(low, mid);
        assertGe(high, mid);
    }
}
