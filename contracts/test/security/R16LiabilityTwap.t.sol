// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {SessionKind} from "../../src/libs/OptionTypes.sol";
import {EngineBase} from "../engine/EngineBase.sol";

/// @notice Round-2 review R16 (LOW): the LP-flow liability bounds used only the feed S while the hedge leg already used
/// the worse of S and the trade TWAP (decision 52a). On a weekend the feed sits at Friday's close while the Stock
/// Token's pool moves, so a matured ticket could claim at a liability the market had already moved past. Exits now mark
/// calls at max(S, TWAP) and puts at min(S, TWAP); entries take the lower of the tangent at S and at the TWAP.
contract R16LiabilityTwapTest is EngineBase {
    bytes32 internal put;
    bytes32 internal call;

    function setUp() public override {
        super.setUp();
        put = _list(address(nvda), false, 100e18, WEEKLY);
        call = _list(address(nvda), true, 105e18, DAILY);
        _buy(alice, put, 5_000e18);
        _buy(bob, call, 1_000e18);
        engine.accrue(put);
        engine.accrue(call);
    }

    /// @dev The exact liability if the stock were at `s` (the guard's S restored afterwards).
    function _exactAt(uint256 s, uint256 sNow) internal returns (uint256 l) {
        guard.setS(address(nvda), s);
        l = _liabilityRef();
        guard.setS(address(nvda), sNow);
    }

    /// @dev Reviewer scenario: Saturday, the token's pool and trade TWAP fall 7%, the feed stays at Friday's close, the
    /// book is net short puts. The claim bound must cover the put liability at the TWAP.
    function test_R16_weekendTwapMoveIsInTheClaimBound() public {
        skip(1 hours);
        guard.set(address(nvda), 100e18, SessionKind.CLOSED, true);
        guard.setTradeTwap(address(nvda), 93e18);
        uint256 atTwap = _exactAt(93e18, 100e18);
        assertGe(engine.navLiability(true), atTwap, "exit bound covers the liability at the TWAP");
    }

    /// @dev PROPERTY: for any feed S and trade TWAP (any session), the exit bound is at least the exact liability at
    /// both prices and the entry bound at most the exact liability at both prices.
    function testFuzz_R16_boundsCoverBothPrices(uint256 s, uint256 tw, bool closed) public {
        skip(1 hours);
        s = bound(s, 80e18, 120e18);
        tw = bound(tw, 80e18, 120e18);
        guard.set(address(nvda), s, closed ? SessionKind.CLOSED : SessionKind.REGULAR, true);
        guard.setTradeTwap(address(nvda), tw);
        uint256 lS = _exactAt(s, s);
        uint256 lT = _exactAt(tw, s);
        uint256 hi = engine.navLiability(true);
        uint256 lo = engine.navLiability(false);
        assertGe(hi + 1e12, lS > lT ? lS : lT, "exit bound >= exact at S and at TWAP");
        assertLe(lo, (lS < lT ? lS : lT) + 1e12, "entry bound <= exact at S and at TWAP");
    }
}
