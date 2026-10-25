// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {SystemFixture} from "../system/SystemFixture.sol";

/// @notice Review findings F12/F15 (MEDIUM): pool hedges are marked at the live S while the engine's bookValue holds
/// every series at its last touch, and the NAV guard band is ~0 for a hedged book. After a print and before the
/// keeper's re-mark, a claim was paid at an overstated NAV (and a deposit priced at an understated one), and a caller
/// could re-mark only the series that suit them. Exits and entries must never beat the re-marked NAV.
contract F12NavMarkTest is SystemFixture {
    address internal bob = makeAddr("bob");
    uint256 internal constant UNITS = 10_000e18;

    function setUp() public {
        _deploySystem(1, 1_000_000e6);
        _deposit(bob, 1_000_000e6);
    }

    /// @dev A Daily ATM call book, delta-hedged by the pool.
    function _hedgedCallBook() internal returns (bytes32 id) {
        id = _list(0, true, 100e18, DAILY);
        _buy(alice, id, UNITS);
        (int256 delta,,) = engine.netGreeks(address(stocks[0]));
        vm.prank(hedger);
        pool.rebalance(address(stocks[0]), uint256(delta), 0);
    }

    function test_F15_claimAfterUpPrintNeverBeatsTheRemark() public {
        _hedgedCallBook();
        uint256 shares = pool.balanceOf(bob);
        skip(60);
        _setPrice(0, 103e18); // +3% print: hedge marked at once, liability still at 100
        uint256 stale = pool.previewRedeem(shares);
        uint256 snap = vm.snapshotState();
        _accrueAll();
        uint256 remarked = pool.previewRedeem(shares);
        vm.revertToState(snap);
        emit log_named_uint("claim value before the re-mark", stale);
        emit log_named_uint("claim value after the re-mark ", remarked);
        assertLe(stale, remarked + 100e6, "an exit before the re-mark must not be paid more");
    }

    function test_F15_depositAfterDownPrintNeverBeatsTheRemark() public {
        _hedgedCallBook();
        skip(60);
        _setPrice(0, 97e18); // -3%: hedge loss booked at once, liability still at 100
        uint256 stale = pool.previewDeposit(100_000e6);
        uint256 snap = vm.snapshotState();
        _accrueAll();
        uint256 remarked = pool.previewDeposit(100_000e6);
        vm.revertToState(snap);
        emit log_named_uint("shares for 100k before the re-mark", stale);
        emit log_named_uint("shares for 100k after the re-mark ", remarked);
        assertLe(stale, remarked + remarked / 10_000, "an entry before the re-mark must not get more shares");
    }

    /// @dev Reviewer F12: refreshing only the series whose value fell (selective accrue) before a claim.
    function test_F12_selectiveRemarkDoesNotHelpAClaim() public {
        bytes32 call = _hedgedCallBook();
        bytes32 put = _list(0, false, 100e18, DAILY);
        _buy(alice, put, UNITS);
        call;
        uint256 shares = pool.balanceOf(bob);
        skip(60);
        _setPrice(0, 103e18);
        bytes32[] memory only = new bytes32[](1);
        only[0] = put; // re-mark only the put (its value fell), leave the call stale
        engine.accrueMany(only);
        uint256 selective = pool.previewRedeem(shares);
        uint256 snap = vm.snapshotState();
        _accrueAll();
        uint256 remarked = pool.previewRedeem(shares);
        vm.revertToState(snap);
        assertLe(selective, remarked + 100e6, "a selective re-mark must not raise an exit");
    }

    /// @dev Once the keeper re-marks every live series of a name at one S, both bounds are the book value: LPs then
    /// enter and exit at the exact liability, with no band.
    function test_F12_fullRemarkCollapsesTheBounds() public {
        _hedgedCallBook();
        bytes32 put = _list(0, false, 95e18, WEEKLY);
        _buy(alice, put, UNITS);
        skip(60);
        _setPrice(0, 102e18);
        assertGt(engine.navLiability(true), engine.navLiability(false), "a band while the marks are stale");
        _accrueAll();
        assertEq(engine.navLiability(true), engine.bookValue());
        assertEq(engine.navLiability(false), engine.bookValue());
        assertApproxEqRel(engine.bookValue(), engine.totalLiability(), 1e12, "book value is the exact liability");
    }

    /// @dev The bounds hold for any move: the upper bound is never below the exact liability, the lower never above.
    function testFuzz_F12_boundsBracketTheExactLiability(uint256 moveBps, bool up) public {
        _hedgedCallBook();
        bytes32 put = _list(0, false, 95e18, WEEKLY);
        _buy(alice, put, UNITS);
        moveBps = bound(moveBps, 1, 2000);
        skip(60);
        _setPrice(0, up ? 100e18 * (10_000 + moveBps) / 10_000 : 100e18 * (10_000 - moveBps) / 10_000);
        uint256 exact = engine.totalLiability();
        assertGe(engine.navLiability(true) + 1e6, exact, "upper bound");
        assertLe(engine.navLiability(false), exact + 1e6, "lower bound");
    }

    // ------------------------------------------------------------ follow-up B2 (todo 27-merge-fixes)

    function _mockTradeTwap(uint256 twap) internal {
        vm.mockCall(
            address(guard), abi.encodeWithSignature("tradeTwap(address)", address(stocks[0])), abi.encode(twap)
        );
    }

    /// @dev B2-1: a feed print the trade TWAP has not confirmed (the feed lags or leads the market) must not raise an
    /// exit through the hedge leg. With the liability already re-marked at the print, a claim values the pool's hedge
    /// at the lower of the feed S and the trade TWAP; the mid NAV (views, trading paths) keeps the feed S.
    function test_B2_claimValuesTheHedgeAtTheLowerOfFeedAndTwap() public {
        _hedgedCallBook();
        uint256 shares = pool.balanceOf(bob);
        skip(60);
        _setPrice(0, 103e18);
        _accrueAll(); // liability marked at the print: only the hedge leg differs below
        uint256 units = pool.hedgeUnits(address(stocks[0]));
        assertGt(units, 0, "hedged");
        uint256 atFeed = pool.previewRedeem(shares);
        int256 midAtFeed = pool.nav();
        _mockTradeTwap(100e18);
        uint256 atTwap = pool.previewRedeem(shares);
        // bob's part of the hedge's 3 USDG per unit gap
        uint256 gap = units * 3 / 1e12 * shares / pool.totalSupply();
        emit log_named_uint("claim value, hedge at the feed", atFeed);
        emit log_named_uint("claim value, hedge at the TWAP", atTwap);
        assertApproxEqRel(atFeed - atTwap, gap, 0.01e18, "exit values the hedge at the lower TWAP");
        assertEq(pool.nav(), midAtFeed, "mid NAV unchanged");
        _mockTradeTwap(106e18); // a higher TWAP never raises an exit (R16: it now also marks the calls up)
        assertLe(pool.previewRedeem(shares), atFeed, "a higher TWAP never raises an exit");
    }

    /// @dev B2-1, entry side: a deposit values the hedge at the higher of the feed S and the trade TWAP.
    function test_B2_depositValuesTheHedgeAtTheHigherOfFeedAndTwap() public {
        _hedgedCallBook();
        skip(60);
        _setPrice(0, 97e18);
        _accrueAll();
        uint256 atFeed = pool.previewDeposit(100_000e6);
        _mockTradeTwap(100e18); // the TWAP has not followed the down print yet
        uint256 atTwap = pool.previewDeposit(100_000e6);
        assertLt(atTwap, atFeed, "fewer shares while the TWAP says the hedge is worth more");
        _mockTradeTwap(94e18); // R16: it now also lowers the entry's liability tangent
        assertLe(pool.previewDeposit(100_000e6), atFeed, "a lower TWAP never cheapens an entry");
    }

    /// @dev B2-1: the high-water mark a deposit records is the exit-side NAV (the checkpoint's), never the entry
    /// side's: a deposit while the marks are stale must not ratchet the mark above what `checkpoint()` records.
    function test_B2_depositCheckpointsAtTheExitSide() public {
        _hedgedCallBook();
        skip(60);
        _setPrice(0, 103e18); // stale marks: entry and exit bounds differ
        uint256 snap = vm.snapshotState();
        pool.checkpoint();
        uint256 byCheckpoint = pool.highWaterNavPerShare();
        vm.revertToState(snap);
        _deposit(makeAddr("carol"), 1e6);
        assertLe(pool.highWaterNavPerShare(), byCheckpoint + 1e12, "a deposit records the exit-side mark");
    }

    /// @dev B2-2: funding accrued since the last mark lowers the true liability (holders pay the pool), while the book
    /// still holds the mark. A deposit just before the keeper's accrual must not get the shares that funding is about to
    /// lift: the entry bound subtracts the most funding could have taken since the name's last full re-mark.
    function test_B2_depositBeforeAccrualDoesNotCaptureFunding() public {
        _hedgedCallBook();
        bytes32 put = _list(0, false, 100e18, WEEKLY);
        _buy(alice, put, UNITS);
        _accrueAll();
        skip(50 minutes); // no price move, no keeper accrual yet
        uint256 stale = pool.previewDeposit(100_000e6);
        uint256 snap = vm.snapshotState();
        _accrueAll();
        uint256 remarked = pool.previewDeposit(100_000e6);
        vm.revertToState(snap);
        emit log_named_uint("shares for 100k before the accrual", stale);
        emit log_named_uint("shares for 100k after the accrual ", remarked);
        // 50 ppm: the guard band is built from the greeks at the marks and moves by funding x band (about 17 ppm
        // here); without the funding term the entry got 236 ppm more shares.
        assertLe(stale, remarked + remarked * 50 / 1e6, "an entry before the accrual must not get more shares");
        assertGe(engine.navLiability(true), engine.totalLiability(), "the exit bound still covers the liability");
    }

    /// @dev B2-2: the funding term is a bound, not a guess: for any gap up to a day the entry bound never exceeds the
    /// liability after the accrual.
    function testFuzz_B2_entryBoundBelowTheAccruedLiability(uint256 gap, uint256 moveBps, bool up) public {
        _hedgedCallBook();
        bytes32 put = _list(0, false, 95e18, WEEKLY);
        _buy(alice, put, UNITS);
        _accrueAll();
        gap = bound(gap, 1, 1 days);
        moveBps = bound(moveBps, 0, 1000);
        skip(gap);
        _refreshVols();
        _setPrice(0, up ? 100e18 * (10_000 + moveBps) / 10_000 : 100e18 * (10_000 - moveBps) / 10_000);
        uint256 low = engine.navLiability(false);
        _accrueAll();
        assertLe(low, engine.bookValue() + engine.bookValue() / 1e4 + 1e6, "entry bound <= accrued liability");
    }
}
