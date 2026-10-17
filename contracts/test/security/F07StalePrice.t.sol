// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SessionKind} from "../../src/libs/OptionTypes.sol";
import {EngineBase} from "../engine/EngineBase.sol";

/// @notice Review findings F07, F10, F21, F22, F23 (MEDIUM): sells and queued-sell fills priced at a stale S.
///  - F07/F21: CLOSED/UNKNOWN used lastGoodS of any age (a feed dead since Wednesday paid out at Friday 20:00).
///  - F10/F23: weekend CLOSED sells at Friday's close were a free option against the 24/7 token market.
///  - F22: a feed stopped in session stayed REGULAR and fresh for 26 h; only buys looked at the TWAP.
contract F07StalePriceTest is EngineBase {
    uint256 internal constant UNITS = 10_000e18;

    function _units(bytes32 id, uint256 tokens) internal view returns (uint256) {
        return Math.mulDiv(tokens, registry.seriesOf(id).norm, WAD);
    }

    /// @dev Proceeds (6 dp) can be at most the value of `units` at S (no spread, no fee).
    function _assertAtMostValueAt(bytes32 id, bool isCall, uint256 proceeds, uint256 tokens, uint256 s) internal view {
        (uint256 v,) = helper.valueAt(isCall, s, 100e18, 5000, 0, 0, DAILY);
        uint256 cap = Math.mulDiv(_units(id, tokens), v, WAD) / 1e12;
        assertLe(proceeds, cap, "paid above the value at the worse price");
    }

    function test_F10_weekendCallSellPricedAtWorseOfCloseAndTwap() public {
        bytes32 id = _list(address(nvda), true, 100e18, DAILY);
        (, uint256 tokens) = _buy(alice, id, UNITS);
        skip(2 hours);
        guard.setSession(address(nvda), SessionKind.CLOSED); // last good S = Friday close 100
        guard.setTradeTwap(address(nvda), 97e18); // the 24/7 token pool trades 97 on Saturday
        uint256 proceeds = _sell(alice, id, tokens);
        assertGt(proceeds, 0);
        _assertAtMostValueAt(id, true, proceeds, tokens, 97e18);
    }

    function test_F23_weekendPutSellGetsNoUpsideFromTheGap() public {
        bytes32 id = _list(address(nvda), false, 100e18, DAILY);
        (, uint256 tokens) = _buy(alice, id, UNITS);
        skip(2 hours);
        guard.setSession(address(nvda), SessionKind.CLOSED);
        guard.setTradeTwap(address(nvda), 103e18); // the token rallied: the put is worth less than at the close
        uint256 proceeds = _sell(alice, id, tokens);
        _assertAtMostValueAt(id, false, proceeds, tokens, 103e18);
    }

    function test_F22_stoppedFeedInSessionSellUsesTheTwap() public {
        bytes32 id = _list(address(nvda), true, 100e18, DAILY);
        (, uint256 tokens) = _buy(alice, id, UNITS);
        skip(4 hours);
        // Feed frozen at 100 (still inside its 26 h max age, REGULAR, fresh); the market is at 94.
        guard.setTradeTwap(address(nvda), 94e18);
        uint256 proceeds = _sell(alice, id, tokens);
        _assertAtMostValueAt(id, true, proceeds, tokens, 94e18);
    }

    function test_F21_queuedFillUsesWorseOfLastGoodAndTwap() public {
        bytes32 id = _list(address(nvda), true, 100e18, DAILY);
        (, uint256 tokens) = _buy(alice, id, UNITS);
        skip(2 hours);
        guard.setSession(address(nvda), SessionKind.HALTED);
        assertEq(_sell(alice, id, tokens), 0);
        uint256 ticket = engine.ticketCount();
        skip(1 days);
        guard.setSession(address(nvda), SessionKind.CLOSED);
        guard.setTradeTwap(address(nvda), 95e18);
        vm.prank(bob);
        uint256 out = engine.fillQueued(ticket);
        _assertAtMostValueAt(id, true, out, tokens, 95e18);
    }
}
