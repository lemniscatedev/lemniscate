// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IStockToken} from "../../src/interfaces/IStockToken.sol";
import {MarketConfig, MarketState, Regime, ValuationMark} from "../../src/libs/LemniscateTypes.sol";

/// @dev Narrow engine double exposing the view surface WriterPool consumes.
contract MockVaultEngine {
    bytes32 public constant KEEPER_ROLE = keccak256("KEEPER_ROLE");

    IERC20 public immutable usdg;
    uint16 public maxGlobalExposureBps = 5_000;

    MarketConfig[] private _configs;
    MarketState[] private _states;
    uint256[] private _spots;
    bool[] private _spotValid;
    uint256[] private _liabilities;
    uint256[] private _deltas;

    constructor(IERC20 usdg_) {
        usdg = usdg_;
    }

    function addMarket(IStockToken stock, uint256 spot) external returns (uint8 id) {
        id = uint8(_configs.length);
        MarketConfig memory config;
        config.stock = stock;
        _configs.push(config);

        MarketState memory state;
        state.regime = Regime.OPEN;
        state.lastGoodPrice = uint128(spot);
        _states.push(state);
        _spots.push(spot);
        _spotValid.push(true);
        _liabilities.push(0);
        _deltas.push(0);
    }

    function marketCount() external view returns (uint8) {
        return uint8(_configs.length);
    }

    function getConfig(uint8 id) external view returns (MarketConfig memory) {
        return _configs[id];
    }

    function getState(uint8 id) external view returns (MarketState memory) {
        return _states[id];
    }

    function currentRegime(uint8 id) external view returns (Regime) {
        return _states[id].regime;
    }

    function spotPrice(uint8 id) external view returns (uint256 spot, uint256 updatedAt, bool valid) {
        return (_spots[id], block.timestamp, _spotValid[id]);
    }

    function liability(uint8 id) external view returns (uint256) {
        return _liabilities[id];
    }

    function totalLiability() external view returns (uint256 total) {
        for (uint256 i; i < _liabilities.length; ++i) {
            total += _liabilities[i];
        }
    }

    function valuation() external view returns (uint256 total, ValuationMark[] memory marks) {
        uint256 count = _configs.length;
        marks = new ValuationMark[](count);
        for (uint256 i; i < count; ++i) {
            MarketState memory state = _states[i];
            uint256 spot = state.regime == Regime.PAUSED || !_spotValid[i] ? state.lastGoodPrice : _spots[i];
            marks[i] = ValuationMark({spot: spot, liability: _liabilities[i], regime: state.regime});
            total += _liabilities[i];
        }
    }

    function hedgeDelta(uint8 id) external view returns (uint256) {
        return _deltas[id];
    }

    function setMaxGlobalExposureBps(uint16 value) external {
        maxGlobalExposureBps = value;
    }

    function setMarket(
        uint8 id,
        Regime regime,
        uint256 spot,
        bool valid,
        uint256 lastGoodPrice,
        uint256 liabilityWad,
        uint256 delta
    ) external {
        MarketState storage state = _states[id];
        state.regime = regime;
        state.lastGoodPrice = uint128(lastGoodPrice);
        _spots[id] = spot;
        _spotValid[id] = valid;
        _liabilities[id] = liabilityWad;
        _deltas[id] = delta;
    }
}
