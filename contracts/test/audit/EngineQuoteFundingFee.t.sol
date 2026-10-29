// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {SystemFixture} from "../system/SystemFixture.sol";

/// @notice Audit 2026-10-29 M-1: a buy's own accrual sends the protocol fee on funding to the FeeRouter before the buy
/// is priced, so a quote that left that fee out was below execution and every buy at the exact quote (each
/// AgentRouter buyFor / shieldFor) reverted with Slippage. Runs on the real engine, WriterPool and FeeRouter.
contract EngineQuoteFundingFeeTest is SystemFixture {
    bytes32 internal id;

    function setUp() public {
        _deploySystem(1, 200_000e6);
        _lowMinTrade();
        id = _list(0, true, 100e18, DAILY);
        _buy(alice, id, 1_000e18); // open interest, so funding accrues
        skip(3 hours); // funding is due on the next trade
        _refreshVols();
        _setPrice(0, 100e18);
    }

    function test_M1_quoteEqualsExecutionWhenFundingDue() public {
        uint256 quoted = engine.quote(id, 50e18, true).usdg;
        (uint256 cost,) = _buy(alice, id, 50e18);
        assertEq(cost, quoted, "quote == execution with funding due");
    }

    function test_M1_buyAtExactQuoteDoesNotRevert() public {
        uint256 quoted = engine.quote(id, 50e18, true).usdg;
        vm.prank(alice);
        engine.buy(id, uint128(50e18), uint128(quoted), uint64(block.timestamp), alice);
    }

    function test_M1_controlNoFundingDue() public {
        engine.accrue(id);
        uint256 quoted = engine.quote(id, 50e18, true).usdg;
        (uint256 cost,) = _buy(alice, id, 50e18);
        assertEq(cost, quoted);
    }
}
