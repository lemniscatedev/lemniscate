// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IAggregatorV3} from "./IAggregatorV3.sol";
import {IWriterPool} from "./IWriterPool.sol";
import {IMarketHours} from "./IMarketHours.sol";
import {MarketConfig, MarketState, Regime, ValuationMark} from "../libs/LemniscateTypes.sol";

interface ILemniscateEngine is IAccessControl {
    error ZeroAddress();
    error InvalidMarketConfig();
    error MarketNotFound();
    error BuysPausedErr();
    error RegimePaused();
    error Slippage();
    error Expired();
    error TradeTooSmall();
    error TradeTooLarge();
    error MarketCapExceeded();
    error GlobalCapExceeded();
    error PausedSellCapExceeded();
    error OracleInvalid();
    error InsufficientLiquidity();
    error CarryOutOfBounds();
    error CarryChangeTooFast();

    event MarketListed(uint8 indexed id, address indexed token, address indexed stock, address feed, uint64 scale);
    event MarketConfigUpdated(uint8 indexed id);
    event Accrued(uint8 indexed id, uint128 normFactor, int64 carryWad, Regime regime, uint256 index);
    event RegimeChanged(uint8 indexed id, Regime from, Regime to);
    event Bought(
        uint8 indexed id,
        address indexed buyer,
        address indexed recipient,
        uint256 usdgIn,
        uint256 fee,
        uint256 tokensOut,
        uint256 price,
        uint256 index,
        uint256 normFactor
    );
    event Sold(
        uint8 indexed id,
        address indexed seller,
        address indexed recipient,
        uint256 tokensIn,
        uint256 usdgOut,
        uint256 fee,
        uint256 price,
        uint256 index,
        uint256 normFactor
    );
    event BaseCarryUpdated(uint8 indexed id, int64 wad);
    event BuysPaused(uint8 indexed id, bool paused);
    event GlobalBuysPaused(bool paused);
    event GlobalConfigUpdated(
        uint16 maxGlobalExposureBps, uint16 protocolFeeShareBps, address treasury, address sequencerFeed
    );

    function KEEPER_ROLE() external view returns (bytes32);

    function GUARDIAN_ROLE() external view returns (bytes32);

    function usdg() external view returns (IERC20);

    function vault() external view returns (IWriterPool);

    function marketHours() external view returns (IMarketHours);

    function treasury() external view returns (address);

    function maxGlobalExposureBps() external view returns (uint16);

    function protocolFeeShareBps() external view returns (uint16);

    function globalBuysPaused() external view returns (bool);

    function sequencerFeed() external view returns (IAggregatorV3);

    function marketIdOf(address token) external view returns (uint8);

    function initialize(address admin, IERC20 usdg_, IWriterPool vault_, IMarketHours hours_, address treasury_) external;

    function listMarket(
        MarketConfig calldata config,
        string calldata name,
        string calldata symbol,
        int64 initialBaseCarryWad
    ) external returns (uint8 id);

    function setMarketConfig(uint8 id, MarketConfig calldata config) external;

    function setGlobal(
        uint16 maxGlobalExposureBps_,
        uint16 protocolFeeShareBps_,
        address treasury_,
        address sequencerFeed_
    ) external;

    function setBaseCarry(uint8 id, int64 wad) external;

    function setBuysPaused(uint8 id, bool paused) external;

    function setGlobalBuysPaused(bool paused) external;

    function accrue(uint8 id) external;

    function accrueAll() external;

    function buy(uint8 id, uint256 usdgIn, uint256 minTokensOut, address recipient, uint256 deadline)
        external
        returns (uint256 tokensOut);

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
    ) external returns (uint256 tokensOut);

    function sell(uint8 id, uint256 tokensIn, uint256 minUsdgOut, address recipient, uint256 deadline)
        external
        returns (uint256 usdgOut);

    function marketCount() external view returns (uint8);

    function getConfig(uint8 id) external view returns (MarketConfig memory);

    function getState(uint8 id) external view returns (MarketState memory);

    function currentRegime(uint8 id) external view returns (Regime);

    function spotPrice(uint8 id) external view returns (uint256 spot, uint256 updatedAt, bool valid);

    function index(uint8 id) external view returns (uint256 indexWad);

    function currentNormFactor(uint8 id) external view returns (uint256 normFactor);

    function tokenPrice(uint8 id) external view returns (uint256 priceWad);

    function currentCarryWad(uint8 id) external view returns (int256 carryWad);

    function dailyCarryBps(uint8 id) external view returns (int256 carryBps);

    function liability(uint8 id) external view returns (uint256 liabilityWad);

    function totalLiability() external view returns (uint256 liabilityWad);

    function valuation() external view returns (uint256 totalLiabilityWad, ValuationMark[] memory marks);

    function hedgeDelta(uint8 id) external view returns (uint256 units);

    function quoteBuy(uint8 id, uint256 usdgIn)
        external
        view
        returns (uint256 tokensOut, uint256 fee, uint256 price, uint256 maxUsdgIn);

    function quoteSell(uint8 id, uint256 tokensIn) external view returns (uint256 usdgOut, uint256 fee, uint256 price);
}
