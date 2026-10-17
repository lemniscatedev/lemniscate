// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @dev Writer vault (spec 2.7, phase 2). A vault assumes a slice of the Writer Pool's short exposure on one name, one
/// speed and one moneyness band, fully collateralized and never liquidated:
///  - CoveredUpVault: short calls, collateral = Stock Token raw units, 1 raw unit per call unit.
///  - CashDownVault: short puts, collateral = USDG = strike x units.
/// It receives its slice's funding and spread (after the protocol fee) in USDG, and on a loss event (holders sell the
/// covered options back, or the vault releases a slice) pays the slice's intrinsic value to the pool in its own
/// collateral at the PriceGuard price. Deposits and withdrawals move in epochs: a deposit made during epoch N enters at
/// the roll that ends N (it earns from N+1); a withdrawal requested during N is honoured at that roll, never blocked.
/// Units: option units and Stock Token amounts in raw units (1e18 = one whole token), USDG 6 dp, prices WAD.
interface IWriterVault {
    event Deposited(address indexed account, uint64 indexed epoch, uint256 assets);
    event WithdrawRequested(address indexed account, uint64 indexed epoch, uint256 shares);
    event Claimed(address indexed account, uint256 shares, uint256 collateralOut, uint256 usdgOut);
    /// @dev Published at every roll. navWad = NAV in WAD USDG (collateral and USDG at the PriceGuard price less the
    /// covered slices' intrinsic value), navPerShareWad per whole (1e18) share.
    event EpochRolled(
        uint64 indexed epoch,
        uint256 navWad,
        uint256 navPerShareWad,
        uint256 sharesMinted,
        uint256 sharesBurned,
        uint256 collateralOut,
        uint256 usdgOut
    );
    event OpenSet(bool open);
    event FundingCredited(uint256 usdg);
    event LossPaid(address indexed to, uint256 collateral, bool transferred);
    event DebtSettled(uint256 collateral);

    error VaultClosed();
    error NotRegistry();
    error EpochNotOver(uint256 endsAt);
    error BelowMinimum();
    error InvalidParams();
    error NothingToClaim();

    /// @dev Collateral token (Stock Token for CoveredUpVault, USDG for CashDownVault).
    function asset() external view returns (address);
    function usdg() external view returns (address);
    function stock() external view returns (address);
    /// @dev true: short calls (CoveredUpVault). false: short puts (CashDownVault).
    function isCallVault() external view returns (bool);
    function tauSeconds() external view returns (uint32);
    /// @dev Strike / S at assumption, in bps, inclusive bounds (calls above 10000, puts below: out of the money only).
    function band() external view returns (uint16 minMoneynessBps, uint16 maxMoneynessBps);
    function registry() external view returns (address);

    /// @dev false by default; while false only deposits are refused (R6).
    function open() external view returns (bool);
    /// @dev Epoch length, fixed per deployment (7 days on mainnet and fork, minutes on testnet), hard minimum enforced.
    function EPOCH() external view returns (uint256);
    function currentEpoch() external view returns (uint64);
    function epochEndsAt() external view returns (uint256);

    /// @dev Pulls `assets` of the collateral token (approve first). Writable and share-bearing from the next roll.
    function deposit(uint256 assets) external;
    /// @dev Escrows `shares`; paid pro rata in kind (collateral and funding received in USDG) at the roll that ends this epoch.
    function requestWithdraw(uint256 shares) external;
    /// @dev Anyone, once the epoch is over. Never blocked by `open`, pauses or prices.
    function roll() external;
    /// @dev Collects the caller's processed deposit (shares) and withdrawal (collateral and USDG).
    function claim() external returns (uint256 shares, uint256 collateralOut, uint256 usdgOut);

