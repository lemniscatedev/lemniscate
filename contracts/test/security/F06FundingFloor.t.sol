// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IOptionEngine} from "../../src/interfaces/IOptionEngine.sol";
import {EngineBase} from "../engine/EngineBase.sol";

/// @notice Review finding F06 (MEDIUM): funding stopped for good at MIN_NORM (1e12) while buys were allowed down to
/// 1e14, so a buyer near the buy floor kept 1% of the units as a funding-free perpetual worth up to S (calls) or K
/// (puts), with no settle path.
contract F06FundingFloorTest is EngineBase {
    /// @dev ln(2000) Daily periods at r = 1 (deep OTM): norm 1e18 -> 5e14.
    uint256 internal constant TO_5E14 = 656_718;
    /// @dev ln(1e18 / 1.05e15) Daily periods: norm -> ~1.05e15.
    uint256 internal constant TO_105E15 = 592_600;

    function test_F06_noBuysBelowTheRelistNorm() public {
        bytes32 id = _list(address(nvda), true, 130e18, DAILY);
        _buy(bob, id, 1_000e18);
        skip(TO_5E14);
        engine.accrue(id);
        uint256 norm = registry.seriesOf(id).norm;
        assertLt(norm, 1e15);
        assertGt(norm, 1e14);
        vm.expectRevert(abi.encodeWithSelector(IOptionEngine.SeriesNotBuyable.selector, id));
        _buy(alice, id, 1_000e18);
    }

    /// @dev Reviewer's test: buy close to the buy floor, 30 days OTM, then the stock doubles; selling must not pay
    /// more than the buy cost (no funding-free remainder).
    function test_F06_nearFloorBuyLeavesNoFreeRemainder() public {
        bytes32 id = _list(address(nvda), true, 130e18, DAILY);
        _buy(bob, id, 1_000e18);
        skip(TO_105E15);
        engine.accrue(id);
        assertGt(registry.seriesOf(id).norm, 1e15);
        (uint256 cost, uint256 tokens) = _buy(alice, id, 100_000e18);
        for (uint256 d; d < 30; ++d) {
            skip(1 days);
            engine.accrue(id);
        }
        guard.setS(address(nvda), 200e18);
        skip(1 days);
        uint256 proceeds = _sell(alice, id, tokens);
        assertLt(proceeds, cost, "a floored series must not hand back more than its cost");
    }
}
