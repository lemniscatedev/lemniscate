// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IOptionEngine} from "../../src/interfaces/IOptionEngine.sol";
import {EngineStorage} from "../../src/engine/EngineStorage.sol";
import {SessionKind} from "../../src/libs/OptionTypes.sol";
import {EngineBase} from "../engine/EngineBase.sol";

/// @notice Round-2 review R02 (MEDIUM): the F01 hold was kept per account and written by gift buys (recipient = victim)
/// and by 1-wei transfers from an account with an open hold, keeping the more binding S and the later end, so a
/// stranger could pin a victim's whole balance at an extreme S for the whole week (-86% in the PoC). The hold is now
/// bound to the tokens its own buys minted: only the buyer (or the agent router for its owner) can be a buy's
/// recipient, held tokens cannot be transferred until the hold ends, and a sell prices only its held tokens at the
/// hold S.
contract R02HoldPoisoningTest is EngineBase {
    address internal mallory = makeAddr("mallory");
    bytes32 internal callN; // NVDA Weekly Up 100

    function setUp() public override {
        super.setUp();
        callN = _list(address(nvda), true, 100e18, WEEKLY);
        _fund(mallory);
    }

    function _openTokens(address who) internal view returns (uint256) {
        EngineStorage.Hold memory h = engine.holdOf(callN, who);
        return h.until > vm.getBlockTimestamp() ? h.tokens : 0;
    }

    function _fair(uint256 units) internal view returns (uint256) {
        return engine.quote(callN, units, false).usdg;
    }

    function _mine(uint256 units) internal view returns (uint256) {
        return engine.quoteFor(callN, units, false, bob).usdg;
    }

    /// @dev PoC 1: bob held 1,000 units for 2 h; at S = 95 mallory buys 5 units for recipient = bob, repeated every
    /// 25 min while S rises to 105. Bob's quote was $791.76 against a fair $5,781.70. The gift buy is now refused.
    function test_R02_giftBuyCannotWriteTheVictimsHold() public {
        _buy(bob, callN, 1_000e18);
        skip(2 hours);
        guard.setS(address(nvda), 95e18);
        for (uint256 i; i < 5; ++i) {
            vm.prank(mallory);
            vm.expectRevert(IOptionEngine.NotOwnBuy.selector);
            engine.buy(callN, 5e18, type(uint128).max, uint64(vm.getBlockTimestamp()), bob);
            skip(25 minutes);
            guard.setS(address(nvda), 95e18 + (i + 1) * 2e18);
        }
        assertEq(_openTokens(bob), 0);
        assertEq(_mine(1_000e18), _fair(1_000e18), "bob sells at the fair price");
    }

    /// @dev PoC 2 (dust): mallory buys 5 units for herself at S = 95, S moves to 105, she sends 1 wei to bob. The
    /// transfer of a held token now reverts; after her hold ends her tokens are free and carry nothing.
    function test_R02_dustTransferCannotCarryAHold() public {
        (, uint256 bobTokens) = _buy(bob, callN, 1_000e18);
        skip(2 hours);
        guard.setS(address(nvda), 95e18);
        _buy(mallory, callN, 5e18);
        guard.setS(address(nvda), 105e18);
        IERC20 tk = _token(callN);
        vm.prank(mallory);
        vm.expectRevert();
        tk.transfer(bob, 1);
        skip(30 minutes);
        vm.prank(mallory);
        tk.transfer(bob, 1);
        assertEq(_openTokens(bob), 0, "a transfer never writes the receiver's hold");
        uint256 units = bobTokens * registry.seriesOf(callN).norm / WAD;
        assertEq(_mine(units), _fair(units));
    }

    /// @dev The hold binds only the tokens its buy minted: an old position plus a fresh small buy prices the old tokens
    /// at today's S and only the new ones at the buy S.
    function test_R02_holdBindsOnlyTheTokensItsBuyMinted() public {
        (, uint256 oldTokens) = _buy(alice, callN, 1_000e18);
        skip(2 hours);
        (, uint256 newTokens) = _buy(alice, callN, 10e18);
        EngineStorage.Hold memory h = engine.holdOf(callN, alice);
        assertEq(h.tokens, newTokens);
        guard.setS(address(nvda), 103e18);
        uint256 all = engine.quoteFor(callN, (oldTokens + newTokens) * registry.seriesOf(callN).norm / WAD, false, alice).usdg;
        uint256 fairAll = _fair((oldTokens + newTokens) * registry.seriesOf(callN).norm / WAD);
        assertLt(all, fairAll, "the new tokens are still held");
        assertGt(all * 100, fairAll * 97, "only the new 1% is priced at the buy S");
        // the free tokens move; the held ones do not
        IERC20 tk = _token(callN);
        vm.prank(alice);
        tk.transfer(bob, oldTokens);
        vm.prank(alice);
        vm.expectRevert();
        tk.transfer(bob, 1);
    }

    /// @dev A queued sell keeps the held part's hold; cancelling hands it back (cancel cannot shed the hold).
    function test_R02_ticketCarriesItsHoldAndCancelRestoresIt() public {
        (, uint256 tokens) = _buy(alice, callN, 100e18);
        guard.setSession(address(nvda), SessionKind.HALTED);
        _sell(alice, callN, tokens);
        uint256 ticket = engine.ticketCount();
        assertEq(engine.holdOf(callN, alice).tokens, 0, "the held tokens left with the ticket");
        vm.prank(alice);
        engine.cancelQueued(ticket);
        assertEq(engine.holdOf(callN, alice).tokens, tokens, "and came back under their hold");
        IERC20 tk = _token(callN);
        vm.prank(alice);
        vm.expectRevert();
        tk.transfer(bob, 1);
    }

    /// @dev PROPERTY: for an account X with no buy of its own in the last holdSeconds, no sequence of actions by other
    /// accounts (buys for X, buys for themselves, transfers to X, time passing, price moves) changes X's hold or makes
    /// X's sell quote for the tokens it held differ from a fresh account's quote; for an X with an open hold, other
    /// accounts cannot change it at all.
    function testFuzz_R02_strangersCannotTouchAHold(uint256 seed, uint8 steps, bool xBuysFirst) public {
        (, uint256 xTokens) = _buy(bob, callN, 300e18);
        skip(2 hours);
        if (xBuysFirst) _buy(bob, callN, 20e18);
        EngineStorage.Hold memory before = engine.holdOf(callN, bob);
        IERC20 tk = _token(callN);
        steps = uint8(bound(steps, 1, 10));
        for (uint256 i; i < steps; ++i) {
            uint256 r = uint256(keccak256(abi.encode(seed, i)));
            address a = r % 2 == 0 ? mallory : alice;
            uint256 kind = (r >> 8) % 5;
            if (kind == 0) {
                vm.prank(a);
                try engine.buy(callN, uint128(bound(r >> 16, 10e18, 40e18)), type(uint128).max, uint64(vm.getBlockTimestamp()), bob) {
                    revert("gift buy went through");
                } catch {}
            } else if (kind == 1) {
                _buy(a, callN, bound(r >> 16, 10e18, 40e18));
            } else if (kind == 2) {
                uint256 bal = tk.balanceOf(a);
                if (bal != 0) {
                    vm.prank(a);
                    try tk.transfer(bob, bound(r >> 16, 1, bal)) {} catch {}
                }
            } else if (kind == 3) {
                guard.setS(address(nvda), bound(r >> 16, 90e18, 110e18));
            } else {
                skip(bound(r >> 16, 1, 10 minutes));
            }
            EngineStorage.Hold memory now_ = engine.holdOf(callN, bob);
            assertEq(now_.s, before.s, "s");
            assertEq(now_.until, before.until, "until");
            assertEq(now_.tokens, before.tokens, "tokens");
        }
        uint256 units = xTokens * registry.seriesOf(callN).norm / WAD;
        if (!xBuysFirst || engine.holdOf(callN, bob).until <= vm.getBlockTimestamp()) {
            assertEq(_mine(units), _fair(units), "X's old tokens sell like a fresh account's");
        }
    }
}
