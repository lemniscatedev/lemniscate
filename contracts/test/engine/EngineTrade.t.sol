// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {EngineBase} from "./EngineBase.sol";
import {IOptionEngine} from "../../src/interfaces/IOptionEngine.sol";
import {EngineHelper} from "../../src/EngineHelper.sol";
import {SessionKind, Speed} from "../../src/libs/OptionTypes.sol";
import {EverlastingMath} from "../../src/libs/EverlastingMath.sol";
import {EverlastingGreeks} from "../../src/libs/EverlastingGreeks.sol";
import {SeriesRegistry} from "../../src/SeriesRegistry.sol";

/// @notice Engine todo R1 (buy maths), R3 (buy checks), R9 (max loss = premium), R11 (shield), R13 (deadline and
/// slippage), R17 / R21 (depth-scaled name caps).
contract EngineTradeTest is EngineBase {
    bytes32 internal callD; // NVDA Up 100 Daily
    bytes32 internal putW; // NVDA Down 100 Weekly

    function setUp() public override {
        super.setUp();
        callD = _list(address(nvda), true, 100e18, DAILY);
        putW = _list(address(nvda), false, 100e18, WEEKLY);
    }

    // ------------------------------------------------------------------------------------------- R1 reference

    /// @dev The quote rules written out independently (empty book, fresh series, norm 1e18, skew 0).
    function _reference(bool isCall, uint256 s, uint256 k, uint64 sigma, uint32 tau, uint256 units, uint256 navWad)
        internal
        pure
        returns (uint256 usdgCost, uint256 vMark)
    {
        EverlastingGreeks.G memory g =
            isCall ? EverlastingGreeks.call(s, k, sigma, tau) : EverlastingGreeks.put(s, k, sigma, tau);
        uint256 v = isCall ? EverlastingMath.callValue(s, k, sigma, tau) : EverlastingMath.putValue(s, k, sigma, tau);
        // inventory: n = post-trade name vega / (0.6% NAV), a = 0.15
        uint256 vegaAfter = Math.mulDiv(units, g.vega, WAD);
        uint256 cap = navWad * 60 / 10_000;
        uint256 n = Math.min(Math.mulDiv(vegaAfter, WAD, cap), WAD);
        vMark = v + Math.mulDiv(v, 1500 * n, 10_000 * WAD);
        // spread: 150 + 250 x min(|K/S-1| / 0.3, 1) bps (REGULAR), at least $0.01
        uint256 away = k > s ? k - s : s - k;
        uint256 frac = Math.min(Math.mulDiv(Math.mulDiv(away, WAD, s), 10_000, 3000), WAD);
        uint256 bpsWad = 150 * WAD + 250 * frac;
        uint256 spu = Math.max(Math.mulDiv(vMark, bpsWad, 10_000 * WAD), 0.01e18);
        uint256 fee = Math.mulDiv(Math.mulDiv(s, units, WAD, Math.Rounding.Ceil), 3, 10_000, Math.Rounding.Ceil);
        usdgCost = Math.ceilDiv(Math.mulDiv(vMark + spu, units, WAD, Math.Rounding.Ceil) + fee, 1e12);
    }

    function test_R1_buyMathMatchesReference() public {
        uint256 units = 100e18;
        (uint256 want, uint256 wantMark) = _reference(true, 100e18, 100e18, 5000, DAILY, units, POOL_CASH * 1e12);
        IOptionEngine.Quote memory q = engine.quote(callD, units, true);
        assertEq(q.usdg, want, "quote == reference");
        assertEq(q.vMarkWad, wantMark, "mark == reference");
        assertEq(q.spreadBps, 150);
        assertEq(q.sigmaBps, 5000);
        assertTrue(q.buyable);
        // ATM Daily S = K = 100, sigma 50%: V = 0.92525 (spec 1.2)
        (uint256 v,,,) = engine.vMark(callD);
        assertApproxEqRel(v, 0.92525e18, 1e14);
        uint256 before = usdg.balanceOf(alice);
        (uint256 cost, uint256 tokens) = _buy(alice, callD, units);
        assertEq(cost, want, "execution == reference");
        assertEq(before - usdg.balanceOf(alice), cost);
        assertEq(tokens, units, "norm 1: tokens == units");
        assertEq(usdg.balanceOf(address(engine)), 0, "engine never holds USDG");
    }

    function testFuzz_R1_buyMathMatchesReference(uint256 units, uint256 k, bool isCall, uint64 sigma, bool weekly)
        public
    {
        units = bound(units, 1e15, 1_000e18);
        k = bound(k, 80e18, 120e18);
        sigma = uint64(bound(sigma, 3000, 15_000));
        uint32 tau = weekly ? WEEKLY : DAILY;
        _setVol(address(nvda), sigma, 0);
        bytes32 id = registry.idOf(address(nvda), isCall, uint128(k), tau);
        if (registry.seriesOf(id).token == address(0)) id = _list(address(nvda), isCall, uint128(k), tau);
        (uint256 want,) = _reference(isCall, 100e18, k, sigma, tau, units, POOL_CASH * 1e12);
        IOptionEngine.Quote memory q = engine.quote(id, units, true);
        assertEq(q.usdg, want, "quote == reference");
        (uint256 cost, uint256 tokens) = _buy(alice, id, units);
        assertEq(cost, q.usdg, "quote == execution to the wei");
        assertEq(tokens, units);
    }

    /// @dev quote == execution after time passed (the quote simulates the trade's own accrual) and with a non-empty
    /// book, at a norm below 1 (tokens round down, cost rounds up).
    function testFuzz_R1_quoteEqualsExecution(uint256 units, uint256 wait, uint256 s) public {
        units = bound(units, 1e12, 500e18);
        wait = bound(wait, 1, 3 days);
        s = bound(s, 90e18, 110e18);
        _buy(bob, callD, 50e18);
        _buy(bob, putW, 50e18);
        skip(wait);
        guard.setS(address(nvda), s);
        IOptionEngine.Quote memory q = engine.quote(callD, units, true);
        uint256 tokensWant = units * WAD / _normAfter(callD);
        (uint256 cost, uint256 tokens) = _buy(alice, callD, units);
        assertEq(cost, q.usdg, "cost");
        assertEq(tokens, tokensWant, "tokens round down at the accrued norm");
        assertLe(Math.mulDiv(tokens, registry.seriesOf(callD).norm, WAD), units, "never more units than paid for");
    }

    function _normAfter(bytes32 id) internal returns (uint256 n) {
        uint256 snap = vm.snapshotState();
        engine.accrue(id);
        n = registry.seriesOf(id).norm;
        vm.revertToState(snap);
    }

    function test_R1_inventoryRaisesMarkWithPoolShortVega() public {
        uint256 small = engine.quote(callD, 1e18, true).vMarkWad;
        _buy(bob, callD, 300e18);
        _buy(bob, putW, 300e18);
        uint256 later = engine.quote(callD, 1e18, true).vMarkWad;
        (uint256 v,,,) = engine.vMark(callD);
        assertGt(later, small, "more short vega -> higher mark");
        assertLe(later, v + v * 1500 / 10_000, "at most V x (1 + a)");
    }

    function test_R1_minimumSpreadOneCent() public {
        // Far OTM call: V tiny, the spread is the $0.01 floor.
        bytes32 otm = _list(address(nvda), true, 130e18, DAILY);
        _setVol(address(nvda), 3000, 0);
        IOptionEngine.Quote memory q = engine.quote(otm, 1e18, true);
        (uint256 v,,,) = engine.vMark(otm);
        assertLt(v, 0.01e18);
        uint256 fee = Math.mulDiv(100e18, 3, 10_000);
        assertEq(q.usdg, Math.ceilDiv(q.vMarkWad + 0.01e18 + fee, 1e12));
    }

    // ------------------------------------------------------------------------------------------- R3 buy checks

    function _expectBuyRevert(bytes32 id, bytes memory err) internal {
        vm.expectRevert(err);
        vm.prank(alice);
        engine.buy(id, 1e18, type(uint128).max, uint64(vm.getBlockTimestamp()), alice);
    }

    function test_R3_buyChecks_seriesNotBuyable() public {
        vm.prank(lister);
        registry.setBuyable(callD, false);
        _expectBuyRevert(callD, abi.encodeWithSelector(IOptionEngine.SeriesNotBuyable.selector, callD));
        vm.prank(lister);
        registry.archive(callD);
        _expectBuyRevert(callD, abi.encodeWithSelector(IOptionEngine.SeriesNotBuyable.selector, callD));
    }

    function test_R3_buyChecks_sessions() public {
        SessionKind[3] memory blocked = [SessionKind.CLOSED, SessionKind.UNKNOWN, SessionKind.HALTED];
        for (uint256 i; i < 3; ++i) {
            guard.setSession(address(nvda), blocked[i]);
            _expectBuyRevert(callD, abi.encodeWithSelector(IOptionEngine.SessionBlocksBuys.selector, blocked[i]));
        }
        guard.setSession(address(nvda), SessionKind.EXTENDED);
        _buy(alice, callD, 1e18);
    }

    function test_R3_buyChecks_earningsBlock() public {
        vol.setBlock(address(nvda), Speed.DAILY, uint64(vm.getBlockTimestamp() - 1), uint64(vm.getBlockTimestamp() + 1 hours));
        _expectBuyRevert(callD, abi.encodeWithSelector(IOptionEngine.EarningsBlock.selector, address(nvda)));
        // The Weekly series has no window of its own: the Daily window applies (as the API does).
        _expectBuyRevert(putW, abi.encodeWithSelector(IOptionEngine.EarningsBlock.selector, address(nvda)));
        skip(1 hours + 1);
        _buy(alice, callD, 1e18);
    }

    function test_R3_buyChecks_staleVolAndStalePrice() public {
        vol.set(address(nvda), Speed.DAILY, 5000, 0, uint64(vm.getBlockTimestamp() - 1));
        _expectBuyRevert(callD, abi.encodeWithSelector(IOptionEngine.StaleVol.selector));
        vol.set(address(nvda), Speed.DAILY, 0, 0, uint64(vm.getBlockTimestamp() + 1 hours));
        _expectBuyRevert(callD, abi.encodeWithSelector(IOptionEngine.StaleVol.selector));
        _setVol(address(nvda), 5000, 0);
        guard.set(address(nvda), 100e18, SessionKind.REGULAR, false);
        _expectBuyRevert(callD, abi.encodeWithSelector(IOptionEngine.StalePrice.selector));
        guard.set(address(nvda), 100e18, SessionKind.REGULAR, true);
        guard.setPauses(address(nvda), false, true); // TWAP disagreement: full read pauses buys
        _expectBuyRevert(callD, abi.encodeWithSelector(IOptionEngine.BuysArePaused.selector, bytes32("PRICE")));
    }

    function test_R3_buyChecks_pauses() public {
        vm.prank(guardian);
        engine.setBuysPaused(true);
        _expectBuyRevert(callD, abi.encodeWithSelector(IOptionEngine.BuysArePaused.selector, bytes32("GLOBAL")));
        vm.prank(admin);
        engine.setBuysPaused(false);
        vm.prank(guardian);
        engine.setSeriesBuysPaused(callD, true);
        _expectBuyRevert(callD, abi.encodeWithSelector(IOptionEngine.BuysArePaused.selector, bytes32("SERIES")));
        _buy(alice, putW, 1e18); // other series unaffected
        vm.prank(admin);
        engine.setSeriesBuysPaused(callD, false);
        pool.setHedgeStale(true);
        _expectBuyRevert(callD, abi.encodeWithSelector(IOptionEngine.BuysArePaused.selector, bytes32("HEDGE")));
    }

    function test_R3_buyChecks_drawdownPause() public {
        engine.pokeRisk(); // records today's NAV/share peak
        skip(1 days);
        pool.setNavAdjust(-int256(POOL_CASH * 1e12 * 16 / 100)); // NAV -16%
        vm.expectEmit(true, false, false, false, address(engine));
        emit IOptionEngine.AutoPaused("DRAWDOWN");
        engine.pokeRisk();
        _expectBuyRevert(callD, abi.encodeWithSelector(IOptionEngine.BuysArePaused.selector, bytes32("DRAWDOWN")));
        // Sells stay open.
        pool.setNavAdjust(0);
        engine.pokeRisk();
        (, uint256 tokens) = _buy(alice, callD, 1e18);
        pool.setNavAdjust(-int256(POOL_CASH * 1e12 * 16 / 100));
        engine.pokeRisk();
        assertGt(_sell(alice, callD, tokens), 0);
        // 31 days later the old peak has left the window and buys resume.
        skip(31 days);
        vm.expectEmit(true, false, false, false, address(engine));
        emit IOptionEngine.AutoResumed("DRAWDOWN");
        engine.pokeRisk();
        _buy(alice, callD, 1e18);
    }

    function test_R3_buyChecks_seriesCap() public {
        // $40k per series (2% of $2M is also $40k). ATM Daily ~ $0.93: 43,000 units is over.
        _expectCap(callD, 43_500e18, "SERIES");
        // 2% NAV binds when NAV is smaller: NAV $1M -> $20k.
        pool.setNavAdjust(-int256(1_000_000e18));
        _expectCap(callD, 22_000e18, "SERIES");
    }

    function test_R3_buyChecks_accountCap() public {
        // Weekly ATM put ~ $2.45: $25k is ~10,200 units; the series cap ($40k) is not the binding one.
        _buyOk(alice, putW, 5_000e18);
        _expectCapFor(alice, putW, 5_300e18, "ACCOUNT");
        _buyOk(bob, putW, 5_000e18);
    }

    function test_R3_buyChecks_nameAndTotalCaps() public {
        // Per-name cap 0.5% of $2M = $10k (the series cap, $40k, does not bind).
        EngineHelper.Params memory p = engine.params();
        p.nameCapNavBps = 50;
        vm.prank(admin);
        engine.setParams(p);
        _buyOk(alice, putW, 3_000e18); // ~ $7.35k
        _expectCap(callD, 3_000e18, "NAME"); // + ~$2.8k -> over $10k
        _buyOk(alice, callD, 2_000e18); // + ~$1.85k -> under
        // Total 0.4% NAV = $8k across names (the name cap raised out of the way).
        p.nameCapNavBps = 5000;
        p.totalCapNavBps = 40;
        vm.prank(admin);
        engine.setParams(p);
        bytes32 t = _list(address(tsla), true, 200e18, DAILY);
        _expectCap(t, 10e18, "TOTAL");
    }

    function test_R3_buyChecks_vegaAndGammaCaps() public {
        EngineHelper.Params memory p = engine.params();
        p.vegaCapNavBps = 1; // 0.01% NAV per vol point = $200
        vm.prank(admin);
        engine.setParams(p);
        // Weekly ATM vega per vol point ~ 0.049: 5,000 units ~ $245
        _expectCap(putW, 5_000e18, "VEGA");
        p.vegaCapNavBps = 60;
        p.gammaCapNavBps = 1; // $200 for a 1% move
        vm.prank(admin);
        engine.setParams(p);
        // Daily ATM gamma P&L of 1% ~ 0.135 per unit: 2,000 units ~ $270
        _expectCap(callD, 2_000e18, "GAMMA");
    }

    function _expectCap(bytes32 id, uint256 units, bytes32 kind) internal {
        _expectCapFor(alice, id, units, kind);
    }

    function _expectCapFor(address who, bytes32 id, uint256 units, bytes32 kind) internal {
        vm.expectRevert(abi.encodeWithSelector(IOptionEngine.CapExceeded.selector, kind));
        vm.prank(who);
        engine.buy(id, uint128(units), type(uint128).max, uint64(vm.getBlockTimestamp()), who);
    }

    function _buyOk(address who, bytes32 id, uint256 units) internal {
        vm.prank(who);
        engine.buy(id, uint128(units), type(uint128).max, uint64(vm.getBlockTimestamp()), who);
    }

    function test_R3_extendedSessionHalvesCaps() public {
        guard.setSession(address(nvda), SessionKind.EXTENDED);
        // Series cap $40k -> $20k: 8,500 Weekly ATM puts (~$20.8k) is over.
        _expectCap(putW, 8_500e18, "SERIES");
        guard.setSession(address(nvda), SessionKind.REGULAR);
        _buyOk(alice, putW, 8_500e18);
    }

    // ------------------------------------------------------------------------------------- R17 / R21 depth cap

    function test_R17_capsRespectHedgeDepth() public {
        vm.prank(admin);
        engine.setHedgeDepthCap(address(nvda), 5_000e18); // $5k of option value on the name
        _buyOk(alice, putW, 1_500e18); // ~$3.7k
        _expectCap(callD, 2_000e18, "DEPTH"); // +$1.85k -> over $5k
        // Other names are not affected.
        bytes32 t = _list(address(tsla), true, 200e18, DAILY);
        _buyOk(alice, t, 1_000e18);
    }

    function test_R21_depthScaledCaps() public {
        // Name cap = min(8% NAV, depth cap). NAV $100k: 8% = $8k; a generous depth cap leaves 8% NAV binding.
        pool.setNavAdjust(-int256(1_900_000e18));
        EngineHelper.Params memory p = engine.params();
        p.seriesCapNavBps = 2000; // series cap min($40k, $20k): out of the way
        p.stressBudgetBps = 5000;
        vm.startPrank(admin);
        engine.setParams(p);
        engine.setHedgeDepthCap(address(nvda), 1_000_000e18);
        vm.stopPrank();
        _buyOk(alice, putW, 2_000e18); // ~$4.9k
        _expectCap(callD, 4_000e18, "NAME"); // + ~$3.7k -> over $8k
        // A depth cap under 8% NAV binds instead.
        vm.prank(admin);
        engine.setHedgeDepthCap(address(nvda), 5_500e18);
        _expectCap(callD, 1_000e18, "DEPTH"); // + ~$0.93k -> over $5.5k, under $8k
        _buyOk(alice, callD, 500e18); // + ~$0.46k -> under both
    }

    // ------------------------------------------------------------------------------------------- R9 max loss

    function test_R9_buyerMaxLossIsPremium() public {
        uint256 before = usdg.balanceOf(alice);
        (uint256 cost, uint256 tokens) = _buy(alice, callD, 100e18);
        assertEq(before - usdg.balanceOf(alice), cost, "outflow == cost");
        // The price collapses, time passes, funding runs: the holder owes nothing and can still sell for >= 0.
        guard.setS(address(nvda), 60e18);
        skip(20 days);
        engine.accrue(callD);
        uint256 mid = usdg.balanceOf(alice);
        uint256 got = _sell(alice, callD, tokens);
        assertEq(usdg.balanceOf(alice), mid + got, "a sell only ever pays the seller");
        assertLe(before - usdg.balanceOf(alice), cost, "total outflow <= premium");
        assertEq(usdg.allowance(alice, address(engine)), type(uint256).max, "no other pull happened");
    }

    function testFuzz_R9_neverPullsMoreThanMaxCost(uint256 units, uint256 maxCost) public {
        units = bound(units, 1e15, 1_000e18);
        uint256 q = engine.quote(callD, units, true).usdg;
        maxCost = bound(maxCost, 0, q * 2);
        uint256 before = usdg.balanceOf(alice);
        vm.prank(alice);
        try engine.buy(callD, uint128(units), uint128(maxCost), uint64(vm.getBlockTimestamp()), alice) returns (
            uint256 cost, uint256
        ) {
            assertLe(cost, maxCost);
            assertEq(before - usdg.balanceOf(alice), cost);
        } catch {
            assertEq(usdg.balanceOf(alice), before);
            assertLt(maxCost, q);
        }
    }

    // ------------------------------------------------------------------------------------------ R13 deadline

    function test_R13_deadlineAndSlippage() public {
        vm.startPrank(alice);
        vm.expectRevert(IOptionEngine.Expired.selector);
        engine.buy(callD, 1e18, type(uint128).max, uint64(vm.getBlockTimestamp() - 1), alice);
        uint256 q = engine.quote(callD, 10e18, true).usdg;
        vm.expectRevert(abi.encodeWithSelector(IOptionEngine.Slippage.selector, q, q - 1));
        engine.buy(callD, 10e18, uint128(q - 1), uint64(vm.getBlockTimestamp()), alice);
        (, uint256 tokens) = engine.buy(callD, 10e18, uint128(q), uint64(vm.getBlockTimestamp()), alice);

        vm.expectRevert(IOptionEngine.Expired.selector);
        engine.sell(callD, uint128(tokens), 0, uint64(vm.getBlockTimestamp() - 1), alice);
        uint256 bid = engine.quote(callD, Math.mulDiv(tokens, registry.seriesOf(callD).norm, WAD), false).usdg;
        vm.expectRevert(abi.encodeWithSelector(IOptionEngine.Slippage.selector, bid, bid + 1));
        engine.sell(callD, uint128(tokens), uint128(bid + 1), uint64(vm.getBlockTimestamp()), alice);
        assertEq(engine.sell(callD, uint128(tokens), uint128(bid), uint64(vm.getBlockTimestamp()), alice), bid);
        vm.stopPrank();
    }

    function test_R13_zeroAndDustRevert() public {
        vm.startPrank(alice);
        vm.expectRevert(IOptionEngine.BelowMinimum.selector);
        engine.buy(callD, 0, type(uint128).max, uint64(vm.getBlockTimestamp()), alice);
        vm.expectRevert(IOptionEngine.BelowMinimum.selector);
        engine.buy(callD, 1e18, type(uint128).max, uint64(vm.getBlockTimestamp()), address(0));
        vm.expectRevert(IOptionEngine.BelowMinimum.selector);
        engine.sell(callD, 0, 0, uint64(vm.getBlockTimestamp()), alice);
        vm.stopPrank();
    }

    // ------------------------------------------------------------------------------------------- R11 shield

    function test_R11_shieldPicksSeries() public {
        bytes32 p95 = _list(address(nvda), false, 95e18, WEEKLY);
        bytes32 p90 = _list(address(nvda), false, 90e18, WEEKLY);
        _list(address(nvda), false, 96e18, DAILY); // Daily: never picked
        _list(address(nvda), true, 95e18, WEEKLY); // Up: never picked
        nvda.mint(alice, 50e18);

        // 5% below S = 100 -> strike <= 95: picks 95.
        vm.prank(alice);
        (bytes32 id, uint256 cost) = engine.shield(address(nvda), 50e18, 500, type(uint128).max, uint64(vm.getBlockTimestamp()));
        assertEq(id, p95);
        assertEq(_token(p95).balanceOf(alice), 50e18, "units = token units 1:1");
        assertGt(cost, 0);

        // 7% below -> 93: picks 90.
        vm.prank(alice);
        (id,) = engine.shield(address(nvda), 10e18, 700, type(uint128).max, uint64(vm.getBlockTimestamp()));
        assertEq(id, p90);

        // Non-buyable 95 is skipped: 5% below now picks 90.
        vm.prank(lister);
        registry.setBuyable(p95, false);
        vm.prank(alice);
        (id,) = engine.shield(address(nvda), 1e18, 500, type(uint128).max, uint64(vm.getBlockTimestamp()));
        assertEq(id, p90);

        // 15% below -> 85: nothing listed.
        vm.expectRevert(abi.encodeWithSelector(IOptionEngine.SeriesNotBuyable.selector, bytes32(0)));
        vm.prank(alice);
        engine.shield(address(nvda), 1e18, 1500, type(uint128).max, uint64(vm.getBlockTimestamp()));
    }

    function test_R11_shieldNeedsTheHolding() public {
        nvda.mint(alice, 1e18);
        vm.expectRevert(abi.encodeWithSelector(IOptionEngine.ShieldExceedsHolding.selector, 1e18, 2e18));
        vm.prank(alice);
        engine.shield(address(nvda), 2e18, 500, type(uint128).max, uint64(vm.getBlockTimestamp()));
    }

    function test_R11_shieldEmitsEvent() public {
        bytes32 p95 = _list(address(nvda), false, 95e18, WEEKLY);
        nvda.mint(alice, 5e18);
        uint256 q = engine.quote(p95, 5e18, true).usdg;
        vm.expectEmit(true, true, true, true, address(engine));
        emit IOptionEngine.ShieldBought(alice, address(nvda), p95, 5e18, q);
        vm.prank(alice);
        engine.shield(address(nvda), 5e18, 500, type(uint128).max, uint64(vm.getBlockTimestamp()));
    }
}
