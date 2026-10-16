// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AccessControlUpgradeable} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Permit.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {ReentrancyGuardTransientUpgradeable} from
    "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardTransientUpgradeable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {IWriterPool} from "./interfaces/IWriterPool.sol";
import {IAggregatorV3} from "./interfaces/IAggregatorV3.sol";
import {IStockToken} from "./interfaces/IStockToken.sol";
import {IMarketHours} from "./interfaces/IMarketHours.sol";
import {ILemniscateEngine} from "./interfaces/ILemniscateEngine.sol";
import {MarketConfig, MarketState, Regime, ValuationMark} from "./libs/LemniscateTypes.sol";
import {LemniscateMath} from "./libs/LemniscateMath.sol";
import {Roles} from "./libs/Roles.sol";
import {OptionToken} from "./OptionToken.sol";
import {OptionTokenFactory} from "./OptionTokenFactory.sol";
import {EngineHelper} from "./EngineHelper.sol";

/// @title LemniscateEngine
/// @notice Market registry, oracle guard, carry accrual, quoting, and spot trade execution.
/// @dev Every entry point reads each market's oracle exactly once into a memory `Mark` and derives regime, index,
/// normFactor, price, and liability from it. The vault receives those marks (`navFor`) instead of calling back.
contract LemniscateEngine is
    Initializable,
    AccessControlUpgradeable,
    UUPSUpgradeable,
    ReentrancyGuardTransientUpgradeable,
    ILemniscateEngine
{
    using SafeERC20 for IERC20;

    uint256 private constant WAD = 1e18;
    uint256 private constant BPS = 10_000;
    uint256 private constant FEED_TO_WAD = 1e10;
    uint256 private constant USDG_TO_WAD = 1e12;
    uint256 private constant MAX_ACCRUAL = 7 days;
    uint256 private constant CARRY_DAY = 1 days;
    uint256 private constant SEQUENCER_GRACE_PERIOD = 1 hours;
    uint256 private constant PAUSED_BAND_BPS = 300;
    /// @dev Chain-independent paused-sell budget window. `block.number` on Arbitrum Orbit chains returns the
    /// parent-chain block number, so a per-block cap would not mean what it says.
    uint256 private constant PAUSED_SELL_WINDOW = 1 hours;
    uint256 private constant MAX_SPOT_WAD = type(uint128).max;
    uint128 private constant MIN_NORM_FACTOR = 1e12;

    bytes32 public constant override KEEPER_ROLE = Roles.KEEPER_ROLE;
    bytes32 public constant override GUARDIAN_ROLE = Roles.GUARDIAN_ROLE;

    /// @dev Protocol-wide oracle inputs, read once per entry point.
    struct Env {
        bool open;
        bool sequencerDown;
    }

    /// @dev One market's oracle-derived view at the current timestamp.
    struct Mark {
        Regime regime;
        bool valid;
        uint256 liveSpot;
        uint256 updatedAt;
        uint256 spot;
        uint256 index;
        int256 carry;
        uint256 normFactor;
        uint256 price;
        uint256 liability;
    }

    /// @dev Config fields read for every market on every oracle pass, packed into three slots.
    struct MarketHot {
        IAggregatorV3 feed;
        uint64 scale;
        uint32 maxAgeOpen;
        IStockToken stock;
        uint32 maxAgeOffHours;
        int64 offHoursCarryWad;
        int64 skewCarryWad;
        int64 minCarryWad;
        int64 maxCarryWad;
    }

    struct Quote {
        uint256 amountOut;
        uint256 fee;
        uint256 price;
        uint256 grossUsdg;
    }

    IERC20 public override usdg;
    IWriterPool public override vault;
    IMarketHours public override marketHours;
    address public override treasury;
    IAggregatorV3 public override sequencerFeed;
    uint16 public override maxGlobalExposureBps;
    uint16 public override protocolFeeShareBps;
    bool public override globalBuysPaused;

    MarketConfig[] private _configs;
    MarketState[] private _states;
    mapping(address token => uint8 idPlusOne) private _idPlusOne;
    mapping(uint8 marketId => MarketHot hot) private _hot;
    OptionTokenFactory private immutable _TOKEN_FACTORY;
    EngineHelper private immutable _HELPER;

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _TOKEN_FACTORY = new OptionTokenFactory();
        _HELPER = new EngineHelper();
        _disableInitializers();
    }

    /// @notice Initializes protocol dependencies and grants the admin role.
    function initialize(address admin, IERC20 usdg_, IWriterPool vault_, IMarketHours marketHours_, address treasury_)
        external
        override
        initializer
    {
        if (
            admin == address(0) || address(usdg_) == address(0) || address(vault_) == address(0)
                || address(marketHours_) == address(0) || treasury_ == address(0)
        ) {
            revert ZeroAddress();
        }

        __AccessControl_init();
        __UUPSUpgradeable_init();
        __ReentrancyGuardTransient_init();
        usdg = usdg_;
        vault = vault_;
        marketHours = marketHours_;
        treasury = treasury_;
        maxGlobalExposureBps = 5_000;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    /// @notice Creates a new market and its immutable OptionToken.
    function listMarket(
        MarketConfig calldata config,
        string calldata name,
        string calldata symbol,
        int64 initialBaseCarryWad
    ) external override onlyRole(DEFAULT_ADMIN_ROLE) returns (uint8 id) {
        if (_configs.length >= type(uint8).max) revert InvalidMarketConfig();
        if (address(config.token) != address(0)) revert InvalidMarketConfig();
        _HELPER.validate(config);
        // Vault hedge accounting (syncHedgeUnits, NAV) assumes one market per stock token.
        for (uint256 i; i < _configs.length; ++i) {
            if (address(_configs[i].stock) == address(config.stock)) revert InvalidMarketConfig();
        }
        if (initialBaseCarryWad < config.baseCarryMinWad || initialBaseCarryWad > config.baseCarryMaxWad) {
            revert CarryOutOfBounds();
        }

        id = uint8(_configs.length);
        OptionToken token = _TOKEN_FACTORY.deployToken(name, symbol, address(this));
        _configs.push(config);
        _configs[id].token = token;
        _storeHot(id);

        MarketState memory initialState;
        initialState.normFactor = uint128(WAD);
        initialState.lastAccrual = uint64(block.timestamp);
        initialState.baseCarryWad = initialBaseCarryWad;
        initialState.baseCarryUpdatedAt = uint64(block.timestamp);
        _states.push(initialState);
        _idPlusOne[address(token)] = id + 1;

        Env memory env = _env();
        (bool valid, uint256 spot, uint256 indexWad, uint256 updatedAt,) = _readOracle(_hot[id]);
        if (!valid) revert OracleInvalid();
        MarketState storage state = _states[id];
        state.lastGoodPrice = uint128(spot);
        state.lastGoodIndex = uint128(indexWad);
        state.lastGoodAt = uint64(updatedAt);
        state.regime = _mark(id, env).regime;
        _refreshAll(env, id, false);

        _emitMarketListed(id, token);
    }

    /// @notice Updates mutable risk and carry parameters for an existing market.
    function setMarketConfig(uint8 id, MarketConfig calldata config) external override onlyRole(DEFAULT_ADMIN_ROLE) {
        _requireMarket(id);
        Env memory env = _env();
        _refreshAll(env, id, true);

        MarketConfig storage current = _configs[id];
        if (
            address(config.stock) != address(current.stock) || address(config.feed) != address(current.feed)
                || address(config.token) != address(current.token) || config.scale != current.scale
                || config.kind != current.kind
        ) {
            revert InvalidMarketConfig();
        }
        _HELPER.validate(config);
        MarketState storage state = _states[id];
        if (state.baseCarryWad < config.baseCarryMinWad || state.baseCarryWad > config.baseCarryMaxWad) {
            revert CarryOutOfBounds();
        }

        _configs[id] = config;
        _storeHot(id);
        emit MarketConfigUpdated(id);
        _refreshAll(env, id, false);
    }

    /// @notice Updates protocol-wide exposure, fee routing, and sequencer settings.
    function setGlobal(
        uint16 maxGlobalExposureBps_,
        uint16 protocolFeeShareBps_,
        address treasury_,
        address sequencerFeed_
    ) external override onlyRole(DEFAULT_ADMIN_ROLE) {
        _HELPER.validateGlobal(maxGlobalExposureBps_, protocolFeeShareBps_, treasury_);
        maxGlobalExposureBps = maxGlobalExposureBps_;
        protocolFeeShareBps = protocolFeeShareBps_;
        treasury = treasury_;
        sequencerFeed = IAggregatorV3(sequencerFeed_);
        emit GlobalConfigUpdated(maxGlobalExposureBps_, protocolFeeShareBps_, treasury_, sequencerFeed_);
    }

    /// @notice Moves a market's base carry by at most 25% once per 24-hour window.
    function setBaseCarry(uint8 id, int64 wad) external override onlyRole(KEEPER_ROLE) {
        _requireMarket(id);
        _refreshAll(_env(), id, true);
        MarketConfig storage config = _configs[id];
        MarketState storage state = _states[id];
        if (wad < config.baseCarryMinWad || wad > config.baseCarryMaxWad) revert CarryOutOfBounds();
        if (wad == state.baseCarryWad) return;
        if (block.timestamp < uint256(state.baseCarryUpdatedAt) + CARRY_DAY) revert CarryChangeTooFast();

        _HELPER.checkBaseCarryStep(state.baseCarryWad, wad, config.baseCarryMaxWad);

        state.baseCarryWad = wad;
        state.baseCarryUpdatedAt = uint64(block.timestamp);
        emit BaseCarryUpdated(id, wad);
    }

    /// @notice Stops new buys for one market without blocking sells.
    function setBuysPaused(uint8 id, bool paused) external override onlyRole(GUARDIAN_ROLE) {
        _requireMarket(id);
        MarketState storage state = _states[id];
        if (state.buysPaused == paused) return;
        state.buysPaused = paused;
        emit BuysPaused(id, paused);
    }

    /// @notice Stops new buys for every market without blocking sells.
    function setGlobalBuysPaused(bool paused) external override onlyRole(GUARDIAN_ROLE) {
        if (globalBuysPaused == paused) return;
        globalBuysPaused = paused;
        emit GlobalBuysPaused(paused);
    }

    /// @notice Applies carry and refreshes oracle state for one market.
    function accrue(uint8 id) external override {
        _requireMarket(id);
        _refreshAll(_env(), id, true);
    }

    /// @notice Applies carry and refreshes oracle state for all markets.
    function accrueAll() external override {
        (Mark[] memory marks, uint256 total) = _book(_env());
        uint256 count = marks.length;
        for (uint256 i; i < count; ++i) {
            _applyAccrual(uint8(i), marks[i]);
        }
        int256 navWad = vault.navFor(total, _spotsOf(marks));
        for (uint256 i; i < count; ++i) {
            _storeUtil(uint8(i), marks[i].liability, navWad);
        }
    }

    /// @notice Buys OptionTokens with an existing USDG allowance.
    function buy(uint8 id, uint256 usdgIn, uint256 minTokensOut, address recipient, uint256 deadline)
        external
        override
        nonReentrant
        returns (uint256 tokensOut)
    {
        return _buy(id, usdgIn, minTokensOut, recipient, deadline);
    }

    /// @notice Attempts an ERC-2612 permit, then buys OptionTokens.
    /// @dev A failed permit is ignored; the subsequent transferFrom enforces the current allowance.
    function buyWithPermit(
        uint8 id,
        uint256 usdgIn,
        uint256 minTokensOut,
        address recipient,
        uint256 deadline,
        uint256 permitDeadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external override nonReentrant returns (uint256 tokensOut) {
        try IERC20Permit(address(usdg)).permit(msg.sender, address(this), usdgIn, permitDeadline, v, r, s) {} catch {}
        return _buy(id, usdgIn, minTokensOut, recipient, deadline);
    }

    /// @notice Sells the caller's OptionTokens. No approval is needed and buy pauses never block this path.
    function sell(uint8 id, uint256 tokensIn, uint256 minUsdgOut, address recipient, uint256 deadline)
        external
        override
        nonReentrant
        returns (uint256 usdgOut)
    {
        _requireMarket(id);
        if (deadline < block.timestamp) revert Expired();
        if (recipient == address(0)) revert ZeroAddress();
        if (tokensIn == 0) revert TradeTooSmall();
        MarketState storage state = _states[id];
        if (tokensIn > state.vaultShort) revert TradeTooLarge();

        (Mark[] memory marks, uint256 total) = _book(_env());
        Mark memory m = marks[id];
        _applyAccrual(id, m);
        uint256[] memory spots = _spotsOf(marks);
        int256 navWad = vault.navFor(total, spots);

        Quote memory quote = _quoteSell(_configs[id], m, navWad, tokensIn);
        if (m.regime == Regime.PAUSED) _consumePausedSellCap(id, quote.grossUsdg);

        _configs[id].token.burn(msg.sender, tokensIn);
        uint256 vaultShort = state.vaultShort - tokensIn;
        state.vaultShort = uint128(vaultShort);
        // The vault deducts any hedge-sale execution shortfall, so the seller (not the LPs) bears it.
        usdgOut = vault.pay(recipient, quote.amountOut, id);
        if (usdgOut < minUsdgOut) revert Slippage();
        uint256 treasuryFee = Math.mulDiv(quote.fee, protocolFeeShareBps, BPS);
        if (treasuryFee != 0) vault.pay(treasury, treasuryFee, id);

        uint256 newLiability = Math.mulDiv(vaultShort, m.price, WAD);
        _storeUtil(id, newLiability, vault.navFor(total - m.liability + newLiability, spots));
        emit Sold(id, msg.sender, recipient, tokensIn, usdgOut, quote.fee, quote.price, m.index, m.normFactor);
    }

    /// @notice Returns the number of listed markets.
    function marketCount() external view override returns (uint8) {
        return uint8(_configs.length);
    }

    /// @notice Returns immutable identity and mutable risk parameters for a market.
    function getConfig(uint8 id) external view override returns (MarketConfig memory) {
        _requireMarket(id);
        return _configs[id];
    }

    /// @notice Returns the last stored accrual and oracle state for a market.
    function getState(uint8 id) external view override returns (MarketState memory) {
        _requireMarket(id);
        return _states[id];
    }

    /// @notice Returns the live market regime, including feed and sequencer guards.
    function currentRegime(uint8 id) external view override returns (Regime) {
        return _markOf(id).regime;
    }

    /// @notice Returns the feed spot and update time. `valid` is false for malformed or future rounds.
    function spotPrice(uint8 id) external view override returns (uint256 spot, uint256 updatedAt, bool valid) {
        Mark memory m = _markOf(id);
        return (m.liveSpot, m.updatedAt, m.valid);
    }

    /// @notice Returns the live squared-price index, or the last good index while paused.
    function index(uint8 id) external view override returns (uint256 indexWad) {
        return _markOf(id).index;
    }

    /// @notice Returns normFactor projected to the current timestamp using stored carry and utilization.
    function currentNormFactor(uint8 id) external view override returns (uint256 normFactor) {
        return _markOf(id).normFactor;
    }

    /// @notice Returns the current fair price per 1e18 OptionTokens in WAD USD.
    function tokenPrice(uint8 id) external view override returns (uint256 priceWad) {
        return _markOf(id).price;
    }

    /// @notice Returns the daily carry fraction in WAD for the current regime.
    function currentCarryWad(uint8 id) external view override returns (int256 carryWad) {
        return _markOf(id).carry;
    }

    /// @notice Returns the current carry rate in basis points per day.
    function dailyCarryBps(uint8 id) external view override returns (int256 carryBps) {
        return _markOf(id).carry * int256(BPS) / int256(WAD);
    }

    /// @notice Returns the current USD liability of a market in WAD.
    function liability(uint8 id) external view override returns (uint256 liabilityWad) {
        return _markOf(id).liability;
    }

    /// @notice Returns the sum of current market liabilities in WAD USD.
    function totalLiability() external view override returns (uint256 liabilityWad) {
        (, liabilityWad) = _book(_env());
    }

    /// @notice Returns every market's regime spot, liability, and regime plus the total liability in one pass.
    function valuation() external view override returns (uint256 totalLiabilityWad, ValuationMark[] memory marks) {
        Mark[] memory book;
        (book, totalLiabilityWad) = _book(_env());
        marks = new ValuationMark[](book.length);
        for (uint256 i; i < book.length; ++i) {
            marks[i] = ValuationMark({spot: book[i].spot, liability: book[i].liability, regime: book[i].regime});
        }
    }

    /// @notice Returns the underlying-stock delta in WAD stock tokens.
    function hedgeDelta(uint8 id) external view override returns (uint256 units) {
        Mark memory m = _markOf(id);
        uint256 numerator = Math.mulDiv(_states[id].vaultShort, m.normFactor, WAD);
        return Math.mulDiv(numerator, 2 * m.spot, uint256(_hot[id].scale) * WAD);
    }

    /// @notice Returns an executable-side buy estimate plus the gross input remaining under configured caps.
    function quoteBuy(uint8 id, uint256 usdgIn)
        external
        view
        override
        returns (uint256 tokensOut, uint256 fee, uint256 price, uint256 maxUsdgIn)
    {
        _requireMarket(id);
        (Mark[] memory marks, uint256 total) = _book(_env());
        Mark memory m = marks[id];
        _requireBuyable(id, m);
        int256 navWad = vault.navFor(total, _spotsOf(marks));
        MarketConfig storage config = _configs[id];
        Quote memory quote = _quoteBuy(config, m, navWad, usdgIn);
        return (quote.amountOut, quote.fee, quote.price, _HELPER.maxUsdgIn(id));
    }

    /// @notice Returns an executable-side sell estimate in USDG.
    function quoteSell(uint8 id, uint256 tokensIn)
        external
        view
        override
        returns (uint256 usdgOut, uint256 fee, uint256 price)
    {
        _requireMarket(id);
        (Mark[] memory marks, uint256 total) = _book(_env());
        int256 navWad = vault.navFor(total, _spotsOf(marks));
        Quote memory quote = _quoteSell(_configs[id], marks[id], navWad, tokensIn);
        return (quote.amountOut, quote.fee, quote.price);
    }

    /// @notice Resolves a listed token to its zero-based market id.
    function marketIdOf(address token) external view override returns (uint8 id) {
        uint8 idPlusOne = _idPlusOne[token];
        if (idPlusOne == 0) revert MarketNotFound();
        return idPlusOne - 1;
    }

    function _buy(uint8 id, uint256 usdgIn, uint256 minTokensOut, address recipient, uint256 deadline)
        private
        returns (uint256 tokensOut)
    {
        _requireMarket(id);
        if (deadline < block.timestamp) revert Expired();
        if (recipient == address(0)) revert ZeroAddress();
        MarketState storage state = _states[id];
        if (state.buysPaused || globalBuysPaused) revert BuysPausedErr();
        MarketConfig storage config = _configs[id];
        if (usdgIn < config.minTradeUsdg) revert TradeTooSmall();
        if (usdgIn > config.maxTradeUsdg) revert TradeTooLarge();

        (Mark[] memory marks, uint256 total) = _book(_env());
        Mark memory m = marks[id];
        _applyAccrual(id, m);
        _requireBuyable(id, m);
        uint256[] memory spots = _spotsOf(marks);
        int256 navWad = vault.navFor(total, spots);

        Quote memory quote = _quoteBuy(config, m, navWad, usdgIn);
        tokensOut = quote.amountOut;
        if (tokensOut == 0 || tokensOut < minTokensOut) revert Slippage();
        uint256 vaultShort = uint256(state.vaultShort) + tokensOut;
        _checkBuyCaps(config, m, navWad, total, tokensOut, vaultShort);

        usdg.safeTransferFrom(msg.sender, address(vault), usdgIn);
        uint256 treasuryFee = Math.mulDiv(quote.fee, protocolFeeShareBps, BPS);
        if (treasuryFee != 0) vault.pay(treasury, treasuryFee, id);

        config.token.mint(recipient, tokensOut);
        state.vaultShort = uint128(vaultShort);

        uint256 newLiability = Math.mulDiv(vaultShort, m.price, WAD);
        _storeUtil(id, newLiability, vault.navFor(total - m.liability + newLiability, spots));
        emit Bought(id, msg.sender, recipient, usdgIn, quote.fee, tokensOut, quote.price, m.index, m.normFactor);
    }

    function _storeHot(uint8 id) private {
        MarketConfig storage config = _configs[id];
        MarketHot storage hot = _hot[id];
        hot.feed = config.feed;
        hot.scale = config.scale;
        hot.maxAgeOpen = config.maxAgeOpen;
        hot.stock = config.stock;
        hot.maxAgeOffHours = config.maxAgeOffHours;
        hot.offHoursCarryWad = config.offHoursCarryWad;
        hot.skewCarryWad = config.skewCarryWad;
        hot.minCarryWad = config.minCarryWad;
        hot.maxCarryWad = config.maxCarryWad;
    }

    function _emitMarketListed(uint8 id, OptionToken token) private {
        MarketConfig storage config = _configs[id];
        emit MarketListed(id, address(token), address(config.stock), address(config.feed), config.scale);
    }

    function _quoteBuy(MarketConfig storage config, Mark memory m, int256 navWad, uint256 usdgIn)
        private
        view
        returns (Quote memory quote)
    {
        quote.price = _tradePrice(config, m.price, m.regime, usdgIn, _capacityUsdg(config, navWad), false);
        quote.fee = LemniscateMath.bpsUp(usdgIn, config.feeBps);
        if (quote.fee >= usdgIn || quote.price == 0) return quote;
        uint256 netWad = (usdgIn - quote.fee) * USDG_TO_WAD;
        quote.amountOut = Math.mulDiv(netWad, WAD, quote.price);
    }

    function _quoteSell(MarketConfig storage config, Mark memory m, int256 navWad, uint256 tokensIn)
        private
        view
        returns (Quote memory quote)
    {
        uint256 fairGrossUsdg = Math.mulDiv(tokensIn, m.price, WAD) / USDG_TO_WAD;
        quote.price = _tradePrice(config, m.price, m.regime, fairGrossUsdg, _capacityUsdg(config, navWad), true);
        if (quote.price == 0) return quote;
        quote.grossUsdg = Math.mulDiv(tokensIn, quote.price, WAD) / USDG_TO_WAD;
        quote.fee = LemniscateMath.bpsUp(quote.grossUsdg, config.feeBps);
        quote.amountOut = quote.grossUsdg > quote.fee ? quote.grossUsdg - quote.fee : 0;
    }

    function _tradePrice(
        MarketConfig storage config,
        uint256 fairPrice,
        Regime regime,
        uint256 tradeUsdg,
        uint256 capacityUsdg,
        bool isSell
    ) private view returns (uint256) {
        (uint256 spreadBps, uint256 bandBps) = _spreadAndBand(config, regime);
        uint256 configImpact = config.impactBps;
        uint256 impactBps;
        if (configImpact != 0) {
            if (capacityUsdg == 0) {
                impactBps = bandBps;
            } else if (tradeUsdg >= Math.mulDiv(capacityUsdg, bandBps, configImpact)) {
                impactBps = bandBps;
            } else {
                impactBps = Math.mulDiv(configImpact, tradeUsdg, capacityUsdg);
            }
        }
        uint256 devBps = spreadBps + impactBps;
        if (devBps > bandBps) devBps = bandBps;
        uint256 adjustment = Math.mulDiv(fairPrice, devBps, BPS);
        return isSell ? fairPrice - adjustment : fairPrice + adjustment;
    }

    function _spreadAndBand(MarketConfig storage config, Regime regime)
        private
        view
        returns (uint256 spreadBps, uint256 bandBps)
    {
        if (regime == Regime.OPEN) return (config.openSpreadBps, config.openBandBps);
        if (regime == Regime.OFF_HOURS) return (config.offHoursSpreadBps, config.offHoursBandBps);
        return (config.pausedSpreadBps, PAUSED_BAND_BPS);
    }

    function _checkBuyCaps(
        MarketConfig storage config,
        Mark memory m,
        int256 navWad,
        uint256 total,
        uint256 tokensOut,
        uint256 vaultShortAfter
    ) private view {
        if (vaultShortAfter > type(uint128).max) revert MarketCapExceeded();
        if (navWad <= 0) revert GlobalCapExceeded();
        uint256 nav = uint256(navWad);
        uint256 addedLiability = Math.mulDiv(tokensOut, m.price, WAD, Math.Rounding.Ceil);
        uint256 newMarketLiability = Math.mulDiv(vaultShortAfter, m.price, WAD, Math.Rounding.Ceil);
        if (newMarketLiability > Math.mulDiv(nav, config.maxMarketExposureBps, BPS)) revert MarketCapExceeded();
        if (total + addedLiability > Math.mulDiv(nav, maxGlobalExposureBps, BPS)) revert GlobalCapExceeded();
    }

    /// @dev Leaky-bucket budget: usage decays linearly to zero over PAUSED_SELL_WINDOW, so no interval of any
    /// length lets out more than `cap` plus what has drained since. Legacy field names: `pausedSellBlock` stores the
    /// last paused-sell timestamp (pre-upgrade window indices read as long-expired timestamps).
    function _consumePausedSellCap(uint8 id, uint256 grossUsdg) private {
        MarketState storage state = _states[id];
        uint256 elapsed = block.timestamp - state.pausedSellBlock;
        uint256 used = elapsed >= PAUSED_SELL_WINDOW
            ? 0
            : Math.mulDiv(state.pausedSellUsed, PAUSED_SELL_WINDOW - elapsed, PAUSED_SELL_WINDOW, Math.Rounding.Ceil);
        uint256 cap = _configs[id].pausedSellCapPerBlockUsdg;
        if (grossUsdg > cap || used > cap - grossUsdg) revert PausedSellCapExceeded();
        state.pausedSellBlock = uint64(block.timestamp);
        state.pausedSellUsed = uint128(used + grossUsdg);
    }

    /// @dev Accrues `id`, optionally, and stores fresh utilization for it using one oracle pass over all markets.
    function _refreshAll(Env memory env, uint8 id, bool accrueMarket) private {
        (Mark[] memory marks, uint256 total) = _book(env);
        if (accrueMarket) _applyAccrual(id, marks[id]);
        _storeUtil(id, marks[id].liability, vault.navFor(total, _spotsOf(marks)));
    }

    /// @dev Persists a mark computed at this timestamp. Values equal the post-accrual projection, so callers keep
    /// using the same mark afterwards.
    function _applyAccrual(uint8 id, Mark memory m) private {
        MarketState storage state = _states[id];
        if (state.lastAccrual == block.timestamp) return;
        Regime previousRegime = state.regime;
        state.normFactor = uint128(m.normFactor);
        state.lastAccrual = uint64(block.timestamp);
        state.regime = m.regime;
        if (m.regime != Regime.PAUSED) {
            state.lastGoodPrice = uint128(m.spot);
            state.lastGoodIndex = uint128(m.index);
            state.lastGoodAt = uint64(m.updatedAt);
        }

        if (previousRegime != m.regime) emit RegimeChanged(id, previousRegime, m.regime);
        emit Accrued(id, uint128(m.normFactor), int64(m.carry), m.regime, m.index);
    }

    function _previewNormFactor(MarketState storage state, int256 carryWad) private view returns (uint256) {
        uint256 normFactor = state.normFactor;
        uint256 lastAccrual = state.lastAccrual;
        uint256 elapsed = block.timestamp > lastAccrual ? block.timestamp - lastAccrual : 0;
        if (elapsed > MAX_ACCRUAL) elapsed = MAX_ACCRUAL;
        if (elapsed == 0 || carryWad <= 0) return normFactor;

        uint256 decay = Math.mulDiv(uint256(carryWad), elapsed, CARRY_DAY);
        if (decay >= WAD) return MIN_NORM_FACTOR;
        uint256 projected = Math.mulDiv(normFactor, WAD - decay, WAD);
        return projected < MIN_NORM_FACTOR ? MIN_NORM_FACTOR : projected;
    }

    function _carry(MarketHot storage config, MarketState storage state, Regime regime)
        private
        view
        returns (int256 carryWad)
    {
        if (regime != Regime.OPEN) return int256(config.offHoursCarryWad);
        carryWad =
            int256(state.baseCarryWad) + int256(config.skewCarryWad) * int256(uint256(state.lastUtilBps)) / int256(BPS);
        if (carryWad < config.minCarryWad) carryWad = config.minCarryWad;
        if (carryWad > config.maxCarryWad) carryWad = config.maxCarryWad;
    }

    function _storeUtil(uint8 id, uint256 liabilityWad, int256 navWad) private {
        uint256 utilization = BPS;
        if (navWad > 0) {
            uint256 capacity = Math.mulDiv(uint256(navWad), _configs[id].maxMarketExposureBps, BPS);
            if (capacity != 0) {
                utilization = Math.mulDiv(liabilityWad, BPS, capacity);
                if (utilization > BPS) utilization = BPS;
            }
        }
        _states[id].lastUtilBps = uint16(utilization);
    }

    function _capacityUsdg(MarketConfig storage config, int256 navWad) private view returns (uint256) {
        if (navWad <= 0) return 0;
        return Math.mulDiv(uint256(navWad), config.maxMarketExposureBps, BPS) / USDG_TO_WAD;
    }

    function _book(Env memory env) private view returns (Mark[] memory marks, uint256 total) {
        uint256 count = _configs.length;
        marks = new Mark[](count);
        for (uint256 i; i < count; ++i) {
            Mark memory m = _mark(uint8(i), env);
            marks[i] = m;
            total += m.liability;
        }
    }

    function _spotsOf(Mark[] memory marks) private pure returns (uint256[] memory spots) {
        spots = new uint256[](marks.length);
        for (uint256 i; i < marks.length; ++i) {
            spots[i] = marks[i].spot;
        }
    }

    function _markOf(uint8 id) private view returns (Mark memory) {
        _requireMarket(id);
        return _mark(id, _env());
    }

    function _mark(uint8 id, Env memory env) private view returns (Mark memory m) {
        MarketHot storage hot = _hot[id];
        MarketState storage state = _states[id];
        bool stockPaused;
        (m.valid, m.liveSpot, m.index, m.updatedAt, stockPaused) = _readOracle(hot);

        if (stockPaused || env.sequencerDown || !m.valid) {
            m.regime = Regime.PAUSED;
        } else {
            uint256 maxAge = env.open ? hot.maxAgeOpen : hot.maxAgeOffHours;
            if (block.timestamp - m.updatedAt > maxAge) m.regime = Regime.PAUSED;
            else m.regime = env.open ? Regime.OPEN : Regime.OFF_HOURS;
        }

        if (m.regime == Regime.PAUSED) {
            // A paused market marks at the last good accrued price, unless a newer well-formed round is lower: the
            // last good price only refreshes on accrual, so it can lag a fall that happened while nobody traded.
            // A drop of half the spot or more is treated as a corporate-action transient and ignored.
            uint256 goodIndex = state.lastGoodIndex;
            if (!m.valid || m.updatedAt <= state.lastGoodAt || m.index >= goodIndex || m.index * 4 <= goodIndex) {
                m.spot = state.lastGoodPrice;
                m.index = goodIndex;
            } else {
                m.spot = m.liveSpot;
            }
        } else {
            m.spot = m.liveSpot;
        }
        m.carry = _carry(hot, state, m.regime);
        m.normFactor = _previewNormFactor(state, m.carry);
        m.price = Math.mulDiv(m.normFactor, m.index, WAD);
        m.liability = Math.mulDiv(state.vaultShort, m.price, WAD);
    }

    function _readOracle(MarketHot storage hot)
        private
        view
        returns (bool valid, uint256 spot, uint256 indexWad, uint256 updatedAt, bool stockPaused)
    {
        try hot.feed.latestRoundData() returns (uint80, int256 answer, uint256, uint256 updatedAt_, uint80) {
            updatedAt = updatedAt_;
            if (
                answer > 0 && updatedAt_ != 0 && updatedAt_ <= block.timestamp
                    && uint256(answer) <= MAX_SPOT_WAD / FEED_TO_WAD
            ) {
                uint256 liveSpot = uint256(answer) * FEED_TO_WAD;
                uint256 liveIndex = Math.mulDiv(liveSpot, liveSpot, WAD) / hot.scale;
                if (liveIndex != 0 && liveIndex <= type(uint128).max) {
                    spot = liveSpot;
                    indexWad = liveIndex;
                    valid = true;
                }
            }
        } catch {}

        try hot.stock.oraclePaused() returns (bool paused) {
            stockPaused = paused;
        } catch {
            stockPaused = true;
        }
    }

    /// @dev Buys need a live regime and, off-hours, a feed round younger than `offHoursBuyMaxAge`. A token-level
    /// (beacon-wide) pause freezes stock transfers, so the vault cannot hedge new exposure. Checked only when opening
    /// exposure; sells stay available and can be paid from cash.
    function _requireBuyable(uint8 id, Mark memory m) private view {
        if (m.regime == Regime.PAUSED) revert RegimePaused();
        if (m.regime == Regime.OFF_HOURS) {
            uint256 maxAge = _configs[id].offHoursBuyMaxAge;
            if (maxAge != 0 && block.timestamp - m.updatedAt > maxAge) revert RegimePaused();
        }
        try _hot[id].stock.paused() returns (bool paused) {
            if (paused) revert RegimePaused();
        } catch {
            revert RegimePaused();
        }
    }

    function _env() private view returns (Env memory env) {
        env.sequencerDown = _sequencerDown();
        try marketHours.isOpen(block.timestamp) returns (bool open) {
            env.open = open;
        } catch {}
    }

    function _sequencerDown() private view returns (bool) {
        IAggregatorV3 feed = sequencerFeed;
        if (address(feed) == address(0)) return false;
        try feed.latestRoundData() returns (uint80, int256 answer, uint256 startedAt, uint256, uint80) {
            if (answer != 0 || startedAt == 0 || startedAt > block.timestamp) return true;
            return block.timestamp - startedAt < SEQUENCER_GRACE_PERIOD;
        } catch {
            return true;
        }
    }

    function _requireMarket(uint8 id) private view {
        if (id >= _configs.length) revert MarketNotFound();
    }

    function _authorizeUpgrade(address) internal override onlyRole(DEFAULT_ADMIN_ROLE) {}

    uint256[40] private __gap;
}
