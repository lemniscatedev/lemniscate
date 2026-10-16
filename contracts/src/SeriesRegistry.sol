// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {ISeriesRegistry} from "./interfaces/ISeriesRegistry.sol";
import {IPriceGuard} from "./interfaces/IPriceGuard.sol";
import {PriceReading, Series, Speed} from "./libs/OptionTypes.sol";
import {Roles} from "./libs/Roles.sol";
import {OptionTokenFactory} from "./OptionTokenFactory.sol";

/// @title SeriesRegistry
/// @notice The list of option series (stock, Up/Down, strike, Daily/Weekly) and their funding state. Listing a series
/// deploys its ERC-20 as an EIP-1167 clone, e.g. "Lemniscate NVDA Up 110 Weekly" / "eNVDA-C-110-W".
/// New series start non-buyable: the lister turns them on with `setBuyable` (the indexer assumes listed series are
/// non-buyable until a SeriesBuyableSet event).
/// Epochs (decision 27, todo 07b): a series id includes an epoch number. When a strike's norm has decayed below
/// `relistNormThreshold` (popular Daily strikes in about 9 days) or the series is archived, the keeper lists the same
/// (stock, side, strike, speed) again as the next epoch with a fresh norm; the old epoch is archived and stays
/// sellable forever. Symbols after epoch 0 carry the epoch, e.g. "eNVDA-C-110-W.2".
/// @dev Roles: DEFAULT_ADMIN_ROLE (timelock) allows stocks, sets strike steps and the engine once; KEEPER_ROLE (keeper)
/// lists series, toggles buyable and archives; only the engine stores accruals. Archived series keep their data and
/// token forever so holders can always sell.
contract SeriesRegistry is ISeriesRegistry, AccessControl {
    /// @notice The keeper key lists series, toggles buyable and archives (same role id as libs/Roles.sol).
    bytes32 public constant KEEPER_ROLE = Roles.KEEPER_ROLE;

    uint32 public constant TAU_DAILY = 86_400;
    uint32 public constant TAU_WEEKLY = 604_800;
    uint128 public constant INITIAL_NORM = 1e18;
    /// @dev Strike must lie in [S / 10, S * 10] (10% to 1000% of the stock's last good price).
    uint256 public constant STRIKE_BAND = 10;

    struct StockInfo {
        bool allowed;
        uint128 strikeStep; // WAD; 0 = no step check
        string ticker; // e.g. "NVDA", used in token names
    }

    event EngineSet(address engine);
    event StockSet(address indexed stock, bool allowed, uint128 strikeStep, string ticker);

    error ZeroAddress();
    error EngineAlreadySet();
    error EngineNotSet();
    error NotEngine();
    error TauInvalid(uint32 tauSeconds);
    error TickerInvalid();
    error NoPrice(address stock);
    error SeriesIsArchived(bytes32 id);
    error NormRises(uint128 current, uint128 proposed);
    error AccrualBackwards(uint64 current, uint64 proposed);
    error EpochNotDue(bytes32 current, uint128 norm);
    error ThresholdInvalid(uint128 threshold);

    IPriceGuard public immutable priceGuard;
    OptionTokenFactory public immutable factory;
    address public engine;

    mapping(address stock => StockInfo) private _stocks;
    mapping(bytes32 id => Series) private _series;
    bytes32[] private _ids;

    /// @notice Norm under which a strike may be listed again as a new epoch (WAD; default 1e15 = 0.001).
    uint128 public relistNormThreshold = 1e15;
    /// @dev Epochs listed so far per (stock, isCall, strike, tau) key; the current epoch is count - 1.
    mapping(bytes32 key => uint32) private _epochs;
    mapping(bytes32 id => uint32) private _epochOf;

    constructor(address admin, IPriceGuard priceGuard_) {
        if (admin == address(0) || address(priceGuard_) == address(0)) revert ZeroAddress();
        priceGuard = priceGuard_;
        factory = new OptionTokenFactory();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    // ------------------------------------------------------------------------------------------------------- admin

    /// @notice Sets the engine once. Tokens bind to it at listing, so it must be the engine's permanent (proxy) address.
    function setEngine(address engine_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (engine_ == address(0)) revert ZeroAddress();
        if (engine != address(0)) revert EngineAlreadySet();
        engine = engine_;
        emit EngineSet(engine_);
    }

    /// @notice Allows or disallows new listings on `stock`. Existing series are unaffected.
    function setStock(address stock, bool allowed, uint128 strikeStep, string calldata ticker)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        if (stock == address(0)) revert ZeroAddress();
        uint256 len = bytes(ticker).length;
        if (len == 0 || len > 12) revert TickerInvalid();
        _stocks[stock] = StockInfo({allowed: allowed, strikeStep: strikeStep, ticker: ticker});
        emit StockSet(stock, allowed, strikeStep, ticker);
    }

    /// @notice Norm threshold for listing a new epoch (admin). Bounded to (0, 0.1].
    function setRelistNormThreshold(uint128 threshold) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (threshold == 0 || threshold > 1e17) revert ThresholdInvalid(threshold);
        relistNormThreshold = threshold;
        emit RelistNormThresholdSet(threshold);
    }

    // ------------------------------------------------------------------------------------------------------ lister

    /// @inheritdoc ISeriesRegistry
    function listSeries(address stock, bool isCall, uint128 strike, uint32 tauSeconds)
        external
        onlyRole(KEEPER_ROLE)
        returns (bytes32 id)
    {
        address engine_ = engine;
        if (engine_ == address(0)) revert EngineNotSet();
        StockInfo storage info = _stocks[stock];
        if (!info.allowed) revert StockNotAllowed(stock);
        Speed speed;
        if (tauSeconds == TAU_DAILY) speed = Speed.DAILY;
        else if (tauSeconds == TAU_WEEKLY) speed = Speed.WEEKLY;
        else revert TauInvalid(tauSeconds);

        bytes32 key = _key(stock, isCall, strike, tauSeconds);
        uint32 count = _epochs[key];
        bytes32 previous;
        if (count != 0) {
            previous = idOfEpoch(stock, isCall, strike, tauSeconds, count - 1);
            Series storage cur = _series[previous];
            if (!cur.archived && cur.norm >= relistNormThreshold) revert SeriesExists(previous);
        }
        uint32 epoch = count;
        id = idOfEpoch(stock, isCall, strike, tauSeconds, epoch);
        _checkStrike(stock, strike, info.strikeStep);

        (string memory name, string memory symbol) = _names(info.ticker, isCall, strike, speed, epoch);
        address token = factory.deploy(id, engine_, name, symbol);
        _epochs[key] = epoch + 1;
        _epochOf[id] = epoch;
        if (count != 0) {
            Series storage prev = _series[previous];
            if (prev.buyable) {
                prev.buyable = false;
                emit SeriesBuyableSet(previous, false);
            }
            if (!prev.archived) {
                prev.archived = true;
                emit SeriesArchived(previous);
            }
        }

        _series[id] = Series({
            stock: stock,
            isCall: isCall,
            speed: speed,
            tauSeconds: tauSeconds,
            strike: strike,
            token: token,
            norm: INITIAL_NORM,
            lastAccrual: uint64(block.timestamp),
            listedAt: uint64(block.timestamp),
            buyable: false,
            archived: false
        });
        _ids.push(id);
        emit SeriesListed(id, stock, isCall, speed, strike, token);
        if (count != 0) emit EpochListed(id, previous, epoch);
    }

    /// @inheritdoc ISeriesRegistry
    function setBuyable(bytes32 id, bool buyable) external onlyRole(KEEPER_ROLE) {
        Series storage s = _known(id);
        if (buyable && s.archived) revert SeriesIsArchived(id);
        s.buyable = buyable;
        emit SeriesBuyableSet(id, buyable);
    }

    /// @inheritdoc ISeriesRegistry
    /// @dev Buys stop for good; data, norm and token stay, so holders can still sell and accrual continues.
    function archive(bytes32 id) external onlyRole(KEEPER_ROLE) {
        Series storage s = _known(id);
        if (s.buyable) {
            s.buyable = false;
            emit SeriesBuyableSet(id, false);
        }
        s.archived = true;
        emit SeriesArchived(id);
    }

    // ------------------------------------------------------------------------------------------------------ engine

    /// @inheritdoc ISeriesRegistry
    function storeAccrual(bytes32 id, uint128 norm, uint64 lastAccrual) external {
        if (msg.sender != engine || msg.sender == address(0)) revert NotEngine();
        Series storage s = _known(id);
        if (norm > s.norm || norm == 0) revert NormRises(s.norm, norm);
        if (lastAccrual < s.lastAccrual) revert AccrualBackwards(s.lastAccrual, lastAccrual);
        s.norm = norm;
        s.lastAccrual = lastAccrual;
    }

    // ------------------------------------------------------------------------------------------------------- views

    function seriesOf(bytes32 id) external view returns (Series memory) {
        return _series[id];
    }

    /// @inheritdoc ISeriesRegistry
    function idOf(address stock, bool isCall, uint128 strike, uint32 tauSeconds) public view returns (bytes32) {
        return idOfEpoch(stock, isCall, strike, tauSeconds, currentEpoch(stock, isCall, strike, tauSeconds));
    }

    /// @inheritdoc ISeriesRegistry
    function idOfEpoch(address stock, bool isCall, uint128 strike, uint32 tauSeconds, uint32 epoch)
        public
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(stock, isCall, strike, tauSeconds, epoch));
    }

    /// @inheritdoc ISeriesRegistry
    function currentEpoch(address stock, bool isCall, uint128 strike, uint32 tauSeconds) public view returns (uint32) {
        uint32 count = _epochs[_key(stock, isCall, strike, tauSeconds)];
        return count == 0 ? 0 : count - 1;
    }

    /// @inheritdoc ISeriesRegistry
    function epochOf(bytes32 id) external view returns (uint32) {
        return _epochOf[id];
    }

    function seriesCount() external view returns (uint256) {
        return _ids.length;
    }

    function seriesIdAt(uint256 index) external view returns (bytes32) {
        return _ids[index];
    }

    function allowedStock(address stock) external view returns (bool) {
        return _stocks[stock].allowed;
    }

    function stockInfo(address stock) external view returns (StockInfo memory) {
        return _stocks[stock];
    }

    /// @notice The token address series `id` has (or will have once listed).
    function predictToken(bytes32 id) external view returns (address) {
        return factory.predict(id);
    }

    // ----------------------------------------------------------------------------------------------------- internal

    function _key(address stock, bool isCall, uint128 strike, uint32 tauSeconds) private pure returns (bytes32) {
        return keccak256(abi.encode(stock, isCall, strike, tauSeconds));
    }

    function _known(bytes32 id) private view returns (Series storage s) {
        s = _series[id];
        if (s.token == address(0)) revert SeriesUnknown(id);
    }

    /// @dev Strike inside [S/10, 10 S] of the last good price (or the current fresh price if none was recorded yet),
    /// and a multiple of the stock's strike step when one is set.
    function _checkStrike(address stock, uint128 strike, uint128 step) private view {
        if (strike == 0) revert StrikeInvalid(strike);
        if (step != 0 && strike % step != 0) revert StrikeInvalid(strike);
        (uint256 s,) = priceGuard.lastGoodPrice(stock);
        if (s == 0) {
            PriceReading memory r = priceGuard.read(stock);
            if (!r.fresh || r.s == 0) revert NoPrice(stock);
            s = r.s;
        }
        uint256 k = strike;
        if (k * STRIKE_BAND < s || k > s * STRIKE_BAND) revert StrikeInvalid(strike);
    }

    function _names(string memory ticker, bool isCall, uint128 strike, Speed speed, uint32 epoch)
        private
        pure
        returns (string memory name, string memory symbol)
    {
        string memory k = _strikeText(strike);
        bool weekly = speed == Speed.WEEKLY;
        name = string.concat("Lemniscate ", ticker, isCall ? " Up " : " Down ", k, weekly ? " Weekly" : " Daily");
        symbol = string.concat("e", ticker, isCall ? "-C-" : "-P-", k, weekly ? "-W" : "-D");
        if (epoch != 0) {
            string memory e = Strings.toString(epoch);
            name = string.concat(name, " #", e);
            symbol = string.concat(symbol, ".", e);
        }
    }

    /// @dev WAD strike as a decimal without trailing zeros: 110e18 -> "110", 112.5e18 -> "112.5".
    function _strikeText(uint128 strike) internal pure returns (string memory) {
        uint256 whole = strike / 1e18;
        uint256 frac = strike % 1e18;
        if (frac == 0) return Strings.toString(whole);
        uint256 digits = 18;
        while (frac % 10 == 0) {
            frac /= 10;
            --digits;
        }
        string memory f = Strings.toString(frac);
        // Left-pad the fraction with zeros up to `digits`.
        uint256 pad = digits - bytes(f).length;
        bytes memory zeros = new bytes(pad);
        for (uint256 i; i < pad; ++i) {
            zeros[i] = "0";
        }
        return string.concat(Strings.toString(whole), ".", string(zeros), f);
    }
}
