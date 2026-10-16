// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {Vm} from "forge-std/Vm.sol";
import {AgentRouter} from "../src/AgentRouter.sol";
import {IAgentRouter} from "../src/interfaces/IAgentRouter.sol";
import {IOptionEngine} from "../src/interfaces/IOptionEngine.sol";
import {ISeriesRegistry} from "../src/interfaces/ISeriesRegistry.sol";
import {SessionKind} from "../src/libs/OptionTypes.sol";
import {EngineBase} from "./engine/EngineBase.sol";

/// @dev An engine that calls back into the router from `buy` (R7: the router's entry points are nonReentrant).
contract ReentrantEngine {
    IERC20 public usdg;
    ISeriesRegistry public registry;
    AgentRouter public router;
    address public owner;

    constructor(IERC20 usdg_, ISeriesRegistry registry_) {
        usdg = usdg_;
        registry = registry_;
    }

    function arm(AgentRouter router_, address owner_) external {
        router = router_;
        owner = owner_;
    }

    function buy(bytes32 id, uint128 units, uint128 maxCost, uint64 deadline, address) external returns (uint256, uint256) {
        router.buyFor(owner, id, units, maxCost, deadline);
        return (0, 0);
    }

    /// @dev The router prices a buy with the engine's quote before pulling USDG.
    function quote(bytes32, uint256, bool) external pure returns (IOptionEngine.Quote memory q) {
        q.usdg = 1;
    }
}

