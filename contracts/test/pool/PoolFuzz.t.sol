// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {PoolFixture} from "./PoolFixture.sol";
import {SessionKind} from "../../src/libs/OptionTypes.sol";

contract PoolFuzzTest is PoolFixture {
    function setUp() public {
        _deploy();
    }

    /// R4: NAV equals an independent recomputation from balances, the PriceGuard price, the posted equity (only when
    /// fresh) and the engine liability; the reserve share equals min(reserve, high-water deficit).
    function testFuzz_R4_navFormula(
        uint256 deposit,
        uint256 units,
        uint256 price,
        uint256 liabilityUsdg,
        uint256 equityUsdg,
        bool stale,
        uint256 reserveUsdg
    ) public {
        deposit = bound(deposit, 1 * USDG, 1_000_000 * USDG);
        units = bound(units, 0, 10_000e18);
        price = bound(price, 1e16, 10_000e18);
        liabilityUsdg = bound(liabilityUsdg, 0, 3_000_000 * USDG);
        equityUsdg = bound(equityUsdg, 0, 1_000_000 * USDG);
        pool.setHedgerLimits(2_000, 50, false);
        reserveUsdg = bound(reserveUsdg, 0, 100_000 * USDG);

        _deposit(alice, deposit);
        uint256 hwm = pool.highWaterNavPerShare();
        stock.mint(address(pool), units);
        pool.syncHedgeUnits(address(stock));
        guard.set(address(stock), price, SessionKind.REGULAR, true);
        // First post: at most 10% of the cap (20% of the last NAV), whatever the ref (F03/F17).
        equityUsdg = bound(equityUsdg, 0, pool.lastNavUsdg() * 200 / 10_000);
        vm.prank(hedger);
        pool.postHedgeEquity(equityUsdg, uint64(vm.getBlockTimestamp()), bytes32("snapshot"));
        if (stale) vm.warp(vm.getBlockTimestamp() + 2 hours + 1);
        engine.setLiability(liabilityUsdg * 1e12);
        usdg.mint(address(reserve), reserveUsdg);

        int256 raw = int256(usdg.balanceOf(address(pool)) * 1e12) + int256(units * price / 1e18)
            + (stale ? int256(0) : int256(equityUsdg * 1e12)) - int256(liabilityUsdg * 1e12);
        int256 defended = int256(hwm * pool.totalSupply() / 1e12);
        uint256 rs;
        if (raw < defended) {
            uint256 deficit = uint256(defended - raw);
            rs = deficit < reserveUsdg * 1e12 ? deficit : reserveUsdg * 1e12;
        }
        (int256 gotRaw, uint256 gotRs) = pool.navParts();
        assertEq(gotRaw, raw);
        assertEq(gotRs, rs);
        assertEq(pool.nav(), raw + int256(rs));
        assertEq(pool.navFor(liabilityUsdg * 1e12), raw + int256(rs));
    }

    /// R10: a deposit followed by request + claim at an unchanged mark never returns more than was deposited, with
    /// or without a hedge, option greeks, a liability or a closed session (wider guard band).
    function testFuzz_R10_navRoundTripNeverProfits(
        uint256 existing,
        uint256 amount,
        uint256 hedgeUnits,
        int256 delta,
        uint256 gamma,
        uint256 liabilityUsdg,
        bool closed
    ) public {
        existing = bound(existing, 1 * USDG, 1_000_000 * USDG);
        amount = bound(amount, 1, 1_000_000 * USDG);
        delta = bound(delta, -10_000e18, 10_000e18);
        gamma = bound(gamma, 0, 1_000e18);
        _deposit(bob, existing);
        liabilityUsdg = bound(liabilityUsdg, 0, existing / 2);
        engine.setLiability(liabilityUsdg * 1e12);
        engine.setGreeks(address(stock), delta, int256(gamma));
        hedgeUnits = bound(hedgeUnits, 0, (existing * 8 / 10) * 1e12 / 100);
        if (hedgeUnits != 0) _hedgeTo(hedgeUnits);
        if (closed) guard.set(address(stock), S0, SessionKind.CLOSED, true);

        usdg.mint(alice, amount);
        vm.startPrank(alice);
        usdg.approve(address(pool), amount);
        if (pool.previewDeposit(amount) == 0) {
            vm.expectRevert();
            pool.deposit(amount, alice);
            vm.stopPrank();
            return;
        }
        uint256 sh = pool.deposit(amount, alice);
        vm.stopPrank();

        vm.warp(vm.getBlockTimestamp() + 1 days);
        uint256 t = _request(alice, sh);
        vm.warp(vm.getBlockTimestamp() + 72 hours);
        uint256 paid;
        for (uint256 i; i < 3; ++i) {
            (, uint256 left,) = pool.ticketOf(t);
            if (left == 0) break;
            { (address owner_,,) = pool.ticketOf(t); vm.prank(owner_); }
            try pool.claim(t) returns (uint256 p) {
                paid += p;
            } catch {
                break;
            }
        }
        assertLe(paid, amount);
    }
}
