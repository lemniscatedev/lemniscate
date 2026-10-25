// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {EngineBase} from "../engine/EngineBase.sol";

/// @notice Round-2 review R07 (MEDIUM): a series retired as dust was never re-accrued or re-marked again (accrueMany
/// skipped it, only a new buy re-listed it), so its regained value stayed out of bookValue, the claim bound, hedging and
/// totalLiability, and its holders paid the whole gap at the retirement-time funding rate (-87% in the PoC). Retired
/// series now accrue when the keeper sends them, re-list once worth the minimum again, stay in the NAV bounds (dust
/// tier) and in the exact liability.
contract R07RetiredDustTest is EngineBase {
    bytes32 internal call; // NVDA Daily 100 call (bob)
    bytes32 internal put; // NVDA Weekly 100 put (alice), keeps the name live

    function setUp() public override {
        super.setUp();
        call = _list(address(nvda), true, 100e18, DAILY);
        put = _list(address(nvda), false, 100e18, WEEKLY);
        _buy(bob, call, 5_000e18);
        _buy(alice, put, 1_000e18);
    }

    function _keeper() internal {
        bytes32[] memory ids = new bytes32[](2);
        ids[0] = call;
        ids[1] = put;
        engine.accrueMany(ids);
    }

    function _retire() internal returns (uint256) {
        bytes32[] memory ids = new bytes32[](1);
        ids[0] = call;
        return engine.retireDust(ids);
    }

    /// @dev Reviewer PoC: S drops to 55, the call is retired, S is back at 110 within the hour and the keeper runs
    /// accrueMany([call, put]) every 5 minutes. Bounds, book and totalLiability were $728 against $48,548 real.
    function test_R07_retiredSeriesIsReMarkedAndReListed() public {
        skip(10 minutes);
        guard.setS(address(nvda), 55e18);
        assertEq(_retire(), 1, "dust at 55");
        assertEq(engine.liveSeries(address(nvda)).length, 1);
        guard.setS(address(nvda), 110e18);
        for (uint256 i; i < 12; ++i) {
            skip(5 minutes);
            _keeper();
        }
        uint256 exact = _liabilityRef();
        assertGt(exact, 40_000e18, "the call is deep in the money again");
        assertApproxEqRel(engine.bookValue(), exact, 1e15, "book value has the regained value");
        assertApproxEqRel(engine.totalLiability(), exact, 1e15, "totalLiability counts it");
        assertGe(engine.navLiability(true) + 1e12, exact, "claim bound covers it");
        assertEq(engine.liveSeries(address(nvda)).length, 2, "back on the live list (5-minute grid)");
    }

    /// @dev Holder side of the PoC: two days in the money after the retirement. With every keeper accrual reaching the
    /// series, bob is charged like a series that was never retired.
    function test_R07_retirementDoesNotChangeTheHoldersFunding() public {
        skip(10 minutes);
        guard.setS(address(nvda), 55e18);
        uint256 snap = vm.snapshotState();
        uint256 retiredNorm = _path(true);
        vm.revertToState(snap);
        uint256 twinNorm = _path(false);
        assertEq(retiredNorm, twinNorm, "retirement is neutral for funding");
    }

    function _path(bool retire) internal returns (uint256) {
        if (retire) assertEq(_retire(), 1);
        else engine.accrue(call); // the same sample retireDust takes
        guard.setS(address(nvda), 110e18);
        for (uint256 i; i < 48; ++i) {
            skip(1 hours);
            _keeper();
        }
        return registry.seriesOf(call).norm;
    }

    /// @dev PROPERTY: after any sequence of price moves, retireDust and keeper accrueMany calls, (i) the claim bound
    /// covers the exact liability summed over every series with supply, (ii) once the keeper has run every series with
    /// supply is accrued now, and (iii) the holder's norm equals that of the same path without any retirement.
    function testFuzz_R07_retiredSeriesStayInTheBooks(uint256 seed, uint8 steps) public {
        steps = uint8(bound(steps, 2, 16));
        uint256 snap = vm.snapshotState();
        uint256 normRetired = _fuzzPath(seed, steps, true);
        vm.revertToState(snap);
        uint256 normTwin = _fuzzPath(seed, steps, false);
        assertEq(normRetired, normTwin, "(iii) funding as if never retired");
    }

    function _fuzzPath(uint256 seed, uint256 steps, bool retire) internal returns (uint256) {
        for (uint256 i; i < steps; ++i) {
            uint256 r = uint256(keccak256(abi.encode(seed, i)));
            guard.setS(address(nvda), bound(r, 50e18, 130e18));
            skip(bound(r >> 64, 1 minutes, 2 hours));
            if ((r >> 128) % 3 == 0) {
                if (retire) _retire();
                engine.accrue(call); // the same sample in both paths (a no-op after retireDust's own)
            }
            if ((r >> 136) % 2 == 0) {
                _keeper();
                assertEq(registry.seriesOf(call).lastAccrual, vm.getBlockTimestamp(), "(ii) call accrued");
                assertEq(registry.seriesOf(put).lastAccrual, vm.getBlockTimestamp(), "(ii) put accrued");
            }
            assertGe(engine.navLiability(true) + 1e12, _liabilityRefAtMarks(), "(i) claim bound");
        }
        _keeper();
        return registry.seriesOf(call).norm;
    }

    /// @dev The exact liability at today's S of the norms as last accrued (what the bound must cover now).
    function _liabilityRefAtMarks() internal view returns (uint256) {
        return _liabilityRef();
    }
}
