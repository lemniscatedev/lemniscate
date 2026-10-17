// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IOptionEngine} from "../../src/interfaces/IOptionEngine.sol";
import {EngineBase} from "../engine/EngineBase.sol";

/// @notice Review findings F08, F14, F24 (MEDIUM): no minimum trade or position, so a 1-micro-USDG buy kept a series
/// live (and in the keeper's hourly accrual) forever, and 1-wei sells during a halt opened zero-value tickets.
contract F08DustTest is EngineBase {
    function test_F08_dustBuyReverts() public {
        bytes32 id = _list(address(nvda), true, 100e18, DAILY);
        vm.expectRevert(IOptionEngine.BelowMinimum.selector);
        _buy(alice, id, 1);
    }

    function test_F14_dustPartialSellReverts() public {
        bytes32 id = _list(address(nvda), true, 100e18, DAILY);
        _buy(alice, id, 1_000e18);
        vm.expectRevert(IOptionEngine.BelowMinimum.selector);
        _sell(alice, id, 1); // leaves the rest, sells a dust amount
    }
}
