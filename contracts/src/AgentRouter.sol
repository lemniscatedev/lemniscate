// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {IAgentRouter} from "./interfaces/IAgentRouter.sol";
import {IOptionEngine} from "./interfaces/IOptionEngine.sol";
import {IPriceGuard} from "./interfaces/IPriceGuard.sol";
import {ISeriesRegistry} from "./interfaces/ISeriesRegistry.sol";
import {PriceReading, Series} from "./libs/OptionTypes.sol";

/// @dev The engine views the router needs beyond IOptionEngine (LemniscateEngine exposes all of them).
interface IAgentRouterEngine {
    function usdg() external view returns (IERC20);
    function registry() external view returns (ISeriesRegistry);
    function priceGuard() external view returns (IPriceGuard);
    function shieldList(address stock) external view returns (bytes32[] memory);
    function ticketCount() external view returns (uint256);
    function syncSeries(uint256 maxCount) external;
}

/// @title AgentRouter
/// @notice Lets an agent key buy, sell and Shield for an owner within the owner's on-chain policy. No admin, no
/// upgrade, holds no funds between transactions: USDG pulled for a buy is spent or refunded in the same call, tokens are
/// minted straight to the owner and sale proceeds are paid straight to the owner by the engine.
contract AgentRouter is IAgentRouter, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    uint256 private constant BPS = 10_000;
    /// @dev Same batch the engine's `shield` syncs before picking (EngineTradeLib.SYNC_BATCH).
    uint256 private constant SYNC_BATCH = 64;

    IOptionEngine private immutable ENGINE;
    IERC20 public immutable USDG;
    ISeriesRegistry public immutable REGISTRY;

    mapping(address owner => mapping(address agent => Policy)) private _policies;
    /// @dev Allowed names: a stock is allowed when its stamp equals the policy's current generation.
    mapping(address owner => mapping(address agent => uint256)) private _generation;
    mapping(address owner => mapping(address agent => mapping(address stock => uint256))) private _allowedAt;
    mapping(address owner => mapping(address agent => address[])) private _stocks;

    struct Ticket {
        address owner;
        address token;
    }

    mapping(uint256 ticket => Ticket) private _tickets;

    constructor(address engine_) {
        ENGINE = IOptionEngine(engine_);
        USDG = IAgentRouterEngine(engine_).usdg();
        REGISTRY = IAgentRouterEngine(engine_).registry();
    }

    // ------------------------------------------------------------------------------------------------- owner

    /// @inheritdoc IAgentRouter
    function setPolicy(
        address agent,
        uint128 budgetUsdg,
        uint128 maxPerTradeUsdg,
        uint64 expiresAt,
        bool canSell,
        bool canShield,
        address[] calldata stocks
    ) external {
        if (agent == address(0) || agent == msg.sender) revert InvalidPolicy();
        Policy storage p = _policies[msg.sender][agent];
        p.agent = agent;
        p.budgetUsdg = budgetUsdg;
        p.maxPerTradeUsdg = maxPerTradeUsdg;
        p.expiresAt = expiresAt;
        p.canSell = canSell;
        p.canShield = canShield;
        p.revoked = false;

        uint256 gen = ++_generation[msg.sender][agent];
        mapping(address => uint256) storage allowed = _allowedAt[msg.sender][agent];
        delete _stocks[msg.sender][agent];
        address[] storage list = _stocks[msg.sender][agent];
        for (uint256 i; i < stocks.length; ++i) {
            if (allowed[stocks[i]] == gen) continue; // duplicate
            allowed[stocks[i]] = gen;
            list.push(stocks[i]);
        }
        emit PolicySet(msg.sender, agent, budgetUsdg, maxPerTradeUsdg, expiresAt, canSell, canShield);
        emit PolicyStocks(msg.sender, agent, list);
    }

    /// @inheritdoc IAgentRouter
    function revoke(address agent) external {
        _policies[msg.sender][agent].revoked = true;
        emit PolicyRevoked(msg.sender, agent);
    }

    /// @inheritdoc IAgentRouter
    function cancelQueuedFor(uint256 ticket) external nonReentrant {
        Ticket memory t = _tickets[ticket];
        if (t.owner != msg.sender) revert NotTicketOwner(ticket);
        delete _tickets[ticket];
        uint256 before = IERC20(t.token).balanceOf(address(this));
        ENGINE.cancelQueued(ticket);
        IERC20(t.token).safeTransfer(msg.sender, IERC20(t.token).balanceOf(address(this)) - before);
    }

    // ------------------------------------------------------------------------------------------------- agent

    /// @inheritdoc IAgentRouter
    function buyFor(address owner, bytes32 seriesId, uint128 units, uint128 maxCostUsdg, uint64 deadline)
        external
        nonReentrant
        returns (uint256 cost, uint256 tokens)
    {
        Policy storage p = _active(owner);
        _requireStock(owner, REGISTRY.seriesOf(seriesId).stock);
        (cost, tokens) = _buy(p, owner, seriesId, units, maxCostUsdg, deadline);
        emit AgentTrade(owner, msg.sender, seriesId, true, cost);
    }

    /// @inheritdoc IAgentRouter
    function sellFor(address owner, bytes32 seriesId, uint128 tokens, uint128 minProceedsUsdg, uint64 deadline)
        external
        nonReentrant
        returns (uint256 proceeds)
    {
        Policy storage p = _active(owner);
        if (!p.canSell) revert SellNotAllowed();
        Series memory s = REGISTRY.seriesOf(seriesId);
        _requireStock(owner, s.stock);

        // `owner` set a policy for msg.sender (_active reverts otherwise) and approved this router; tokens only go to the
        // engine on the owner's behalf. Slither arbitrary-send-erc20 false positive.
        // slither-disable-next-line arbitrary-send-erc20
        IERC20(s.token).safeTransferFrom(owner, address(this), tokens);
        uint256 ticketsBefore = IAgentRouterEngine(address(ENGINE)).ticketCount();
        proceeds = ENGINE.sell(seriesId, tokens, minProceedsUsdg, deadline, owner);
        uint256 ticketsAfter = IAgentRouterEngine(address(ENGINE)).ticketCount();
        if (ticketsAfter != ticketsBefore) {
            // Escrowed by the engine: the router is the ticket's seller, the owner is its recipient and canceller.
            _tickets[ticketsAfter] = Ticket({owner: owner, token: s.token});
            emit QueuedSellFor(ticketsAfter, owner, msg.sender, seriesId);
        }
        emit AgentTrade(owner, msg.sender, seriesId, false, proceeds);
    }

    /// @inheritdoc IAgentRouter
    function shieldFor(
        address owner,
        address stock,
        uint128 tokenUnits,
        uint16 pctBelowBps,
        uint128 maxCostUsdg,
        uint64 deadline
    ) external nonReentrant returns (bytes32 id, uint256 cost) {
        Policy storage p = _active(owner);
        if (!p.canShield) revert ShieldNotAllowed();
        _requireStock(owner, stock);
        if (tokenUnits == 0 || pctBelowBps >= BPS) revert IOptionEngine.BelowMinimum();
        uint256 held = IERC20(stock).balanceOf(owner);
        if (held < tokenUnits) revert IOptionEngine.ShieldExceedsHolding(held, tokenUnits);

        id = _pickShield(stock, pctBelowBps);
        (cost,) = _buy(p, owner, id, tokenUnits, maxCostUsdg, deadline);
        emit AgentTrade(owner, msg.sender, id, true, cost);
    }

    // ------------------------------------------------------------------------------------------------- views

    /// @inheritdoc IAgentRouter
    function policyOf(address owner, address agent) external view returns (Policy memory) {
        return _policies[owner][agent];
    }

    /// @inheritdoc IAgentRouter
    function isAllowedStock(address owner, address agent, address stock) public view returns (bool) {
        uint256 gen = _generation[owner][agent];
        return gen != 0 && _allowedAt[owner][agent][stock] == gen;
    }

    /// @inheritdoc IAgentRouter
    function remainingBudget(address owner, address agent) external view returns (uint256) {
        Policy storage p = _policies[owner][agent];
        return p.spentUsdg >= p.budgetUsdg ? 0 : p.budgetUsdg - p.spentUsdg;
    }

    /// @inheritdoc IAgentRouter
    function allowedStocks(address owner, address agent) external view returns (address[] memory) {
        return _stocks[owner][agent];
    }

    /// @inheritdoc IAgentRouter
    function ticketOwner(uint256 ticket) external view returns (address) {
        return _tickets[ticket].owner;
    }

    /// @inheritdoc IAgentRouter
    function engine() external view returns (address) {
        return address(ENGINE);
    }

    // ---------------------------------------------------------------------------------------------- internal

    /// @dev The caller's live policy for `owner` (msg.sender is the agent).
    function _active(address owner) private view returns (Policy storage p) {
        p = _policies[owner][msg.sender];
        if (p.agent == address(0)) revert NoPolicy(owner, msg.sender);
        if (p.revoked) revert PolicyIsRevoked(owner, msg.sender);
        if (block.timestamp >= p.expiresAt) revert PolicyExpired(p.expiresAt);
    }

    function _requireStock(address owner, address stock) private view {
        if (!isAllowedStock(owner, msg.sender, stock)) revert StockNotAllowed(stock);
    }

    /// @dev Pulls the tightest limit from the owner, buys for the owner, refunds the rest, books the actual cost.
    function _buy(Policy storage p, address owner, bytes32 id, uint128 units, uint128 maxCostUsdg, uint64 deadline)
        private
        returns (uint256 cost, uint256 tokens)
    {
        uint256 spent = p.spentUsdg;
        uint256 budget = p.budgetUsdg;
        uint256 maxPerTrade = p.maxPerTradeUsdg;
        if (spent >= budget) revert BudgetExceeded(spent, 0, budget);
        uint256 limit = Math.min(Math.min(maxCostUsdg, maxPerTrade), budget - spent);
        // Pull exactly what this buy costs: the engine's quote equals the execution to the wei (the trade's own accrual
        // is simulated). Pulling the whole limit and refunding the rest used up the owner's ERC-20 allowance much faster
        // than the budget, so a budget-sized approval ran out early (todo 23). A cost above the limit is reported as the
        // policy error it is, exactly as the engine's Slippage would have been.
        uint256 need = ENGINE.quote(id, units, true).usdg;
        if (need > limit) _explainBuyRevert(abi.encodeWithSelector(IOptionEngine.Slippage.selector, need, limit), spent, budget, maxPerTrade);

        // Same authorisation as sellFor (policy checked by the caller); USDG only pays the owner's own buy.
        // slither-disable-next-line arbitrary-send-erc20
        USDG.safeTransferFrom(owner, address(this), need);
        USDG.forceApprove(address(ENGINE), need);
        uint256 before = USDG.balanceOf(address(this));
        (bool ok, bytes memory ret) = address(ENGINE).call(
            abi.encodeCall(IOptionEngine.buy, (id, units, uint128(need), deadline, owner))
        );
        if (!ok) _explainBuyRevert(ret, spent, budget, maxPerTrade);
        (, tokens) = abi.decode(ret, (uint256, uint256));
        cost = before - USDG.balanceOf(address(this)); // actual USDG the engine took (R7)
        if (cost > maxPerTrade) revert MaxPerTradeExceeded(cost, maxPerTrade);
        if (spent + cost > budget) revert BudgetExceeded(spent, cost, budget);
        USDG.forceApprove(address(ENGINE), 0);
        if (need > cost) USDG.safeTransfer(owner, need - cost);
        p.spentUsdg = uint128(spent + cost);
    }

    /// @dev An engine `Slippage(got, limit)` caused by the policy is reported as the policy error; anything else bubbles.
    function _explainBuyRevert(bytes memory ret, uint256 spent, uint256 budget, uint256 maxPerTrade) private pure {
        if (ret.length == 68 && bytes4(ret) == IOptionEngine.Slippage.selector) {
            uint256 got;
            assembly ("memory-safe") {
                got := mload(add(ret, 36))
            }
            if (got > maxPerTrade) revert MaxPerTradeExceeded(got, maxPerTrade);
            if (spent + got > budget) revert BudgetExceeded(spent, got, budget);
        }
        assembly ("memory-safe") {
            revert(add(ret, 32), mload(ret))
        }
    }

    /// @dev The engine's `shield` choice: the largest buyable, non-archived Weekly Down strike <= S x (1 - pct). S is
    /// the same PriceGuard value the engine reads (readLite has the same S as read; the engine's buy still applies the
    /// full read, TWAP check included).
    function _pickShield(address stock, uint16 pctBelowBps) private returns (bytes32 best) {
        IAgentRouterEngine e = IAgentRouterEngine(address(ENGINE));
        e.syncSeries(SYNC_BATCH);
        PriceReading memory r = e.priceGuard().readLite(stock);
        if (r.s == 0 || r.s > type(uint128).max) revert IOptionEngine.StalePrice();
        uint256 target = Math.mulDiv(r.s, BPS - pctBelowBps, BPS);
        bytes32[] memory ids = e.shieldList(stock);
        uint256 bestK;
        for (uint256 i; i < ids.length; ++i) {
            Series memory s = REGISTRY.seriesOf(ids[i]);
            if (s.strike > target || s.strike <= bestK || s.archived || !s.buyable) continue;
            best = ids[i];
            bestK = s.strike;
        }
        if (best == bytes32(0)) revert IOptionEngine.SeriesNotBuyable(bytes32(0));
    }
}
