// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {ILemniscateEngine} from "./interfaces/ILemniscateEngine.sol";
import {MarketConfig, Regime, ValuationMark} from "./libs/LemniscateTypes.sol";

/// @notice Admin validation and view-only math moved out of LemniscateEngine to keep it under the EIP-170 size limit.
/// @dev Deployed by the engine's constructor. Reverts use the same selectors as ILemniscateEngine, so callers see the
/// engine's errors. Nothing here runs on the buy/sell execution path.
contract EngineHelper {
    uint256 private constant BPS = 10_000;
    uint256 private constant PAUSED_BAND_BPS = 300;
    uint256 private constant USDG_TO_WAD = 1e12;
    uint256 private constant MIN_GLOBAL_EXPOSURE_BPS = 1_000;
    uint256 private constant MAX_FEE_SHARE_BPS = 5_000;

    error InvalidMarketConfig();
    error CarryChangeTooFast();

    /// @notice Reverts unless `next` is within 25% of the current base carry (or of `maxWad` when current is zero).
    function checkBaseCarryStep(int64 current, int64 next, int64 maxWad) external pure {
        uint256 difference = uint256(next >= current ? int256(next) - current : int256(current) - next);
        // A zero base carry would otherwise allow no step at all; measure from the upper bound instead.
        uint256 stepBase = current > 0 ? uint256(int256(current)) : uint256(int256(maxWad));
        if (difference > stepBase * 2_500 / BPS) revert CarryChangeTooFast();
    }

    /// @notice Bounds protocol-wide settings. A zero or tiny exposure cap would freeze LP exits (the vault reserves
    /// liability / cap), so the cap has a floor; the treasury may take at most half of trading fees.
    function validateGlobal(uint256 maxGlobalExposureBps, uint256 protocolFeeShareBps, address treasury) external pure {
        if (
            maxGlobalExposureBps < MIN_GLOBAL_EXPOSURE_BPS || maxGlobalExposureBps > BPS
                || protocolFeeShareBps > MAX_FEE_SHARE_BPS || treasury == address(0)
        ) revert InvalidMarketConfig();
    }

    /// @notice Largest gross USDG buy of market `id` that fits the market and global exposure caps and
    /// `maxTradeUsdg`, for the calling engine's current state. View-only: it reads the engine back.
    function maxUsdgIn(uint8 id) external view returns (uint256) {
        ILemniscateEngine engine = ILemniscateEngine(msg.sender);
        (uint256 total, ValuationMark[] memory marks) = engine.valuation();
        uint256[] memory spots = new uint256[](marks.length);
        for (uint256 i; i < marks.length; ++i) {
            spots[i] = marks[i].spot;
        }
        int256 navWad = engine.vault().navFor(total, spots);
        if (navWad <= 0) return 0;

        MarketConfig memory config = engine.getConfig(id);
        uint256 nav = uint256(navWad);
        uint256 marketLimit = Math.mulDiv(nav, config.maxMarketExposureBps, BPS);
        uint256 globalLimit = Math.mulDiv(nav, engine.maxGlobalExposureBps(), BPS);
        uint256 marketLiability = marks[id].liability;
        uint256 marketRoom = marketLimit > marketLiability ? marketLimit - marketLiability : 0;
        uint256 globalRoom = globalLimit > total ? globalLimit - total : 0;
        uint256 room = marketRoom < globalRoom ? marketRoom : globalRoom;
        if (room == 0) return 0;

        bool open = marks[id].regime == Regime.OPEN;
        uint256 inputRoom = grossInputForRoom(
            room / USDG_TO_WAD,
            marketLimit / USDG_TO_WAD,
            config.feeBps,
            config.impactBps,
            open ? config.openSpreadBps : config.offHoursSpreadBps,
            open ? config.openBandBps : config.offHoursBandBps
        );
        return inputRoom < config.maxTradeUsdg ? inputRoom : config.maxTradeUsdg;
    }

    /// @notice Gross USDG input whose post-fee, post-spread notional fills `roomUsdg` of liability capacity.
    function grossInputForRoom(
        uint256 roomUsdg,
        uint256 capacityUsdg,
        uint256 feeBps,
        uint256 impactBpsConfig,
        uint256 spreadBps,
        uint256 bandBps
    ) public pure returns (uint256 grossUsdg) {
        if (roomUsdg == 0) return 0;
        uint256 feeFactor = BPS - feeBps;
        uint256 impactRoomBps = capacityUsdg == 0 ? bandBps : Math.mulDiv(roomUsdg, impactBpsConfig, capacityUsdg);
        uint256 denominator = impactRoomBps < feeFactor ? feeFactor - impactRoomBps : 0;
        if (denominator == 0) {
            return Math.mulDiv(roomUsdg, BPS + bandBps, feeFactor);
        }

        grossUsdg = Math.mulDiv(roomUsdg, BPS + spreadBps, denominator);
        uint256 impactBps = capacityUsdg == 0 ? bandBps : Math.mulDiv(impactBpsConfig, grossUsdg, capacityUsdg);
        if (spreadBps + impactBps > bandBps) {
            grossUsdg = Math.mulDiv(roomUsdg, BPS + bandBps, feeFactor);
        }
    }

    function validate(MarketConfig calldata config) external view {
        if (
            address(config.stock) == address(0) || address(config.feed) == address(0) || config.scale == 0
                || config.kind != 0 || config.feed2 != address(0) || config.maxMarketExposureBps == 0
                || config.maxMarketExposureBps > BPS || config.feeBps > 100 || config.impactBps > 1_000
                || config.openSpreadBps > config.openBandBps || config.openBandBps > 1_000
                || config.offHoursSpreadBps > config.offHoursBandBps || config.offHoursBandBps > 1_000
                || config.pausedSpreadBps > PAUSED_BAND_BPS || config.minTradeUsdg == 0
                || config.maxTradeUsdg < config.minTradeUsdg || config.pausedSellCapPerBlockUsdg == 0
                || config.maxAgeOpen == 0 || config.maxAgeOffHours == 0 || config.minCarryWad < 0
                || config.offHoursCarryWad < 0 || config.skewCarryWad < 0 || config.maxCarryWad < config.minCarryWad
                || config.baseCarryMinWad < 0 || config.baseCarryMaxWad < config.baseCarryMinWad
        ) revert InvalidMarketConfig();

        uint8 feedDecimals;
        uint8 stockDecimals;
        try config.feed.decimals() returns (uint8 decimals_) {
            feedDecimals = decimals_;
        } catch {
            revert InvalidMarketConfig();
        }
        try config.stock.decimals() returns (uint8 decimals_) {
            stockDecimals = decimals_;
        } catch {
            revert InvalidMarketConfig();
        }
        if (feedDecimals != 8 || stockDecimals != 18) revert InvalidMarketConfig();
    }
}
