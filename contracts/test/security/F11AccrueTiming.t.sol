// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {EngineBase} from "../engine/EngineBase.sol";

/// @notice Review findings F11 (MEDIUM) / F34 (LOW): accrue() is permissionless and charged the whole gap at the rate
/// of the moment the caller picked, so a holder accruing only right after a print that moved the option in the money
/// paid the low in-the-money rate for the at-the-strike stretch before it.
/// Model: the keeper samples on a fixed 15-minute grid (any sampler the holder does not control), the price sits at
/// the strike (r = 1) except for one minute at +1% (r ~ 0.35) just before each grid point, and the holder accrues
/// exactly at those minutes. The funding charged must stay within 3% of a dense one-minute reference.
contract F11AccrueTimingTest is EngineBase {
    uint256 internal constant CYCLES = 8;

    function _run(bytes32 id, bool dense) internal returns (uint256 norm) {
        for (uint256 c; c < CYCLES; ++c) {
            // grid point: at the strike, the keeper accrues
            guard.setS(address(nvda), 100e18);
            engine.accrue(id);
            for (uint256 m = 1; m < 15; ++m) {
                skip(60);
                if (m == 14) {
                    guard.setS(address(nvda), 101e18); // a print one minute before the next grid point
                    engine.accrue(id); // the holder's accrual
                } else if (dense) {
                    engine.accrue(id);
                }
            }
            skip(60);
        }
        guard.setS(address(nvda), 100e18);
        engine.accrue(id);
        norm = registry.seriesOf(id).norm;
    }

    function test_F11_holderPickedAccrualsPayDenseFunding() public {
        bytes32 id = _list(address(nvda), true, 100e18, DAILY);
        _buy(alice, id, 10_000e18);
        skip(60);
        uint256 snap = vm.snapshotState();
        uint256 dense = _run(id, true);
        vm.revertToState(snap);
        uint256 picked = _run(id, false);
        uint256 paidDense = WAD - dense;
        uint256 paidPicked = WAD - picked;
        emit log_named_uint("funding paid, dense sampling (1e18 = all)", paidDense);
        emit log_named_uint("funding paid, holder-picked sampling", paidPicked);
        assertGe(paidPicked * 100, paidDense * 97, "holder-picked accruals must not cut funding");
    }
}
