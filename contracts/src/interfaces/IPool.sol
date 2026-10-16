// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @dev Writer Pool (USDG, ERC-4626-style). The engine is the only counterparty that moves option risk in and out.
interface IPool {
    event HedgeEquityPosted(uint256 equityUsdg, uint64 asOf, bytes32 ref);
    event WithdrawalQueued(address indexed owner, uint256 indexed ticket, uint256 shares, uint64 claimableAt);
    event WithdrawalClaimed(address indexed owner, uint256 indexed ticket, uint256 usdg);

    /// @dev Engine only. Pool has already received `usdgIn`; records income and liability change.
    function onSale(bytes32 seriesId, uint256 usdgIn, uint256 spreadUsdg) external;
    /// @dev Engine only. Pays `usdgOut` to `to` (sell proceeds). Never reverts for lack of cash if NAV allows: the pool
    /// raises cash from hedge routes if needed (as the reference vault does).
    function pay(address to, uint256 usdgOut, uint256 spreadUsdg) external;

    /// @dev NAV in WAD USDG = usdg cash + hedgeEquity - sum(outstanding units * V_mark) + reserve share. liability comes
    /// from the engine (engine.totalLiability()).
    function nav() external view returns (int256 navWad);
    function navPerShare() external view returns (uint256);
    function navFor(uint256 liabilityWad) external view returns (int256 navWad);
    function postHedgeEquity(uint256 equityUsdg, uint64 asOf, bytes32 ref) external; // HEDGER role
    function hedgeEquity() external view returns (uint256 equityUsdg, uint64 asOf);

    // ERC-4626 style, mint at NAV + 10 bps, 72h withdrawal queue paid at NAV at claim time.
    function deposit(uint256 assets, address receiver) external returns (uint256 shares);
    function requestWithdraw(uint256 shares) external returns (uint256 ticket);
    function claim(uint256 ticket) external returns (uint256 usdg);
    function publicDeposits() external view returns (bool);

    // ---- added by todo 08 (additive only; the members above are frozen)

    event SaleRecorded(bytes32 indexed seriesId, uint256 usdgIn, uint256 spreadUsdg);
    event PaidOut(address indexed to, uint256 usdgOut, uint256 spreadUsdg);
    event FundingRecorded(bytes32 indexed seriesId, uint256 fundingUsdg);
    event IncomeSplit(uint256 incomeUsdg, uint256 protocolFeeUsdg, uint256 reserveUsdg, uint256 feeOwedUsdg);
    event Rebalanced(address indexed stock, bool buy, uint256 amountIn, uint256 amountOut, uint256 unitsAfter);
    event CashRaised(address indexed stock, uint256 stockSold, uint256 usdgOut);
    event ReserveDrawn(uint256 usdg);

    error NotEngine();
    error Insolvent(uint256 needed, uint256 available);
    error HedgeJump(uint256 previous, uint256 next);

    /// @dev Engine only. In-kind funding moved `fundingUsdg` (6 dp) of option value from holders to the pool (the
    /// liability shrink of one accrual). No USDG moves in; the pool pays the protocol fee share on it.
    function onFunding(bytes32 seriesId, uint256 fundingUsdg) external;
    /// @dev true when a perp equity post exists and is older than 2h. The engine pauses buys while it is true.
    function hedgeStale() external view returns (bool);
    /// @dev Caps in bps of NAV the engine enforces on buys (defaults 3500 and 800). Admin (timelock) only to change.
    function maxOutstandingBps() external view returns (uint16);
    function maxPerNameBps() external view returns (uint16);
    /// @dev The two caps in WAD USDG for an engine-supplied liability (no callback into the engine).
    function capsFor(uint256 liabilityWad) external view returns (uint256 maxOutstandingWad, uint256 maxPerNameWad);
    /// @dev HEDGER only. Moves the pool's spot hedge in `stock` toward `targetUnits` (raw Stock Token units) on the
    /// configured Uniswap v3 route. Buy: `minOutOrMaxIn` caps USDG spent (0 = no cap). Sell: it is the caller's
    /// minimum USDG out. The pool's own floor (oracle and TWAP, less maxHedgeSlippageBps) always applies too.
    function rebalance(address stock, uint256 targetUnits, uint256 minOutOrMaxIn) external returns (int256 unitsDelta);
    /// @dev Spot hedge units the pool tracks for `stock` (valued at the PriceGuard S inside NAV).
    function hedgeUnits(address stock) external view returns (uint256);
}