    /// @dev NAV in WAD USDG at the PriceGuard price (lite read).
    function nav() external view returns (uint256 navWad);
    function navPerShare() external view returns (uint256 navPerShareWad);
    /// @dev Active collateral (excludes pending deposits and processed withdrawals waiting to be claimed).
    function collateral() external view returns (uint256);
    /// @dev Funding and spread received in USDG, held for the shareholders (CoveredUpVault; CashDownVault adds it to
    /// its USDG collateral).
    function fundingReceived() external view returns (uint256);
    /// @dev Active collateral not locked by covered slices.
    function freeCollateral() external view returns (uint256);
    /// @dev Collateral owed to the pool after a payout transfer failed (issuer pause or freeze); settled first.
    function debt() external view returns (uint256);

    // ---- registry only

    /// @dev The registry has transferred `amount` USDG to the vault.
    function creditFunding(uint256 amount) external;
    /// @dev Pays `amount` collateral to `to` (the pool). Returns the amount actually transferred now; the rest is debt.
    function payLoss(address to, uint256 amount) external returns (uint256 paidNow);
}

/// @dev Writer vault registry: the coverage book between the Writer Pool and its vaults. The pool is its only caller
/// for funding and loss events; the allocator (keeper) assigns and releases slices; a vault releases a fraction of all
/// its slices at its roll to honour withdrawals.
interface IVaultRegistry {
    event VaultAdded(address indexed vault);
    event Assumed(address indexed vault, bytes32 indexed id, uint256 tokens, uint256 lockedAfter);
    event Released(address indexed vault, bytes32 indexed id, uint256 tokens, uint256 lossCollateral);
    event BuybackSettled(address indexed vault, bytes32 indexed id, uint256 tokens, uint256 lossCollateral);
    event FundingRouted(bytes32 indexed id, uint256 usdg);

    error NotPool();
    error NotVault();
    error UnknownVault(address vault);
    error OutOfBand(bytes32 id);
    error ExceedsSupply(bytes32 id);
    error InsufficientCollateral(uint256 free, uint256 needed);
    error TooManySlices();
    error NoPrice(address stock);
    error InvalidParams();

    function pool() external view returns (address);

    // ---- pool only (funding here means funding and spread received)

    /// @dev Gross share of `amount` (6 dp) for the vaults covering `id`: amount x covered / supply (`supply` 0 reads the
    /// option token's supply now).
    function shareOf(bytes32 id, uint256 amount, uint256 supply) external view returns (uint256);
    /// @dev The pool has transferred `usdg` (its vaults' net share) to the registry: route it pro rata to the vaults.
    function routeFunding(bytes32 id, uint256 usdg) external;
    /// @dev Holders sold `tokens` of `id` back (supply before the burn `supplyBefore`) at underlying `sWad`: each covering
    /// vault's pro-rata slice is closed and its intrinsic value paid to the pool in collateral.
    function onBuyback(bytes32 id, uint256 tokens, uint256 supplyBefore, uint256 sWad) external;

    // ---- vault only

    /// @dev Releases `fractionWad` (1e18 = all) of every slice of the calling vault, paying each slice's intrinsic value.
    function releaseFraction(uint256 fractionWad) external returns (uint256 lossCollateral);
    /// @dev The calling vault has paid `units` of owed collateral to the pool (Stock Token units are credited to the
    /// pool's hedge book).
    function debtPaid(uint256 units) external;

    // ---- views

    /// @dev Collateral locked by `vault`'s slices: calls sum(units), puts sum(ceil(units x strike)) in USDG.
    function lockedOf(address vault) external view returns (uint256);
    /// @dev Intrinsic value of `vault`'s slices at `sWad`, in the vault's collateral (calls: raw stock units, rounded up).
    function unrealizedLossOf(address vault, uint256 sWad) external view returns (uint256);
    function coveredTokens(bytes32 id) external view returns (uint256);
    function sliceOf(address vault, bytes32 id) external view returns (uint256 tokens);
    function seriesOfVault(address vault) external view returns (bytes32[] memory);
}
