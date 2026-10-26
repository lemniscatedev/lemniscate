// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {SessionKind} from "../../src/libs/OptionTypes.sol";
import {EngineBase} from "../engine/EngineBase.sol";

/// @notice Round-3 review R3-02 (LOW): navLiability skipped HALTED names, so a halted name was valued at its stale book
/// for both LP bounds (no worse-of TWAP, no envelope, no vol term) while PoolHedging valued the same name's hedge leg at
/// the worse of lastGoodS and the trade TWAP. With the issuer oracle paused and the token's pool down 10%, a claim on a
/// put-heavy book was priced at the pre-halt put liability. A HALTED name is now bounded like CLOSED: at its last good S
/// (or ORC-4 settlement price) with the trade TWAP. Only a name with no price at all keeps its book value.
contract R3HaltedLiabilityTest is EngineBase {
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

    function _exactAt(uint256 s, uint256 sNow) internal returns (uint256 l) {
        guard.setS(address(nvda), s);
        l = _liabilityRef();
        guard.setS(address(nvda), sNow);
    }

    /// @dev Reviewer scenario: NVDA's issuer oracle is paused (HALTED at lastGoodS 100) while the token pool falls 10%.
    /// The claim bound must cover the put liability at the TWAP (before the fix it was the book at 100).
    function test_R3_02_haltedNameUsesTheTwapInTheClaimBound() public {
        skip(1 hours);
        guard.set(address(nvda), 100e18, SessionKind.HALTED, false);
        guard.setTradeTwap(address(nvda), 90e18);
        uint256 atTwap = _exactAt(90e18, 100e18);
        assertGe(engine.navLiability(true), atTwap, "exit bound covers the liability at the TWAP while HALTED");
        assertLe(engine.navLiability(false), _exactAt(100e18, 100e18), "entry bound <= exact at last good S");
    }

    /// @dev Skeptic follow-up: a HALTED name with an ORC-4 settlement price is bounded at the settlement price (as sells
    /// read it) with the trade TWAP, not at whatever the guard's S says now.
    function test_R3_02_settledHaltedNameUsesTheSettlementPrice() public {
        skip(1 hours);
        guard.set(address(nvda), 100e18, SessionKind.HALTED, false);
        guard.setHaltedSince(address(nvda), vm.getBlockTimestamp());
        skip(7 days);
        assertEq(engine.settleHalted(address(nvda)), 100e18, "settled at the last good S");
        // the guard's S drifts (a later last-good print) while the name stays HALTED; the TWAP sits at the settlement price
        guard.setS(address(nvda), 80e18);
        guard.setTradeTwap(address(nvda), 100e18);
        uint256 at100 = _exactAt(100e18, 80e18);
        uint256 at80 = _exactAt(80e18, 80e18);
        uint256 hi = engine.navLiability(true);
        uint256 lo = engine.navLiability(false);
        assertGe(hi + 1e12, at100, "exit bound covers the liability at the settlement price");
        assertLe(lo, at100 + 1e12, "entry bound <= exact at the settlement price");
        assertLt(hi, at80, "bounded at the settlement price, not at the guard's S (put-heavy book)");
        // with a TWAP below the settlement price, the exit bound covers the puts at the TWAP too (worse-of rule)
        guard.setTradeTwap(address(nvda), 90e18);
        assertGe(engine.navLiability(true) + 1e12, _exactAt(90e18, 80e18), "worse-of TWAP while settled");
    }

    /// @dev A HALTED name with no price at all (no last good S) keeps its book value, as before.
    function test_R3_02_haltedWithoutPriceKeepsBook() public {
        guard.set(address(nvda), 0, SessionKind.HALTED, false);
        guard.setTradeTwap(address(nvda), 90e18);
        assertEq(engine.navLiability(true), engine.bookValue(), "no price: book value");
        assertEq(engine.navLiability(false), engine.bookValue(), "no price: book value");
    }

    /// @dev PROPERTY: for every session state including HALTED and any trade TWAP != S, the exit bound is at least the
    /// exact liability at both S and TWAP and the entry bound at most the exact liability at both.
    function testFuzz_R3_02_boundsCoverBothPricesInEverySession(uint256 s, uint256 tw, uint8 sessionIdx) public {
        skip(1 hours);
        s = bound(s, 80e18, 120e18);
        tw = bound(tw, 80e18, 120e18);
        SessionKind[4] memory kinds = [SessionKind.REGULAR, SessionKind.EXTENDED, SessionKind.CLOSED, SessionKind.HALTED];
        SessionKind kind = kinds[sessionIdx % 4];
        guard.set(address(nvda), s, kind, kind != SessionKind.HALTED);
        guard.setTradeTwap(address(nvda), tw);
        uint256 lS = _exactAt(s, s);
        uint256 lT = _exactAt(tw, s);
        uint256 hi = engine.navLiability(true);
        uint256 lo = engine.navLiability(false);
        assertGe(hi + 1e12, lS > lT ? lS : lT, "exit bound >= exact at S and at TWAP");
        assertLe(lo, (lS < lT ? lS : lT) + 1e12, "entry bound <= exact at S and at TWAP");
    }
}
