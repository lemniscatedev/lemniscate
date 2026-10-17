// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Vm} from "forge-std/Vm.sol";
import {VaultFixture} from "./VaultFixture.sol";
import {IWriterVault} from "../../src/interfaces/IWriterVault.sol";
import {IOptionEngine} from "../../src/interfaces/IOptionEngine.sol";

/// @notice Todo 19 R2 neverLosesMoreThanCollateral: fuzz over price paths and slice sizes. Whatever the path, a vault
/// pays the pool at most its collateral and never more than its slice's own collateral (calls: units of Stock Token;
/// puts: strike x units of USDG), and every unit it pays arrives at the pool.
contract VaultFuzzTest is VaultFixture {
    function setUp() public {
        _deployVaults();
        _open();
        _vdeposit(up, bob, 10e18);
        _vdeposit(down, bob, 1_000e6);
        _roll(up);
        down.roll();
        _claim(up, bob);
        _claim(down, bob);
        _fresh();
    }

    /// @dev Moves the price by `stepBps` (25% at most per step: priced, never latched), floored at `floorWad`.
    function _step(uint256 stepBps, bool goUp, uint256 floorWad) internal {
        uint256 s = px[0];
        uint256 d = s * stepBps / 10_000;
        uint256 next = goUp ? s + d : (s - d < floorWad ? floorWad : s - d);
        _setPrice(0, next);
    }

    /// @dev Four price steps; after each, alice sells a fuzzed part of her tokens; the rest of the slice is released.
    function _path(bytes32 id, uint256[4] calldata steps, uint256[4] calldata sellBps, bool warpBetween, bool callSide)
        internal
    {
        for (uint256 i; i < 4; ++i) {
            // calls mostly move up, puts mostly down (the losing direction for the vault)
            bool goUp = callSide ? steps[i] % 3 != 0 : steps[i] % 3 == 0;
            _step(bound(steps[i], 0, 2_500), goUp, 1e18);
            if (warpBetween) skip(1 hours);
            _refreshVols();
            uint256 bal = _token(id).balanceOf(alice);
            uint256 sell = bal * bound(sellBps[i], 0, 10_000) / 10_000;
            if (sell != 0) {
                // A partial sell worth under the minimum trade (or leaving less behind) is refused (review F14).
                vm.prank(alice);
                try engine.sell(id, uint128(sell), 0, uint64(vm.getBlockTimestamp()), alice) {}
                catch (bytes memory err) {
                    assertEq(bytes4(err), IOptionEngine.BelowMinimum.selector);
                }
            }
        }
        address v = callSide ? address(up) : address(down);
        uint256 left = vreg.sliceOf(v, id);
        if (left != 0) {
            vm.prank(keeper);
            vreg.release(v, id, left);
        }
    }

    /// @dev Sum of the vault's LossPaid amounts in the recorded logs.
    function _lossPaid(address vault) internal returns (uint256 total) {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter == vault && logs[i].topics[0] == IWriterVault.LossPaid.selector) {
                (uint256 amount,) = abi.decode(logs[i].data, (uint256, bool));
                total += amount;
            }
        }
    }

    function testFuzz_R2_neverLosesMoreThanCollateral_calls(
        uint256 slice,
        uint256[4] calldata steps,
        uint256[4] calldata sellBps,
        bool warpBetween
    ) public {
        bytes32 id = _list(0, true, 110e18, WEEKLY);
        _buy(alice, id, 20e18);
        slice = bound(slice, 1e15, 10e18);
        _assume(up, id, slice);
        uint256 coll0 = up.collateral();
        uint256 pool0 = stocks[0].balanceOf(address(pool));
        vm.recordLogs();
        _path(id, steps, sellBps, warpBetween, true);
        uint256 lost = _lossPaid(address(up));
        assertLe(lost, slice, "never more than the slice's own collateral (norm 1e18 at assumption)");
        assertLe(lost, coll0, "never more than the collateral");
        assertEq(up.collateral(), coll0 - lost, "collateral only moves by loss payments");
        assertEq(stocks[0].balanceOf(address(pool)) - pool0, lost, "every unit reaches the pool");
        assertEq(up.debt(), 0);
        assertEq(vreg.lockedOf(address(up)), 0);
    }

    function testFuzz_R2_neverLosesMoreThanCollateral_puts(
        uint256 slice,
        uint256[4] calldata steps,
        uint256[4] calldata sellBps,
        bool warpBetween
    ) public {
        uint128 strike = 90e18;
        bytes32 id = _list(0, false, strike, WEEKLY);
        _buy(alice, id, 20e18);
        slice = bound(slice, 1e15, 11e18); // up to 11 x 90 = 990 USDG of 1000
        _assume(down, id, slice);
        uint256 required = vreg.lockedOf(address(down));
        assertEq(required, (slice * strike + 1e30 - 1) / 1e30, "strike x units");
        uint256 coll0 = down.collateral();
        uint256 bal0 = usdg.balanceOf(address(down));
        vm.recordLogs();
        _path(id, steps, sellBps, warpBetween, false);
        uint256 lost = _lossPaid(address(down));
        assertLe(lost, required, "never more than strike x units");
        assertLe(lost, coll0 + (usdg.balanceOf(address(down)) + lost - bal0), "never more than collateral + funding");
        assertEq(usdg.balanceOf(address(down)), down.collateral(), "every USDG tracked (nothing pending or reserved)");
        assertEq(down.debt(), 0);
        assertEq(vreg.lockedOf(address(down)), 0);
    }
}
