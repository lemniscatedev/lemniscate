// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IAggregatorV3} from "../interfaces/IAggregatorV3.sol";
import {IStockToken} from "../interfaces/IStockToken.sol";
import {OptionToken} from "../OptionToken.sol";

enum Regime {
    OPEN,
    OFF_HOURS,
    PAUSED
}

struct Session {
    uint64 open;
    uint64 close;
}

struct MarketConfig {
    IStockToken stock;
    IAggregatorV3 feed;
    OptionToken token;
    uint64 scale;
    uint16 feeBps;
    uint16 openSpreadBps;
    uint16 offHoursSpreadBps;
    uint16 pausedSpreadBps;
    uint16 openBandBps;
    uint16 offHoursBandBps;
    uint16 impactBps;
    uint16 maxMarketExposureBps;
    uint128 maxTradeUsdg;
    uint128 minTradeUsdg;
    uint128 pausedSellCapPerBlockUsdg;
    int64 offHoursCarryWad;
    int64 skewCarryWad;
    int64 minCarryWad;
    int64 maxCarryWad;
    int64 baseCarryMinWad;
    int64 baseCarryMaxWad;
    uint32 maxAgeOpen;
    uint32 maxAgeOffHours;
    uint8 kind;
    address feed2;
    /// @dev Off-hours buys revert once the feed round is older than this many seconds (0 = no limit). Weekend moves
    /// are public on 24/7 venues, so a held Friday close is a free option for buyers.
    uint64 offHoursBuyMaxAge;
}

struct MarketState {
    uint128 normFactor;
    uint64 lastAccrual;
    Regime regime;
    bool buysPaused;
    int64 baseCarryWad;
    uint64 baseCarryUpdatedAt;
    uint128 lastGoodIndex;
    uint128 lastGoodPrice;
    uint64 lastGoodAt;
    uint128 vaultShort;
    uint16 lastUtilBps;
    /// @dev Timestamp of the last paused sell; `pausedSellUsed` decays linearly to zero over one window after it.
    uint64 pausedSellBlock;
    uint128 pausedSellUsed;
}

/// @notice Per-market valuation input the engine hands to the vault: regime spot, liability, and regime.
struct ValuationMark {
    uint256 spot;
    uint256 liability;
    Regime regime;
}

struct MarketView {
    uint8 id;
    address token;
    address stock;
    string symbol;
    uint64 scale;
    uint8 regime;
    bool buysPaused;
    uint256 spot;
    uint256 spotUpdatedAt;
    uint256 index;
    uint256 normFactor;
    uint256 price;
    int256 carryWad;
    uint256 vaultShort;
    uint256 liability;
    uint256 capacityUsdg;
    uint256 hedgeUnits;
    uint256 hedgeTarget;
    uint256 bidPrice1;
    uint256 askPrice1;
    uint256 multiplier;
    uint256 pendingMultiplier;
    uint256 multiplierEffectiveAt;
    bool oraclePaused;
}

struct VaultView {
    int256 nav;
    uint256 totalAssets;
    uint256 totalSupply;
    uint256 navPerShare;
    uint256 usdgBalance;
    uint256 totalLiability;
    uint16 maxGlobalExposureBps;
    bool publicDeposits;
}

struct AccountView {
    address user;
    uint256 usdgBalance;
    uint256 usdgAllowanceEngine;
    uint256 usdgAllowanceVault;
    uint256[] powerBalances;
    uint256 writerPoolShares;
    uint256 writerPoolValue;
    uint256 unlockTime;
    bool isDepositor;
}
