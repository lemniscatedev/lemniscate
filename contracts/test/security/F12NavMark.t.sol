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
}
