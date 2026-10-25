// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {AgentRouter} from "../../src/AgentRouter.sol";
import {EngineBase} from "../engine/EngineBase.sol";
import {SessionKind} from "../../src/libs/OptionTypes.sol";

/// @notice Round-2 review R04 (MEDIUM): AgentRouter was one shared account for the F01 hold, so one agent user's
/// recent buy repriced every other agent user's sells through the router. The engine now sells as the owner
/// (`engine.sellFor`, only the configured router): balance, hold, size rule, fee tier and ticket are the owner's.
contract R04RouterOwnerSellTest is EngineBase {
    AgentRouter internal router;
    address internal agent = makeAddr("agent");
    address internal carol = makeAddr("carol");
    bytes32 internal callN;

    function setUp() public override {
        super.setUp();
        router = new AgentRouter(address(engine));
        vm.prank(admin);
        engine.setAgentRouter(address(router));
        callN = _list(address(nvda), true, 100e18, WEEKLY);
        _fund(carol);
        address[] memory s = new address[](1);
        s[0] = address(nvda);
        address[3] memory owners = [alice, bob, carol];
        for (uint256 i; i < 3; ++i) {
            vm.startPrank(owners[i]);
            usdg.approve(address(router), type(uint256).max);
            router.setPolicy(agent, type(uint128).max, type(uint128).max, uint64(T0 + 365 days), true, true, s);
            vm.stopPrank();
        }
    }

    function _agentBuy(address owner, uint256 units) internal returns (uint256 tokens) {
        vm.prank(agent);
        (, tokens) = router.buyFor(owner, callN, uint128(units), type(uint128).max, uint64(vm.getBlockTimestamp()));
    }

    function _agentSell(address owner, uint256 tokens) internal returns (uint256) {
        vm.prank(agent);
        return router.sellFor(owner, callN, uint128(tokens), 0, uint64(vm.getBlockTimestamp()));
    }

    /// @dev What `owner` selling `tokens` directly would get right now (state rolled back afterwards).
    function _directProceeds(address owner, uint256 tokens) internal returns (uint256 p) {
        uint256 snap = vm.snapshotState();
        p = _sell(owner, callN, tokens);
        vm.revertToState(snap);
    }

    /// @dev Reviewer PoC: bob held 1,000 units for 2 h; alice's agent buys 10 and sells them through the router 5 min
    /// later; NVDA 100 -> 103; bob's agent sell paid $2,351 against $4,251 direct (-45%). Now equal.
    function test_R04_otherUsersRouterBuyDoesNotRepriceMySell() public {
        (, uint256 bobTokens) = _buy(bob, callN, 1_000e18);
        skip(2 hours);
        uint256 aliceTokens = _agentBuy(alice, 10e18);
        skip(5 minutes);
        _agentSell(alice, aliceTokens);
        guard.setS(address(nvda), 103e18);
        uint256 direct = _directProceeds(bob, bobTokens);
        uint256 viaRouter = _agentSell(bob, bobTokens);
        assertEq(viaRouter, direct, "router sell pays exactly the direct sell");
        assertGt(viaRouter, 4_000e6, "not priced at alice's buy S");
    }

    /// @dev Tickets queued through the router belong to the owner and fill on the owner's own hold.
    function test_R04_queuedRouterSellFillsOnTheOwnersHold() public {
        (, uint256 bobTokens) = _buy(bob, callN, 1_000e18);
        skip(2 hours);
        _agentBuy(alice, 10e18); // alice's hold opens at S = 100
        guard.setSession(address(nvda), SessionKind.HALTED);
        _agentSell(bob, bobTokens);
        uint256 ticket = engine.ticketCount();
        assertEq(engine.queuedSell(ticket).seller, bob);
        guard.setSession(address(nvda), SessionKind.REGULAR);
        guard.setS(address(nvda), 103e18);
        uint256 snap = vm.snapshotState();
        uint256 filled = engine.fillQueued(ticket);
        vm.revertToState(snap);
        uint256 direct = _directProceedsAfterCancel(bob, ticket, bobTokens);
        assertEq(filled, direct, "fill priced on bob's own (empty) hold");
    }

    function _directProceedsAfterCancel(address owner, uint256 ticket, uint256 tokens) internal returns (uint256 p) {
        uint256 snap = vm.snapshotState();
        vm.prank(owner);
        engine.cancelQueued(ticket);
        p = _sell(owner, callN, tokens);
        vm.revertToState(snap);
    }

    /// @dev PROPERTY: for owners A != B using the same router, B's sellFor proceeds equal B selling directly, whatever
    /// A (and strangers) did through the router and to the router's balance before.
    function testFuzz_R04_ownersSellIndependentOfOthers(uint256 seed, uint8 steps, uint16 moveBps) public {
        (, uint256 bobTokens) = _buy(bob, callN, 500e18);
        skip(2 hours);
        steps = uint8(bound(steps, 1, 8));
        for (uint256 i; i < steps; ++i) {
            uint256 r = uint256(keccak256(abi.encode(seed, i)));
            uint256 kind = r % 4;
            address a = r % 7 < 4 ? alice : carol;
            if (kind == 0) {
                _agentBuy(a, bound(r >> 8, 2e18, 50e18));
            } else if (kind == 1) {
                uint256 bal = _token(callN).balanceOf(a);
                if (bal != 0) _agentSell(a, bal);
            } else if (kind == 2) {
                // a stranger's tokens sent to the router (free tokens only: held tokens cannot move, R02)
                (, uint256 t) = _buy(a, callN, 3e18);
                skip(31 minutes);
                IERC20 tk = _token(callN);
                vm.prank(a);
                tk.transfer(address(router), t / 3);
            } else {
                skip(bound(r >> 16, 1, 20 minutes));
            }
        }
        moveBps = uint16(bound(moveBps, 0, 800));
        guard.setS(address(nvda), 100e18 + 100e18 * uint256(moveBps) / 10_000);
        uint256 direct = _directProceeds(bob, bobTokens);
        assertEq(_agentSell(bob, bobTokens), direct, "B's proceeds independent of A's actions");
    }

}