/// @notice Todo 09: AgentRouter R1 to R10 against the real engine, registry and option tokens.
contract AgentRouterTest is EngineBase {
    AgentRouter internal router;
    address internal agent = makeAddr("agent");
    address internal owner; // alice, funded by EngineBase
    bytes32 internal callN; // NVDA Weekly Up 100
    bytes32 internal callT; // TSLA Weekly Up 200

    uint128 internal constant BUDGET = 100e6;
    uint128 internal constant PER_TRADE = 40e6;

    function setUp() public override {
        super.setUp();
        owner = alice;
        router = new AgentRouter(address(engine));
        callN = _list(address(nvda), true, 100e18, WEEKLY);
        callT = _list(address(tsla), true, 200e18, WEEKLY);
        vm.prank(owner);
        usdg.approve(address(router), type(uint256).max);
        _setPolicy(BUDGET, PER_TRADE, true, true, _one(address(nvda)));
    }

    // ----------------------------------------------------------------------------------------------- helpers

    function _one(address a) internal pure returns (address[] memory s) {
        s = new address[](1);
        s[0] = a;
    }

    function _setPolicy(uint128 budget, uint128 perTrade, bool canSell, bool canShield, address[] memory stocks) internal {
        vm.prank(owner);
        router.setPolicy(agent, budget, perTrade, uint64(vm.getBlockTimestamp() + 7 days), canSell, canShield, stocks);
    }

    function _now() internal view returns (uint64) {
        return uint64(vm.getBlockTimestamp());
    }

    function _agentBuy(bytes32 id, uint256 units) internal returns (uint256 cost, uint256 tokens) {
        vm.prank(agent);
        return router.buyFor(owner, id, uint128(units), type(uint128).max, _now());
    }

    function _approveTokens(bytes32 id) internal {
        IERC20 t = _token(id);
        vm.prank(owner);
        t.approve(address(router), type(uint256).max);
    }

    function _spent() internal view returns (uint256) {
        return router.policyOf(owner, agent).spentUsdg;
    }

    // ------------------------------------------------------------------------------------- R1 budgetEnforced

    function test_R1_budgetEnforced() public {
        (uint256 c1,) = _agentBuy(callN, 10e18); // ~2.5 USDG per unit -> ~25 USDG
        assertGt(c1, 0);
        assertEq(_spent(), c1);
        (uint256 c2,) = _agentBuy(callN, 10e18);
        (uint256 c3,) = _agentBuy(callN, 10e18);
        assertEq(_spent(), c1 + c2 + c3);
        assertLe(_spent(), BUDGET);
        // The fourth buy of the same size no longer fits the remaining budget.
        uint256 spent = _spent();
        vm.expectPartialRevert(IAgentRouter.BudgetExceeded.selector);
        vm.prank(agent);
        router.buyFor(owner, callN, 10e18, type(uint128).max, _now());
        assertEq(_spent(), spent);
        assertEq(router.remainingBudget(owner, agent), BUDGET - spent);
    }

    function test_R1_maxPerTradeEnforced() public {
        // ~20 units ~ 50 USDG > 40 USDG per trade, though the budget (100) would allow it.
        vm.expectPartialRevert(IAgentRouter.MaxPerTradeExceeded.selector);
        vm.prank(agent);
        router.buyFor(owner, callN, 20e18, type(uint128).max, _now());
        assertEq(_spent(), 0);
    }

    function test_R1_budgetFullyUsedRevertsBeforeAnyPull() public {
        _setPolicy(0, PER_TRADE, true, true, _one(address(nvda)));
        vm.expectRevert(abi.encodeWithSelector(IAgentRouter.BudgetExceeded.selector, 0, 0, 0));
        vm.prank(agent);
        router.buyFor(owner, callN, 1e18, type(uint128).max, _now());
    }

    function test_R1_userSlippageStillBubbles() public {
        // The agent's own max cost is the tightest limit: the engine's Slippage comes through unchanged.
        vm.expectPartialRevert(IOptionEngine.Slippage.selector);
        vm.prank(agent);
        router.buyFor(owner, callN, 1e18, 1, _now());
    }

    // ------------------------------------------------------------------------------------ R2 expiryAndRevoke

    function test_R2_expiry() public {
        _agentBuy(callN, 1e18);
        _approveTokens(callN);
        uint64 exp = router.policyOf(owner, agent).expiresAt;
        vm.warp(exp);
        _setVol(address(nvda), 5000, 0);
        nvda.mint(owner, 1e18);
        vm.startPrank(agent);
        vm.expectRevert(abi.encodeWithSelector(IAgentRouter.PolicyExpired.selector, exp));
        router.buyFor(owner, callN, 1e18, type(uint128).max, _now());
        vm.expectRevert(abi.encodeWithSelector(IAgentRouter.PolicyExpired.selector, exp));
        router.sellFor(owner, callN, 1e17, 0, _now());
        vm.expectRevert(abi.encodeWithSelector(IAgentRouter.PolicyExpired.selector, exp));
        router.shieldFor(owner, address(nvda), 1e18, 500, type(uint128).max, _now());
        vm.stopPrank();
    }

    function test_R2_revokeIsImmediateAndCannotBeBlocked() public {
        _agentBuy(callN, 1e18);
        _approveTokens(callN);
        // Even with USDG paused by its issuer the revoke goes through: it makes no external call.
        usdg.setPaused(true);
        vm.prank(owner);
        router.revoke(agent);
        usdg.setPaused(false);
        assertTrue(router.policyOf(owner, agent).revoked);
        vm.startPrank(agent);
        vm.expectRevert(abi.encodeWithSelector(IAgentRouter.PolicyIsRevoked.selector, owner, agent));
        router.buyFor(owner, callN, 1e18, type(uint128).max, _now());
        vm.expectRevert(abi.encodeWithSelector(IAgentRouter.PolicyIsRevoked.selector, owner, agent));
        router.sellFor(owner, callN, 1e17, 0, _now());
        vm.expectRevert(abi.encodeWithSelector(IAgentRouter.PolicyIsRevoked.selector, owner, agent));
        router.shieldFor(owner, address(nvda), 1e18, 500, type(uint128).max, _now());
        vm.stopPrank();
    }

    function test_R2_noPolicy() public {
        address stranger = makeAddr("stranger");
        vm.expectRevert(abi.encodeWithSelector(IAgentRouter.NoPolicy.selector, owner, stranger));
        vm.prank(stranger);
        router.buyFor(owner, callN, 1e18, type(uint128).max, _now());
    }

    // ------------------------------------------------------------------------------------ R3 allowedNamesOnly

    function test_R3_allowedNamesOnly() public {
        vm.expectRevert(abi.encodeWithSelector(IAgentRouter.StockNotAllowed.selector, address(tsla)));
        vm.prank(agent);
        router.buyFor(owner, callT, 1e18, type(uint128).max, _now());

        // The owner holds TSLA options bought directly; the agent may not sell them.
        _buy(owner, callT, 1e18);
        _approveTokens(callT);
        vm.expectRevert(abi.encodeWithSelector(IAgentRouter.StockNotAllowed.selector, address(tsla)));
        vm.prank(agent);
        router.sellFor(owner, callT, 1e17, 0, _now());

        tsla.mint(owner, 1e18);
        vm.expectRevert(abi.encodeWithSelector(IAgentRouter.StockNotAllowed.selector, address(tsla)));
        vm.prank(agent);
        router.shieldFor(owner, address(tsla), 1e18, 500, type(uint128).max, _now());
    }

    function test_R3_newPolicyReplacesTheList() public {
        _setPolicy(BUDGET, PER_TRADE, true, true, _one(address(tsla)));
        assertFalse(router.isAllowedStock(owner, agent, address(nvda)));
        assertTrue(router.isAllowedStock(owner, agent, address(tsla)));
        vm.expectRevert(abi.encodeWithSelector(IAgentRouter.StockNotAllowed.selector, address(nvda)));
        vm.prank(agent);
        router.buyFor(owner, callN, 1e18, type(uint128).max, _now());
        _agentBuy(callT, 1e17);
    }

    // ------------------------------------------------------------------------------------ R4 recipientIsOwner

    function test_R4_recipientIsOwner() public {
        uint256 ownerUsdg0 = usdg.balanceOf(owner);
        (uint256 cost, uint256 tokens) = _agentBuy(callN, 5e18);
        assertEq(_token(callN).balanceOf(owner), tokens, "tokens minted to the owner");
        assertEq(usdg.balanceOf(owner), ownerUsdg0 - cost, "owner paid exactly the cost");
        _assertNothingStuck(callN);

        _approveTokens(callN);
        uint256 ownerUsdg1 = usdg.balanceOf(owner);
        vm.prank(agent);
        uint256 proceeds = router.sellFor(owner, callN, uint128(tokens / 2), 0, _now());
        assertGt(proceeds, 0);
        assertEq(usdg.balanceOf(owner), ownerUsdg1 + proceeds, "proceeds paid to the owner");
        assertEq(_token(callN).balanceOf(owner), tokens - tokens / 2);
        _assertNothingStuck(callN);
    }

    function test_R4_shieldForOwner() public {
        bytes32 p95 = _list(address(nvda), false, 95e18, WEEKLY);
        bytes32 p90 = _list(address(nvda), false, 90e18, WEEKLY);
        nvda.mint(owner, 10e18);

        // The router picks exactly what the engine's own shield picks.
        uint256 snap = vm.snapshotState();
        vm.prank(owner);
        (bytes32 engineId, uint256 engineCost) = engine.shield(address(nvda), 10e18, 700, type(uint128).max, _now());
        vm.revertToState(snap);

        vm.prank(agent);
        (bytes32 id, uint256 cost) = router.shieldFor(owner, address(nvda), 10e18, 700, type(uint128).max, _now());
        assertEq(id, engineId);
        assertEq(id, p90);
        assertEq(cost, engineCost);
        assertEq(_token(p90).balanceOf(owner), 10e18);
        assertEq(_spent(), cost);
        _assertNothingStuck(p90);
        _assertNothingStuck(p95);

        vm.prank(agent);
        (id,) = router.shieldFor(owner, address(nvda), 5e18, 500, type(uint128).max, _now());
        assertEq(id, p95);
    }

    function test_R4_shieldNeedsOwnersHolding() public {
        _list(address(nvda), false, 95e18, WEEKLY);
        nvda.mint(agent, 10e18); // the agent's own holding does not count
        vm.expectRevert(abi.encodeWithSelector(IOptionEngine.ShieldExceedsHolding.selector, 0, 1e18));
        vm.prank(agent);
        router.shieldFor(owner, address(nvda), 1e18, 500, type(uint128).max, _now());
    }

    function test_R4_queuedSellStaysTheOwners() public {
        (, uint256 tokens) = _agentBuy(callN, 4e18);
        _approveTokens(callN);
        guard.setSession(address(nvda), SessionKind.HALTED);
        vm.prank(agent);
        uint256 proceeds = router.sellFor(owner, callN, uint128(tokens), 0, _now());
        assertEq(proceeds, 0);
        uint256 ticket = engine.ticketCount();
        assertEq(router.ticketOwner(ticket), owner);
        assertEq(engine.queuedSell(ticket).recipient, owner, "fill pays the owner");

        vm.expectRevert(abi.encodeWithSelector(IAgentRouter.NotTicketOwner.selector, ticket));
        vm.prank(agent);
        router.cancelQueuedFor(ticket);

        vm.prank(owner);
        router.cancelQueuedFor(ticket);
        assertEq(_token(callN).balanceOf(owner), tokens, "escrow back to the owner");
        assertEq(router.ticketOwner(ticket), address(0));
        _assertNothingStuck(callN);
    }

    function _assertNothingStuck(bytes32 id) internal view {
        assertEq(usdg.balanceOf(agent), 0, "agent USDG");
        assertEq(_token(id).balanceOf(agent), 0, "agent tokens");
        assertEq(usdg.balanceOf(address(router)), 0, "router USDG");
        assertEq(_token(id).balanceOf(address(router)), 0, "router tokens");
        assertEq(usdg.allowance(address(router), address(engine)), 0, "router allowance");
    }

    // -------------------------------------------------------------------------- R5 noOwnerFundsBeyondApproval

    function test_R5_needsOwnerApproval() public {
        vm.prank(owner);
        usdg.approve(address(router), 0);
        vm.expectRevert();
        vm.prank(agent);
        router.buyFor(owner, callN, 1e18, type(uint128).max, _now());
    }

    function test_R5_pullsAtMostThePolicyLimit() public {
        // The owner approved only the per-trade limit: enough, because the router never pulls more than that.
        vm.prank(owner);
        usdg.approve(address(router), PER_TRADE);
        (uint256 cost,) = _agentBuy(callN, 10e18);
        assertEq(usdg.allowance(owner, address(router)), PER_TRADE - cost, "pulled exactly the cost");
        assertGt(PER_TRADE, cost);
        assertEq(_spent(), cost, "net spend is the actual cost");
    }

    /// todo 23 (fork run): the website approves exactly the budget. The router used to pull each trade's whole limit
    /// (min of maxCost, per-trade and remaining budget) and refund the rest, which does not give the allowance back,
    /// so a budget-sized approval ran out long before the budget (InsufficientAllowance on the 3rd small buy). It now
    /// pulls exactly the engine's quote, which equals the execution cost to the wei.
    function test_R5_budgetSizedApprovalLastsTheWholeBudget() public {
        vm.prank(owner);
        usdg.approve(address(router), BUDGET);
        uint256 total;
        for (uint256 i; i < 6; ++i) {
            (uint256 cost,) = _agentBuy(callN, 5e18); // ~12 USDG each, agent passes no max cost of its own
            total += cost;
            assertEq(usdg.allowance(owner, address(router)), BUDGET - total, "allowance follows the spend");
        }
        assertEq(_spent(), total);
        assertGt(total, BUDGET / 2, "more than half the budget used on one budget-sized approval");
    }

    function test_R5_canSellFalseBlocksSells() public {
        _setPolicy(BUDGET, PER_TRADE, false, true, _one(address(nvda)));
        _agentBuy(callN, 1e18);
        _approveTokens(callN);
        vm.expectRevert(IAgentRouter.SellNotAllowed.selector);
        vm.prank(agent);
        router.sellFor(owner, callN, 1e17, 0, _now());
    }

    function test_R5_canShieldFalseBlocksShield() public {
        _setPolicy(BUDGET, PER_TRADE, true, false, _one(address(nvda)));
        nvda.mint(owner, 1e18);
        vm.expectRevert(IAgentRouter.ShieldNotAllowed.selector);
        vm.prank(agent);
        router.shieldFor(owner, address(nvda), 1e18, 500, type(uint128).max, _now());
    }

    function test_R5_sellNeedsOptionTokenApproval() public {
        (, uint256 tokens) = _agentBuy(callN, 1e18);
        vm.expectRevert();
        vm.prank(agent);
        router.sellFor(owner, callN, uint128(tokens), 0, _now());
        assertEq(_token(callN).balanceOf(owner), tokens);
    }

    function test_R5_sellsDoNotSpendBudget() public {
        (uint256 cost, uint256 tokens) = _agentBuy(callN, 2e18);
        _approveTokens(callN);
        vm.prank(agent);
        router.sellFor(owner, callN, uint128(tokens), 0, _now());
        assertEq(_spent(), cost);
    }

    // ------------------------------------------------------------------------------- R6 agentCannotSetPolicy

    function test_R6_agentCannotSetPolicy() public {
        IAgentRouter.Policy memory before = router.policyOf(owner, agent);
        // The agent can only write policies where it is the owner.
        vm.prank(agent);
        router.setPolicy(makeAddr("other"), type(uint128).max, type(uint128).max, type(uint64).max, true, true, _one(address(tsla)));
        IAgentRouter.Policy memory afterP = router.policyOf(owner, agent);
        assertEq(afterP.budgetUsdg, before.budgetUsdg);
        assertEq(afterP.maxPerTradeUsdg, before.maxPerTradeUsdg);
        assertFalse(router.isAllowedStock(owner, agent, address(tsla)));
        // Nor give itself a policy over itself, nor undo a revoke.
        vm.expectRevert(IAgentRouter.InvalidPolicy.selector);
        vm.prank(agent);
        router.setPolicy(agent, 1, 1, type(uint64).max, true, true, _one(address(nvda)));
        vm.prank(owner);
        router.revoke(agent);
        vm.prank(agent);
        router.revoke(agent);
        assertTrue(router.policyOf(owner, agent).revoked);
    }

    function test_R6_reSetKeepsSpendAndClearsRevoke() public {
        (uint256 cost,) = _agentBuy(callN, 1e18);
        vm.prank(owner);
        router.revoke(agent);
        _setPolicy(BUDGET, PER_TRADE, true, true, _one(address(nvda)));
        IAgentRouter.Policy memory p = router.policyOf(owner, agent);
        assertFalse(p.revoked);
        assertEq(p.spentUsdg, cost, "lifetime spend survives a new policy");
        _agentBuy(callN, 1e18);
    }

    // --------------------------------------------------------------------------- R7 reentrancyAndRounding

    function test_R7_nonReentrant() public {
        ReentrantEngine bad = new ReentrantEngine(IERC20(address(usdg)), registry);
        AgentRouter r2 = new AgentRouter(address(bad));
        bad.arm(r2, owner);
        vm.startPrank(owner);
        usdg.approve(address(r2), type(uint256).max);
        r2.setPolicy(address(bad), BUDGET, PER_TRADE, type(uint64).max, true, true, _one(address(nvda)));
        r2.setPolicy(agent, BUDGET, PER_TRADE, type(uint64).max, true, true, _one(address(nvda)));
        vm.stopPrank();
        vm.expectRevert(ReentrancyGuardTransient.ReentrancyGuardReentrantCall.selector);
        vm.prank(agent);
        r2.buyFor(owner, callN, 1e18, type(uint128).max, _now());
    }

    function test_R7_spentCountsActualCost() public {
        uint256 bal = usdg.balanceOf(owner);
        (uint256 cost,) = _agentBuy(callN, 3_333_333_333_333_333_333);
        assertEq(bal - usdg.balanceOf(owner), cost);
        assertEq(_spent(), cost);
    }

    // ------------------------------------------------------------------------------------------ R8 fuzzBudget

    function testFuzz_R8_budgetNeverExceeded(uint256 seed, uint128 budget, uint128 perTrade) public {
        budget = uint128(bound(budget, 0, 200e6));
        perTrade = uint128(bound(perTrade, 0, 80e6));
        _setPolicy(budget, perTrade, true, true, _one(address(nvda)));
        uint256 bal = usdg.balanceOf(owner);
        uint256 sum;
        for (uint256 i; i < 12; ++i) {
            seed = uint256(keccak256(abi.encode(seed, i)));
            uint256 units = bound(seed, 1e15, 30e18);
            vm.prank(agent);
            try router.buyFor(owner, callN, uint128(units), type(uint128).max, _now()) returns (uint256 cost, uint256) {
                assertLe(cost, perTrade, "per trade");
                sum += cost;
            } catch {}
            assertLe(_spent(), budget, "budget");
            assertEq(_spent(), sum, "spent = sum of actual costs");
            assertEq(bal - usdg.balanceOf(owner), sum, "owner paid exactly the spend");
            assertEq(usdg.balanceOf(address(router)), 0);
        }
    }

    // ------------------------------------------------------------------------------------------ R9 policyViews

    function test_R9_policyViews() public {
        address[] memory s = new address[](3);
        s[0] = address(nvda);
        s[1] = address(tsla);
        s[2] = address(nvda); // duplicate collapsed
        uint64 exp = _now() + 1 days;
        vm.prank(owner);
        router.setPolicy(agent, 50e6, 10e6, exp, false, true, s);
        IAgentRouter.Policy memory p = router.policyOf(owner, agent);
        assertEq(p.agent, agent);
        assertEq(p.budgetUsdg, 50e6);
        assertEq(p.maxPerTradeUsdg, 10e6);
        assertEq(p.expiresAt, exp);
        assertFalse(p.canSell);
        assertTrue(p.canShield);
        assertFalse(p.revoked);
        assertTrue(router.isAllowedStock(owner, agent, address(nvda)));
        assertTrue(router.isAllowedStock(owner, agent, address(tsla)));
        assertFalse(router.isAllowedStock(owner, makeAddr("x"), address(nvda)));
        assertEq(router.allowedStocks(owner, agent).length, 2);
        assertEq(router.remainingBudget(owner, agent), 50e6);
        (uint256 cost,) = _agentBuy(callN, 1e18);
        assertEq(router.remainingBudget(owner, agent), 50e6 - cost);
        assertEq(router.engine(), address(engine));
        assertEq(address(router.USDG()), address(usdg));
    }

    // ------------------------------------------------------------------------------------------ R10 eventShapes

    function test_R10_eventShapes() public {
        // Exact signatures the indexer and API decode (todo 15b).
        assertEq(
            IAgentRouter.PolicySet.selector,
            keccak256("PolicySet(address,address,uint128,uint128,uint64,bool,bool)")
        );
        assertEq(IAgentRouter.PolicyRevoked.selector, keccak256("PolicyRevoked(address,address)"));
        assertEq(IAgentRouter.PolicyStocks.selector, keccak256("PolicyStocks(address,address,address[])"));
        assertEq(IAgentRouter.AgentTrade.selector, keccak256("AgentTrade(address,address,bytes32,bool,uint256)"));

        uint64 exp = _now() + 3 days;
        address[] memory s = _one(address(nvda));
        vm.expectEmit(true, true, false, true, address(router));
        emit IAgentRouter.PolicySet(owner, agent, 70e6, 30e6, exp, true, false);
        vm.expectEmit(true, true, false, true, address(router));
        emit IAgentRouter.PolicyStocks(owner, agent, s);
        vm.prank(owner);
        router.setPolicy(agent, 70e6, 30e6, exp, true, false, s);

        vm.recordLogs();
        (uint256 cost,) = _agentBuy(callN, 1e18);
        _expectTrade(callN, true, cost);

        _approveTokens(callN);
        vm.recordLogs();
        vm.prank(agent);
        uint256 proceeds = router.sellFor(owner, callN, 1e17, 0, _now());
        _expectTrade(callN, false, proceeds);

        vm.expectEmit(true, true, false, true, address(router));
        emit IAgentRouter.PolicyRevoked(owner, agent);
        vm.prank(owner);
        router.revoke(agent);
    }

    function _expectTrade(bytes32 id, bool isBuy, uint256 usdgAmount) internal {
        Vm.Log[] memory logs = vm.getRecordedLogs();
        Vm.Log memory last = logs[logs.length - 1];
        assertEq(last.emitter, address(router));
        assertEq(last.topics[0], IAgentRouter.AgentTrade.selector);
        assertEq(last.topics[1], bytes32(uint256(uint160(owner))));
        assertEq(last.topics[2], bytes32(uint256(uint160(agent))));
        assertEq(last.topics[3], id);
        (bool b, uint256 u) = abi.decode(last.data, (bool, uint256));
        assertEq(b, isBuy);
        assertEq(u, usdgAmount);
    }

    // ------------------------------------------------------------------------------------------------- gas

    function test_gas_routerVsDirect() public {
        _approveTokens(callN);
        _buy(bob, callN, 1e18); // warm the series
        vm.prank(bob);
        uint256 g0 = gasleft();
        engine.buy(callN, 1e18, type(uint128).max, _now(), bob);
        uint256 direct = g0 - gasleft();
        vm.prank(agent);
        g0 = gasleft();
        router.buyFor(owner, callN, 1e18, type(uint128).max, _now());
        uint256 viaRouter = g0 - gasleft();
        vm.prank(agent);
        g0 = gasleft();
        router.sellFor(owner, callN, 5e17, 0, _now());
        uint256 sellGas = g0 - gasleft();
        _list(address(nvda), false, 95e18, WEEKLY);
        nvda.mint(owner, 1e18);
        vm.prank(agent);
        g0 = gasleft();
        router.shieldFor(owner, address(nvda), 1e18, 500, type(uint128).max, _now());
        uint256 shieldGas = g0 - gasleft();
        emit log_named_uint("engine.buy direct", direct);
        emit log_named_uint("router.buyFor", viaRouter);
        emit log_named_uint("router.sellFor", sellGas);
        emit log_named_uint("router.shieldFor (first, 1 candidate)", shieldGas);
    }
}
