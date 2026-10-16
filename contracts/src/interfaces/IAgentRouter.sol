// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Budgeted agent execution (spec section 6). An owner gives an agent key a policy: a lifetime USDG budget, a
/// per-trade limit, an expiry, the names it may trade and whether it may sell or buy Shield. The owner approves USDG
/// (and option tokens, for sells) to this router only; the agent then trades through the engine on the owner's behalf.
/// Option tokens and sale proceeds always go to the owner, never to the agent or the router.
interface IAgentRouter {
    /// @dev `spentUsdg` is the cumulative USDG the agent spent for this owner (actual cost, 6 dp). It survives a new
    /// `setPolicy` and a revoke: the budget is a lifetime cap for that (owner, agent) pair; raise it to allow more.
    struct Policy {
        address agent;
        uint128 budgetUsdg;
        uint128 spentUsdg;
        uint128 maxPerTradeUsdg;
        uint64 expiresAt;
        bool canSell;
        bool canShield;
        bool revoked;
    }

    event PolicySet(
        address indexed owner,
        address indexed agent,
        uint128 budgetUsdg,
        uint128 maxPerTradeUsdg,
        uint64 expiresAt,
        bool canSell,
        bool canShield
    );
    event PolicyRevoked(address indexed owner, address indexed agent);
    /// @dev The allowed names of a policy, emitted with every `setPolicy` (replaces the previous list).
    event PolicyStocks(address indexed owner, address indexed agent, address[] stocks);
    /// @dev `usdg`: actual cost for a buy or Shield, proceeds for a sell (0 when the sell was queued).
    event AgentTrade(address indexed owner, address indexed agent, bytes32 indexed seriesId, bool isBuy, uint256 usdg);
    /// @dev A sell made through the router was escrowed by the engine (HALTED session or blocked payout). The router
    /// holds the ticket for `owner`, who alone can cancel it through `cancelQueuedFor`.
    event QueuedSellFor(uint256 indexed ticket, address indexed owner, address indexed agent, bytes32 seriesId);

    error InvalidPolicy();
    error NoPolicy(address owner, address agent);
    error PolicyIsRevoked(address owner, address agent);
    error PolicyExpired(uint64 expiresAt);
    error StockNotAllowed(address stock);
    error SellNotAllowed();
    error ShieldNotAllowed();
    error MaxPerTradeExceeded(uint256 cost, uint256 maxPerTradeUsdg);
    error BudgetExceeded(uint256 spentUsdg, uint256 cost, uint256 budgetUsdg);
    error NotTicketOwner(uint256 ticket);

    /// @dev msg.sender is the owner. Replaces the (owner, agent) policy and its allowed names, clears a revoke and
    /// keeps `spentUsdg`.
    function setPolicy(
        address agent,
        uint128 budgetUsdg,
        uint128 maxPerTradeUsdg,
        uint64 expiresAt,
        bool canSell,
        bool canShield,
        address[] calldata stocks
    ) external;
    /// @dev msg.sender is the owner. Immediate; makes no external call, so nothing can block it.
    function revoke(address agent) external;

    /// @dev msg.sender is the agent. Pulls at most min(maxCostUsdg, maxPerTrade, remaining budget) USDG from the owner,
    /// buys with recipient = owner, refunds the unused part. Counts the actual cost against the budget.
    function buyFor(address owner, bytes32 seriesId, uint128 units, uint128 maxCostUsdg, uint64 deadline)
        external
        returns (uint256 cost, uint256 tokens);
    /// @dev msg.sender is the agent; needs `canSell`. Pulls `tokens` option tokens from the owner (owner approves the
    /// router on the option token) and sells them with recipient = owner.
    function sellFor(address owner, bytes32 seriesId, uint128 tokens, uint128 minProceedsUsdg, uint64 deadline)
        external
        returns (uint256 proceeds);
    /// @dev msg.sender is the agent; needs `canShield`. Picks the same series the engine's `shield` would (largest
    /// buyable Weekly Down strike at or below S x (1 - pctBelowBps)) for `tokenUnits` the owner holds, and buys it for
    /// the owner under the same budget rules as `buyFor`.
    function shieldFor(
        address owner,
        address stock,
        uint128 tokenUnits,
        uint16 pctBelowBps,
        uint128 maxCostUsdg,
        uint64 deadline
    ) external returns (bytes32 id, uint256 cost);
    /// @dev The owner of a queued router sell takes the escrowed option tokens back (sent to the owner).
    function cancelQueuedFor(uint256 ticket) external;

    function policyOf(address owner, address agent) external view returns (Policy memory);
    function isAllowedStock(address owner, address agent, address stock) external view returns (bool);
    /// @dev budget - spent (0 when spent). Not reduced by expiry or revoke; check `policyOf` for those.
    function remainingBudget(address owner, address agent) external view returns (uint256);
    function allowedStocks(address owner, address agent) external view returns (address[] memory);
    /// @dev Owner of a router-held queued sell ticket (zero if none).
    function ticketOwner(uint256 ticket) external view returns (address);
    function engine() external view returns (address);
}
