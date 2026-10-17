// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IPool} from "../interfaces/IPool.sol";
import {IPriceGuard} from "../interfaces/IPriceGuard.sol";
import {ISeriesRegistry} from "../interfaces/ISeriesRegistry.sol";
import {IWriterVault, IVaultRegistry} from "../interfaces/IWriterVault.sol";
import {PriceReading, Series} from "../libs/OptionTypes.sol";

/// @title VaultRegistry
/// @notice Coverage book between the Writer Pool and its writer vaults (spec 2.7, phase 2). A slice is a number of
/// option tokens of one series that one vault covers; its size in option units is tokens x norm, so it shrinks with
/// funding exactly like the holders' units and frees collateral as it does. The pool routes the vaults' share of
/// funding and spread here (pro rata covered tokens / supply) and reports every buyback; each covering vault's
/// pro-rata part of the tokens sold back is closed and its intrinsic value paid to the pool in collateral at the
/// trade's price. A vault's whole value at risk is its collateral: a call slice never costs more than its units of
/// Stock Token (intrinsic (S - K) / S < 1 per unit), a put slice never more than strike x units of USDG.
/// @dev Slices are only assumed out of the money (the vault's band lies above S for calls, below S for puts), so a
/// slice starts with zero intrinsic value. Releasing a slice (allocator, or a vault's roll to honour withdrawals)
/// settles its intrinsic value exactly like a buyback, so a slice cannot be dropped to escape a loss. Loops are bounded:
/// at most MAX_COVERS vaults per series and MAX_SLICES series per vault. Admin is the timelock.
contract VaultRegistry is AccessControl, IVaultRegistry {
    using SafeERC20 for IERC20;

    bytes32 public constant ALLOCATOR_ROLE = keccak256("ALLOCATOR_ROLE");
    uint256 public constant MAX_COVERS = 4;
    uint256 public constant MAX_SLICES = 16;
    uint256 private constant WAD = 1e18;
    uint256 private constant BPS = 10_000;
    uint256 private constant STOCK_TO_USDG = 1e30; // raw units x WAD price -> USDG 6 dp

    struct Cover {
        address vault;
        uint128 tokens;
    }

    /// @dev Immutable facts of a covered series, cached at the first assumption.
    struct Meta {
        address token;
        address stock;
        uint128 strike;
        bool isCall;
    }

    address public immutable override pool;
    ISeriesRegistry public immutable series;
    IPriceGuard public immutable priceGuard;
    IERC20 public immutable usdg;

    address[] public vaults;
    mapping(address vault => bool) public isVault;
    mapping(bytes32 id => Cover[]) private _covers;
    mapping(bytes32 id => uint256) public override coveredTokens;
    mapping(address vault => bytes32[]) private _slices;
    mapping(bytes32 id => Meta) public meta;

    constructor(address admin, address pool_, ISeriesRegistry series_, IPriceGuard priceGuard_, IERC20 usdg_) {
        if (
            admin == address(0) || pool_ == address(0) || address(series_) == address(0)
                || address(priceGuard_) == address(0) || address(usdg_) == address(0)
        ) revert InvalidParams();
        pool = pool_;
        series = series_;
        priceGuard = priceGuard_;
        usdg = usdg_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    modifier onlyPool() {
        if (msg.sender != pool) revert NotPool();
        _;
    }

    // ------------------------------------------------------------------------------------------------- admin

    function addVault(address vault) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (isVault[vault] || IWriterVault(vault).registry() != address(this) || IWriterVault(vault).usdg() != address(usdg)) {
            revert InvalidParams();
        }
        isVault[vault] = true;
        vaults.push(vault);
        emit VaultAdded(vault);
    }

    /// @notice Returns USDG left here by a failed routing to the pool (the registry holds none in normal operation).
    function sweep() external onlyRole(DEFAULT_ADMIN_ROLE) returns (uint256 amount) {
        amount = usdg.balanceOf(address(this));
        if (amount != 0) usdg.safeTransfer(pool, amount);
    }

    // --------------------------------------------------------------------------------------------- allocator

    /// @notice `vault` covers `tokens` more option tokens of series `id`. The series must match the vault's name, side
    /// and speed, sit inside its moneyness band at a fresh price, the series' covered total stays within its supply,
    /// and the vault's locked collateral after the change must fit its active collateral (R1: exact, not more).
    function assume(address vault, bytes32 id, uint256 tokens) external onlyRole(ALLOCATOR_ROLE) {
        if (!isVault[vault]) revert UnknownVault(vault);
        if (tokens == 0 || tokens > type(uint128).max) revert InvalidParams();
        Meta memory m = _metaOf(id);
        IWriterVault v = IWriterVault(vault);
        Series memory s = series.seriesOf(id);
        if (m.stock != v.stock() || m.isCall != v.isCallVault() || s.tauSeconds != v.tauSeconds()) revert OutOfBand(id);
        PriceReading memory r = priceGuard.readLite(m.stock);
        if (!r.fresh || r.s == 0) revert NoPrice(m.stock);
        uint256 moneyness = Math.mulDiv(m.strike, BPS, r.s);
        (uint16 lo, uint16 hi) = v.band();
        if (moneyness < lo || moneyness > hi) revert OutOfBand(id);
        uint256 covered = coveredTokens[id] + tokens;
        if (covered > IERC20(m.token).totalSupply()) revert ExceedsSupply(id);
        coveredTokens[id] = covered;
        _add(vault, id, tokens);
        uint256 locked = lockedOf(vault);
        uint256 coll = v.collateral();
        if (locked > coll) {
            uint256 lockedBefore = locked - _required(m, _units(tokens, s.norm));
            revert InsufficientCollateral(coll > lockedBefore ? coll - lockedBefore : 0, locked - lockedBefore);
        }
        emit Assumed(vault, id, tokens, locked);
    }

    /// @notice Releases `tokens` of `vault`'s slice of `id`, paying its intrinsic value at the current price.
    function release(address vault, bytes32 id, uint256 tokens) external onlyRole(ALLOCATOR_ROLE) returns (uint256 loss) {
        if (!isVault[vault]) revert UnknownVault(vault);
        Meta memory m = meta[id];
        loss = _close(vault, id, _indexOf(id, vault), tokens, _price(m.stock), m, false);
    }

    // -------------------------------------------------------------------------------------------- pool hooks

    /// @inheritdoc IVaultRegistry
    function shareOf(bytes32 id, uint256 amount, uint256 supply) public view override returns (uint256) {
        uint256 covered = coveredTokens[id];
        if (covered == 0 || amount == 0) return 0;
        if (supply == 0) supply = IERC20(meta[id].token).totalSupply();
        if (supply == 0) return 0;
        return Math.mulDiv(amount, covered < supply ? covered : supply, supply);
    }

    /// @inheritdoc IVaultRegistry
    function routeFunding(bytes32 id, uint256 amount) external override onlyPool {
        Cover[] storage cs = _covers[id];
        uint256 total = coveredTokens[id];
        uint256 n = cs.length;
        if (total == 0 || n == 0) {
            if (amount != 0) usdg.safeTransfer(pool, amount);
            return;
        }
        uint256 left = amount;
        for (uint256 i; i < n; ++i) {
            uint256 part = i == n - 1 ? left : Math.mulDiv(amount, cs[i].tokens, total);
            left -= part;
            if (part == 0) continue;
            address vault = cs[i].vault;
            usdg.safeTransfer(vault, part);
            IWriterVault(vault).creditFunding(part);
        }
        emit FundingRouted(id, amount);
    }

    /// @inheritdoc IVaultRegistry
    function onBuyback(bytes32 id, uint256 tokens, uint256 supplyBefore, uint256 sWad) external override onlyPool {
        Cover[] storage cs = _covers[id];
        uint256 n = cs.length;
        if (n == 0 || supplyBefore == 0) return;
        Meta memory m = meta[id];
        // Backwards: _close may swap-and-pop the entry it empties.
        for (uint256 i = n; i > 0; --i) {
            Cover memory c = cs[i - 1];
            uint256 part = Math.mulDiv(tokens, c.tokens, supplyBefore, Math.Rounding.Ceil);
            if (part == 0) continue;
            _close(c.vault, id, i - 1, part, sWad, m, true);
        }
    }

    // ------------------------------------------------------------------------------------------- vault hooks

    /// @inheritdoc IVaultRegistry
    function releaseFraction(uint256 fractionWad) external override returns (uint256 loss) {
        address vault = msg.sender;
        if (!isVault[vault]) revert NotVault();
        if (fractionWad > WAD) fractionWad = WAD;
        bytes32[] memory ids = _slices[vault];
        if (ids.length == 0 || fractionWad == 0) return 0;
        uint256 s = _price(IWriterVault(vault).stock());
        for (uint256 j; j < ids.length; ++j) {
            bytes32 id = ids[j];
            uint256 idx = _indexOf(id, vault);
            uint256 part = Math.mulDiv(_covers[id][idx].tokens, fractionWad, WAD, Math.Rounding.Ceil);
            loss += _close(vault, id, idx, part, s, meta[id], false);
        }
    }

    /// @notice A vault paid `units` of owed Stock Token collateral to the pool after a failed transfer: credit them
    /// to the pool's hedge book.
    function debtPaid(uint256 units) external override {
        if (!isVault[msg.sender]) revert NotVault();
        IWriterVault v = IWriterVault(msg.sender);
        if (v.isCallVault() && units != 0) _creditPool(v.stock(), units);
    }

    // ------------------------------------------------------------------------------------------------- views

    /// @inheritdoc IVaultRegistry
    function lockedOf(address vault) public view override returns (uint256 locked) {
        bytes32[] storage ids = _slices[vault];
        for (uint256 j; j < ids.length; ++j) {
            bytes32 id = ids[j];
            Meta memory m = meta[id];
            locked += _required(m, _units(sliceOf(vault, id), series.seriesOf(id).norm));
        }
    }

    /// @inheritdoc IVaultRegistry
    function unrealizedLossOf(address vault, uint256 sWad) external view override returns (uint256 loss) {
        bytes32[] storage ids = _slices[vault];
        for (uint256 j; j < ids.length; ++j) {
            bytes32 id = ids[j];
            Meta memory m = meta[id];
            loss += _intrinsic(m, _units(sliceOf(vault, id), series.seriesOf(id).norm), sWad);
        }
    }

    /// @inheritdoc IVaultRegistry
    function sliceOf(address vault, bytes32 id) public view override returns (uint256) {
        Cover[] storage cs = _covers[id];
        for (uint256 i; i < cs.length; ++i) {
            if (cs[i].vault == vault) return cs[i].tokens;
        }
        return 0;
    }

    /// @inheritdoc IVaultRegistry
    function seriesOfVault(address vault) external view override returns (bytes32[] memory) {
        return _slices[vault];
    }

    function coversOf(bytes32 id) external view returns (Cover[] memory) {
        return _covers[id];
    }

    function vaultCount() external view returns (uint256) {
        return vaults.length;
    }

    /// @notice Collateral a slice of `units` option units of `id` locks: calls units raw Stock Token units, puts
    /// ceil(units x strike) USDG (6 dp).
    function requiredFor(bytes32 id, uint256 units) external view returns (uint256) {
        return _required(meta[id], units);
    }

    // --------------------------------------------------------------------------------------------- internals

    function _metaOf(bytes32 id) private returns (Meta memory m) {
        m = meta[id];
        if (m.token != address(0)) return m;
        Series memory s = series.seriesOf(id);
        if (s.token == address(0)) revert InvalidParams();
        m = Meta({token: s.token, stock: s.stock, strike: s.strike, isCall: s.isCall});
        meta[id] = m;
    }

    function _add(address vault, bytes32 id, uint256 tokens) private {
        Cover[] storage cs = _covers[id];
        for (uint256 i; i < cs.length; ++i) {
            if (cs[i].vault == vault) {
                cs[i].tokens += uint128(tokens);
                return;
            }
        }
        if (cs.length >= MAX_COVERS || _slices[vault].length >= MAX_SLICES) revert TooManySlices();
        cs.push(Cover({vault: vault, tokens: uint128(tokens)}));
        _slices[vault].push(id);
    }

    /// @dev Closes `tokens` (capped at the slice) of the slice at `idx`, pays its intrinsic value at `s` to the pool.
    function _close(address vault, bytes32 id, uint256 idx, uint256 tokens, uint256 s, Meta memory m, bool buyback)
        private
        returns (uint256 loss)
    {
        Cover storage c = _covers[id][idx];
        uint256 have = c.tokens;
        if (tokens > have) tokens = have;
        if (tokens == 0) return 0;
        loss = _intrinsic(m, _units(tokens, series.seriesOf(id).norm), s);
        uint256 rest = have - tokens;
        coveredTokens[id] -= tokens;
        if (rest == 0) _drop(vault, id, idx);
        else c.tokens = uint128(rest);
        if (loss != 0) {
            uint256 paid = IWriterVault(vault).payLoss(pool, loss);
            if (m.isCall && paid != 0) _creditPool(m.stock, paid);
        }
        if (buyback) emit BuybackSettled(vault, id, tokens, loss);
        else emit Released(vault, id, tokens, loss);
    }

    function _drop(address vault, bytes32 id, uint256 idx) private {
        Cover[] storage cs = _covers[id];
        cs[idx] = cs[cs.length - 1];
        cs.pop();
        bytes32[] storage ids = _slices[vault];
        for (uint256 j; j < ids.length; ++j) {
            if (ids[j] == id) {
                ids[j] = ids[ids.length - 1];
                ids.pop();
                return;
            }
        }
    }

    function _creditPool(address stock, uint256 units) private {
        // A refusal (route removed) leaves the units untracked until the admin's syncHedgeUnits; never blocks.
        try IPool(pool).creditVaultStock(stock, units) {} catch {}
    }

    function _indexOf(bytes32 id, address vault) private view returns (uint256) {
        Cover[] storage cs = _covers[id];
        for (uint256 i; i < cs.length; ++i) {
            if (cs[i].vault == vault) return i;
        }
        revert InvalidParams();
    }

    /// @dev S for settlement and NAV: the lite read, else the last good price (0 when the stock was never priced).
    function _price(address stock) private view returns (uint256 s) {
        s = priceGuard.readLite(stock).s;
        if (s == 0) (s,) = priceGuard.lastGoodPrice(stock);
    }

    /// @dev Option units of `tokens` at `norm`, rounded up (the norm in the registry only lags downwards, so this never
    /// understates the slice).
    function _units(uint256 tokens, uint256 norm) private pure returns (uint256) {
        return Math.mulDiv(tokens, norm, WAD, Math.Rounding.Ceil);
    }

    function _required(Meta memory m, uint256 units) private pure returns (uint256) {
        if (m.isCall) return units;
        return Math.mulDiv(units, m.strike, STOCK_TO_USDG, Math.Rounding.Ceil);
    }

    /// @dev Intrinsic value of `units` at `s` in the vault's collateral, rounded up in the pool's favour and never above
    /// the slice's collateral. Calls: units x (S - K) / S Stock Token units (all units when no price exists). Puts:
    /// units x (K - S) USDG.
    function _intrinsic(Meta memory m, uint256 units, uint256 s) private pure returns (uint256 v) {
        if (units == 0) return 0;
        uint256 k = m.strike;
        if (m.isCall) {
            if (s == 0) return units;
            if (s <= k) return 0;
            v = Math.mulDiv(units, s - k, s, Math.Rounding.Ceil);
            return v > units ? units : v;
        }
        if (s >= k) return 0;
        v = Math.mulDiv(units, k - s, STOCK_TO_USDG, Math.Rounding.Ceil);
        uint256 cap = _required(m, units);
        return v > cap ? cap : v;
    }
}
