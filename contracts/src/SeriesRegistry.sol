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

    IPriceGuard public immutable priceGuard;
    OptionTokenFactory public immutable factory;
    address public engine;

    mapping(address stock => StockInfo) private _stocks;
    mapping(bytes32 id => Series) private _series;
    bytes32[] private _ids;

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

        id = idOf(stock, isCall, strike, tauSeconds);
        if (_series[id].token != address(0)) revert SeriesExists(id);
        _checkStrike(stock, strike, info.strikeStep);

        (string memory name, string memory symbol) = _names(info.ticker, isCall, strike, speed);
        address token = factory.deploy(id, engine_, name, symbol);

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

    function idOf(address stock, bool isCall, uint128 strike, uint32 tauSeconds) public pure returns (bytes32) {
        return keccak256(abi.encode(stock, isCall, strike, tauSeconds));
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

    function _names(string memory ticker, bool isCall, uint128 strike, Speed speed)
        private
        pure
        returns (string memory name, string memory symbol)
    {
        string memory k = _strikeText(strike);
        bool weekly = speed == Speed.WEEKLY;
        name = string.concat("Lemniscate ", ticker, isCall ? " Up " : " Down ", k, weekly ? " Weekly" : " Daily");
        symbol = string.concat("e", ticker, isCall ? "-C-" : "-P-", k, weekly ? "-W" : "-D");
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
