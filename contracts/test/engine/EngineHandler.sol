// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {LemniscateEngine} from "../../src/LemniscateEngine.sol";
import {SeriesRegistry} from "../../src/SeriesRegistry.sol";
import {SessionKind} from "../../src/libs/OptionTypes.sol";
import {MockEnginePool, MockEnginePriceGuard, MockPausableUSDG} from "../mocks/EngineMocks.sol";

/// @dev Stateful handler for the engine invariants: buys, sells, same-block round trips, transfers, HALTED sells with
/// fills and cancels, accrueMany, price moves of at most 3% per step, session changes and time warps. Expected
/// reverts are swallowed; a Panic (0x4e487b71) is recorded and fails `invariant_noPanic`.
contract EngineHandler is Test {
    uint256 internal constant WAD = 1e18;

    LemniscateEngine public engine;
    SeriesRegistry public registry;
    MockEnginePriceGuard public guard;
    MockEnginePool public pool;
    MockPausableUSDG public usdg;
    address[] public actors;
    bytes32[] public ids;
    address[] public stockList;

    uint256 public ghostCosts;
    uint256 public ghostProceeds;
    bool public panicked;
    bool public roundTripProfit;
    mapping(address => uint256) public paidBy;
    mapping(address => uint256) public receivedBy;
    mapping(bytes32 => uint256) public lastNorm;
    bool public normRose;
    uint256[] public openTickets;

    constructor(
        LemniscateEngine engine_,
        SeriesRegistry registry_,
        MockEnginePriceGuard guard_,
        MockEnginePool pool_,
        MockPausableUSDG usdg_,
        address[] memory actors_,
        bytes32[] memory ids_,
        address[] memory stocks_
    ) {
        engine = engine_;
        registry = registry_;
        guard = guard_;
        pool = pool_;
        usdg = usdg_;
        actors = actors_;
        ids = ids_;
        stockList = stocks_;
        for (uint256 i; i < ids_.length; ++i) {
            lastNorm[ids_[i]] = 1e18;
        }
    }

    function idsLength() external view returns (uint256) {
        return ids.length;
    }

    function actorsLength() external view returns (uint256) {
        return actors.length;
    }

    function _check(bytes memory err) internal {
        if (err.length >= 4 && bytes4(err) == 0x4e487b71) panicked = true;
    }

    function _trackNorms() internal {
        for (uint256 i; i < ids.length; ++i) {
            uint256 n = registry.seriesOf(ids[i]).norm;
            if (n > lastNorm[ids[i]]) normRose = true;
            lastNorm[ids[i]] = n;
        }
    }

    function _token(bytes32 id) internal view returns (IERC20) {
        return IERC20(registry.seriesOf(id).token);
    }

    // ------------------------------------------------------------------------------------------------ actions

    function buy(uint256 a, uint256 i, uint256 units) external {
        address who = actors[a % actors.length];
        bytes32 id = ids[i % ids.length];
        units = bound(units, 1e15, 300e18);
        uint256 before = usdg.balanceOf(who);
        vm.prank(who);
        try engine.buy(id, uint128(units), type(uint128).max, uint64(vm.getBlockTimestamp()), who) returns (
            uint256 cost, uint256
        ) {
            ghostCosts += cost;
            paidBy[who] += cost;
            assertEq(before - usdg.balanceOf(who), cost);
        } catch (bytes memory err) {
            _check(err);
        }
        _trackNorms();
    }

    function sell(uint256 a, uint256 i, uint256 frac) external {
        address who = actors[a % actors.length];
        bytes32 id = ids[i % ids.length];
        uint256 bal = _token(id).balanceOf(who);
        if (bal == 0) return;
        uint256 tokens = bound(frac, 1, bal);
        uint256 ticketsBefore = engine.ticketCount();
        vm.prank(who);
        try engine.sell(id, uint128(tokens), 0, uint64(vm.getBlockTimestamp()), who) returns (uint256 got) {
            ghostProceeds += got;
            receivedBy[who] += got;
            if (engine.ticketCount() > ticketsBefore) openTickets.push(engine.ticketCount());
        } catch (bytes memory err) {
            _check(err);
        }
        _trackNorms();
    }

    function roundTrip(uint256 a, uint256 i, uint256 units) external {
        address who = actors[a % actors.length];
        bytes32 id = ids[i % ids.length];
        units = bound(units, 1e15, 100e18);
        vm.startPrank(who);
        try engine.buy(id, uint128(units), type(uint128).max, uint64(vm.getBlockTimestamp()), who) returns (
            uint256 cost, uint256 tokens
        ) {
            ghostCosts += cost;
            paidBy[who] += cost;
            uint256 tb = engine.ticketCount();
            IERC20 token = IERC20(registry.seriesOf(id).token);
            uint256 held = token.balanceOf(who);
            try engine.sell(id, uint128(tokens), 0, uint64(vm.getBlockTimestamp()), who) returns (uint256 got) {
                ghostProceeds += got;
                receivedBy[who] += got;
                // The engine sells the whole balance when the remainder would be dust (EngineCore.sellSize), so a
                // round trip can sell tokens bought earlier: compare per token, not totals (public CI 40979185970).
                uint256 sold = held - token.balanceOf(who);
                if (engine.ticketCount() > tb) openTickets.push(engine.ticketCount());
                else if (got * tokens > cost * sold) roundTripProfit = true;
            } catch (bytes memory err) {
                _check(err);
            }
        } catch (bytes memory err) {
            _check(err);
        }
        vm.stopPrank();
        _trackNorms();
    }

    function transfer(uint256 a, uint256 b, uint256 i, uint256 amount) external {
        address from = actors[a % actors.length];
        address to = actors[b % actors.length];
        IERC20 t = _token(ids[i % ids.length]);
        uint256 bal = t.balanceOf(from);
        if (bal == 0) return;
        amount = bound(amount, 1, bal);
        vm.prank(from);
        try t.transfer(to, amount) {} catch (bytes memory err) {
            _check(err);
        }
        _trackNorms();
    }

    function fill(uint256 k) external {
        if (openTickets.length == 0) return;
        uint256 idx = k % openTickets.length;
        uint256 ticket = openTickets[idx];
        address recipient = engine.queuedSell(ticket).recipient;
        try engine.fillQueued(ticket) returns (uint256 got) {
            ghostProceeds += got;
            receivedBy[recipient] += got;
            openTickets[idx] = openTickets[openTickets.length - 1];
            openTickets.pop();
        } catch (bytes memory err) {
            _check(err);
        }
        _trackNorms();
    }

    function cancel(uint256 k) external {
        if (openTickets.length == 0) return;
        uint256 idx = k % openTickets.length;
        uint256 ticket = openTickets[idx];
        vm.prank(engine.queuedSell(ticket).seller);
        try engine.cancelQueued(ticket) {
            openTickets[idx] = openTickets[openTickets.length - 1];
            openTickets.pop();
        } catch (bytes memory err) {
            _check(err);
        }
        _trackNorms();
    }

    function accrueAll() external {
        try engine.accrueMany(ids) {} catch (bytes memory err) {
            _check(err);
        }
        _trackNorms();
    }

    function movePrice(uint256 s, int256 bps) external {
        address stock = stockList[s % stockList.length];
        bps = bound(bps, -300, 300);
        (uint256 px,,,,) = guard.px(stock);
        uint256 next = uint256(int256(px) * (10_000 + bps) / 10_000);
        if (next < 50e18 || next > 300e18) return;
        guard.setS(stock, next);
    }

    function setSession(uint256 s, uint8 kind) external {
        guard.setSession(stockList[s % stockList.length], SessionKind(bound(kind, 0, 4)));
    }

    function warp(uint256 dt) external {
        skip(bound(dt, 1, 12 hours));
    }

    function openTicketCount() external view returns (uint256) {
        return openTickets.length;
    }

    function openTicketAt(uint256 i) external view returns (uint256) {
        return openTickets[i];
    }
}
