// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {IPriceGuard} from "../interfaces/IPriceGuard.sol";
import {IWriterVault, IVaultRegistry} from "../interfaces/IWriterVault.sol";
import {Roles} from "../libs/Roles.sol";

/// @title WriterVault
/// @notice Shared logic of CoveredUpVault and CashDownVault (spec 2.7, phase 2): epoch deposits and withdrawals,
/// share accounting, NAV, and the registry hooks for funding received and loss payments.
/// @dev Accounting is internal (never balanceOf), so a donation cannot move NAV per share. Buckets: `collateral`
/// (active, writable, share-bearing), `fundingReceived` (USDG held for shareholders, call vault only), `pendingAssets`
/// (deposits waiting for the roll), reserved collateral and USDG (processed withdrawals waiting to be claimed) and
/// `debt` (collateral owed to the pool after a failed transfer; already out of `collateral`).
/// Roll of epoch N, in order: settle debt; withdrawals of N (fraction f of all shares) release the fraction f of every
/// slice (paying its intrinsic value) and receive f of the active collateral before that release less the loss their
/// release paid, plus f of the funding received; then deposits of N mint shares at the post-withdrawal NAV.
abstract contract WriterVault is ERC20, AccessControl, ReentrancyGuardTransient, IWriterVault {
    using SafeERC20 for IERC20;

    bytes32 public constant GUARDIAN_ROLE = Roles.GUARDIAN_ROLE;
    /// @notice Hard bounds of EPOCH. Mainnet and fork deploy 7 days; testnet minutes.
    uint256 public constant MIN_EPOCH = 5 minutes;
    uint256 public constant MAX_EPOCH = 30 days;
    uint256 private constant WAD = 1e18;
    uint256 private constant USDG_TO_WAD = 1e12;

    struct Params {
        address admin;
        IERC20 asset; // collateral token
        IERC20 usdg;
        address stock;
        uint32 tauSeconds;
        uint16 minMoneynessBps;
        uint16 maxMoneynessBps;
        IVaultRegistry registry;
        IPriceGuard priceGuard;
        uint256 epoch;
        uint256 minDeposit;
        string name;
        string symbol;
    }

    struct EpochData {
        uint128 depositAssets;
        uint128 sharesMinted;
        uint128 withdrawShares;
        uint128 collateralOut;
        uint128 usdgOut;
    }

    struct Request {
        uint64 epoch;
        uint192 amount;
    }

    IERC20 internal immutable _asset;
    IERC20 internal immutable _usdg;
    address internal immutable _stock;
    bool internal immutable _isCall;
    uint32 internal immutable _tau;
    uint16 internal immutable _minBps;
    uint16 internal immutable _maxBps;
    IVaultRegistry internal immutable _registry;
    IPriceGuard public immutable priceGuard;
    uint256 public immutable override EPOCH;
    uint256 public immutable minDeposit;
    /// @dev Virtual share offset: 10 ** (18 - asset decimals), so a first deposit mints about 1e18 shares per whole unit.
    uint256 private immutable _offset;

    bool public override open;
    uint64 public override currentEpoch;
    uint256 public epochStart;
    uint256 public override collateral;
    uint256 public override fundingReceived;
    uint256 public override debt;
    uint256 public pendingAssets;
    uint256 public pendingShares;
    uint256 public reservedCollateral;
    uint256 public reservedUsdg;

    mapping(uint64 epoch => EpochData) public epochs;
    mapping(address account => Request) public depositOf;
    mapping(address account => Request) public withdrawalOf;

    constructor(Params memory p, bool isCall_, uint8 assetDecimals) ERC20(p.name, p.symbol) {
        if (
            p.admin == address(0) || address(p.asset) == address(0) || address(p.usdg) == address(0)
                || p.stock == address(0) || address(p.registry) == address(0) || address(p.priceGuard) == address(0)
                || p.tauSeconds == 0 || p.minMoneynessBps == 0 || p.minMoneynessBps > p.maxMoneynessBps
                || p.epoch < MIN_EPOCH || p.epoch > MAX_EPOCH || p.minDeposit == 0 || assetDecimals > 18
        ) revert InvalidParams();
        // Out of the money only: call slices above S, put slices below S.
        if (isCall_ ? p.minMoneynessBps < 10_000 : p.maxMoneynessBps > 10_000) revert InvalidParams();
        _asset = p.asset;
        _usdg = p.usdg;
        _stock = p.stock;
        _isCall = isCall_;
        _tau = p.tauSeconds;
        _minBps = p.minMoneynessBps;
        _maxBps = p.maxMoneynessBps;
        _registry = p.registry;
        priceGuard = p.priceGuard;
        EPOCH = p.epoch;
        minDeposit = p.minDeposit;
        _offset = 10 ** (18 - assetDecimals);
        epochStart = block.timestamp;
        _grantRole(DEFAULT_ADMIN_ROLE, p.admin);
    }

    modifier onlyRegistry() {
        if (msg.sender != address(_registry)) revert NotRegistry();
        _;
    }

    // --------------------------------------------------------------------------------------------- user flow

    /// @inheritdoc IWriterVault
    function deposit(uint256 assets) external override nonReentrant {
        if (!open) revert VaultClosed();
        if (assets < minDeposit) revert BelowMinimum();
        _settle(msg.sender);
        uint64 n = currentEpoch;
        Request storage r = depositOf[msg.sender];
        r.epoch = n;
        r.amount += uint192(assets);
        epochs[n].depositAssets += uint128(assets);
        pendingAssets += assets;
        _asset.safeTransferFrom(msg.sender, address(this), assets);
        emit Deposited(msg.sender, n, assets);
    }

    /// @inheritdoc IWriterVault
    function requestWithdraw(uint256 shares) external override nonReentrant {
        if (shares == 0) revert BelowMinimum();
        _settle(msg.sender);
        uint64 n = currentEpoch;
        _transfer(msg.sender, address(this), shares);
        Request storage r = withdrawalOf[msg.sender];
        r.epoch = n;
        r.amount += uint192(shares);
        epochs[n].withdrawShares += uint128(shares);
        pendingShares += shares;
        emit WithdrawRequested(msg.sender, n, shares);
    }

    /// @inheritdoc IWriterVault
    function claim() external override nonReentrant returns (uint256 shares, uint256 collateralOut, uint256 usdgOut) {
        (shares, collateralOut, usdgOut) = _settle(msg.sender);
        if (shares == 0 && collateralOut == 0 && usdgOut == 0) revert NothingToClaim();
    }

    /// @inheritdoc IWriterVault
    function roll() external override nonReentrant {
        uint256 endsAt = epochStart + EPOCH;
        if (block.timestamp < endsAt) revert EpochNotOver(endsAt);
        _payDebt();
        uint64 n = currentEpoch;
        EpochData storage e = epochs[n];
        uint256 burned = e.withdrawShares;
        (uint256 collOut, uint256 usdgOut) = burned == 0 ? (0, 0) : _processWithdrawals(burned);
        e.collateralOut = uint128(collOut);
        e.usdgOut = uint128(usdgOut);

        uint256 s = _price();
        uint256 minted;
        uint256 d = e.depositAssets;
        if (d != 0) {
            minted = Math.mulDiv(d, totalSupply() + _offset, _navUnits(s) + 1);
            e.sharesMinted = uint128(minted);
            pendingAssets -= d;
            collateral += d;
            if (minted != 0) _mint(address(this), minted);
        }

        currentEpoch = n + 1;
        epochStart = block.timestamp;
        uint256 navWad = _navWad(s);
        uint256 supply = totalSupply();
        emit EpochRolled(n, navWad, supply == 0 ? WAD : Math.mulDiv(navWad, WAD, supply), minted, burned, collOut, usdgOut);
    }

    /// @notice Retries a collateral payment to the pool that failed (issuer pause or freeze). Anyone.
    function settleDebt() external nonReentrant {
        _payDebt();
    }

    // --------------------------------------------------------------------------------------- registry hooks

    /// @inheritdoc IWriterVault
    function creditFunding(uint256 amount) external override onlyRegistry {
        if (_isCall) fundingReceived += amount;
        else collateral += amount;
        emit FundingCredited(amount);
    }

    /// @inheritdoc IWriterVault
    /// @dev Never more than the active collateral (R2). A failed transfer becomes debt (the tokens stay here, outside
    /// every share-bearing bucket) and is retried first at every roll.
    function payLoss(address to, uint256 amount) external override onlyRegistry returns (uint256 paidNow) {
        uint256 c = collateral;
        if (amount > c) amount = c;
        if (amount == 0) return 0;
        collateral = c - amount;
        bool ok = debt == 0 && _asset.trySafeTransfer(to, amount);
        if (ok) paidNow = amount;
        else debt += amount;
        emit LossPaid(to, amount, ok);
    }

    // ----------------------------------------------------------------------------------------- admin

    /// @notice Admin opens or closes deposits; the guardian may only close them. Never affects withdrawals.
    function setOpen(bool open_) external {
        if (!hasRole(DEFAULT_ADMIN_ROLE, msg.sender) && !(!open_ && hasRole(GUARDIAN_ROLE, msg.sender))) {
            revert AccessControlUnauthorizedAccount(msg.sender, GUARDIAN_ROLE);
        }
        open = open_;
        emit OpenSet(open_);
    }

    // ----------------------------------------------------------------------------------------------- views

    function asset() external view override returns (address) {
        return address(_asset);
    }

    function usdg() external view override returns (address) {
        return address(_usdg);
    }

    function stock() external view override returns (address) {
        return _stock;
    }

    function isCallVault() external view override returns (bool) {
        return _isCall;
    }

    function tauSeconds() external view override returns (uint32) {
        return _tau;
    }

    function band() external view override returns (uint16, uint16) {
        return (_minBps, _maxBps);
    }

    function registry() external view override returns (address) {
        return address(_registry);
    }

    function epochEndsAt() external view override returns (uint256) {
        return epochStart + EPOCH;
    }

    /// @inheritdoc IWriterVault
    function nav() external view override returns (uint256) {
        return _navWad(_price());
    }

    /// @inheritdoc IWriterVault
    function navPerShare() external view override returns (uint256) {
        uint256 supply = totalSupply();
        return supply == 0 ? WAD : Math.mulDiv(_navWad(_price()), WAD, supply);
    }

    /// @inheritdoc IWriterVault
    function freeCollateral() public view override returns (uint256) {
        uint256 locked = _registry.lockedOf(address(this));
        uint256 c = collateral;
        return c > locked ? c - locked : 0;
    }

    /// @notice Shares and assets a processed request of `account` would pay now.
    function claimable(address account) external view returns (uint256 shares, uint256 collateralOut, uint256 usdgOut) {
        uint64 n = currentEpoch;
        Request memory d = depositOf[account];
        if (d.amount != 0 && d.epoch < n) {
            EpochData memory e = epochs[d.epoch];
            shares = Math.mulDiv(d.amount, e.sharesMinted, e.depositAssets);
        }
        Request memory w = withdrawalOf[account];
        if (w.amount != 0 && w.epoch < n) {
            EpochData memory e = epochs[w.epoch];
            collateralOut = Math.mulDiv(w.amount, e.collateralOut, e.withdrawShares);
            usdgOut = Math.mulDiv(w.amount, e.usdgOut, e.withdrawShares);
        }
    }

    // ------------------------------------------------------------------------------------------- internals

    /// @dev Pays out the caller's processed deposit (shares) and withdrawal (collateral, USDG), if any.
    function _settle(address account) private returns (uint256 shares, uint256 collOut, uint256 usdgOut) {
        uint64 n = currentEpoch;
        Request memory d = depositOf[account];
        if (d.amount != 0 && d.epoch < n) {
            EpochData memory e = epochs[d.epoch];
            shares = Math.mulDiv(d.amount, e.sharesMinted, e.depositAssets);
            delete depositOf[account];
            if (shares != 0) _transfer(address(this), account, shares);
        }
        Request memory w = withdrawalOf[account];
        if (w.amount != 0 && w.epoch < n) {
            EpochData memory e = epochs[w.epoch];
            collOut = Math.mulDiv(w.amount, e.collateralOut, e.withdrawShares);
            usdgOut = Math.mulDiv(w.amount, e.usdgOut, e.withdrawShares);
            delete withdrawalOf[account];
            reservedCollateral -= collOut;
            reservedUsdg -= usdgOut;
            if (collOut != 0) _asset.safeTransfer(account, collOut);
            if (usdgOut != 0) _usdg.safeTransfer(account, usdgOut);
        }
        if (shares != 0 || collOut != 0 || usdgOut != 0) emit Claimed(account, shares, collOut, usdgOut);
    }

    /// @dev Burns the `burned` escrowed shares of this epoch's withdrawals and reserves their part of the vault.
    function _processWithdrawals(uint256 burned) private returns (uint256 collOut, uint256 usdgOut) {
        uint256 supply = totalSupply();
        uint256 c0 = collateral;
        uint256 f0 = fundingReceived;
        uint256 loss = _registry.releaseFraction(Math.mulDiv(burned, WAD, supply, Math.Rounding.Ceil));
        collOut = Math.mulDiv(c0, burned, supply);
        collOut = collOut > loss ? collOut - loss : 0;
        // What stays must still cover the remaining slices exactly (rounding of the release).
        uint256 free = freeCollateral();
        if (collOut > free) collOut = free;
        usdgOut = Math.mulDiv(f0, burned, supply);
        collateral -= collOut;
        fundingReceived = f0 - usdgOut;
        reservedCollateral += collOut;
        reservedUsdg += usdgOut;
        pendingShares -= burned;
        _burn(address(this), burned);
    }

    function _payDebt() private {
        uint256 owed = debt;
        if (owed == 0) return;
        address pool = _registry.pool();
        if (!_asset.trySafeTransfer(pool, owed)) return;
        debt = 0;
        _registry.debtPaid(owed);
        emit DebtSettled(owed);
    }

    /// @dev Share-bearing value in collateral units: collateral (plus, for calls, funding received at S) less the
    /// slices' intrinsic value at S. Calls: without a price the funding received is left out of the deposit price.
    function _navUnits(uint256 s) private view returns (uint256) {
        uint256 units = collateral;
        if (_isCall && s != 0) units += Math.mulDiv(fundingReceived * USDG_TO_WAD, WAD, s);
        uint256 loss = _registry.unrealizedLossOf(address(this), s);
        return units > loss ? units - loss : 0;
    }

    /// @dev NAV in WAD USDG at S.
    function _navWad(uint256 s) private view returns (uint256) {
        uint256 loss = _registry.unrealizedLossOf(address(this), s);
        uint256 c = collateral > loss ? collateral - loss : 0;
        if (_isCall) return Math.mulDiv(c, s, WAD) + fundingReceived * USDG_TO_WAD;
        return c * USDG_TO_WAD;
    }

    /// @dev The lite PriceGuard read, else the last good price (0 when the stock was never priced).
    function _price() private view returns (uint256 s) {
        s = priceGuard.readLite(_stock).s;
        if (s == 0) (s,) = priceGuard.lastGoodPrice(_stock);
    }
}
