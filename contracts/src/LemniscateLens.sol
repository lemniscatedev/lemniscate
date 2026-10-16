// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IWriterPool} from "./interfaces/IWriterPool.sol";
import {ILemniscateLens} from "./interfaces/ILemniscateLens.sol";
import {ILemniscateEngine} from "./interfaces/ILemniscateEngine.sol";
import {MarketConfig, MarketState, MarketView, VaultView, AccountView} from "./libs/LemniscateTypes.sol";
import {OptionToken} from "./OptionToken.sol";

/// @title LemniscateLens
/// @notice Stateless batched views for markets, the vault, and one account.
contract LemniscateLens is ILemniscateLens {
    uint256 private constant BPS = 10_000;
    uint256 private constant USDG_UNIT = 1e6;

    /// @notice Returns all listed markets and their current engine, hedge, and quote state.
    function markets(ILemniscateEngine engine) external view override returns (MarketView[] memory result) {
        uint256 count = engine.marketCount();
        result = new MarketView[](count);
        IWriterPool writerPool = engine.vault();

        for (uint256 i; i < count; ++i) {
            result[i] = _market(engine, writerPool, uint8(i));
        }
    }

    /// @notice Returns current vault NAV, supply, balances, and global liability settings.
    function vault(ILemniscateEngine engine) external view override returns (VaultView memory result) {
        IWriterPool writerPool = engine.vault();
        int256 nav = writerPool.navView();
        result = VaultView({
            nav: nav,
            totalAssets: writerPool.totalAssets(),
            totalSupply: writerPool.totalSupply(),
            navPerShare: writerPool.navPerShareWad(),
            usdgBalance: engine.usdg().balanceOf(address(writerPool)),
            totalLiability: engine.totalLiability(),
            maxGlobalExposureBps: engine.maxGlobalExposureBps(),
            publicDeposits: writerPool.publicDeposits()
        });
    }

    /// @notice Returns one account's token balances, allowances, vault shares, and lock time.
    function account(ILemniscateEngine engine, address user) external view override returns (AccountView memory result) {
        IWriterPool writerPool = engine.vault();
        IERC20 usdg = engine.usdg();
        uint256 count = engine.marketCount();
        uint256[] memory powerBalances = new uint256[](count);

        for (uint256 i; i < count; ++i) {
            MarketConfig memory config = engine.getConfig(uint8(i));
            powerBalances[i] = config.token.balanceOf(user);
        }

        uint256 writerPoolShares = writerPool.balanceOf(user);
        result = AccountView({
            user: user,
            usdgBalance: usdg.balanceOf(user),
            usdgAllowanceEngine: usdg.allowance(user, address(engine)),
            usdgAllowanceVault: usdg.allowance(user, address(writerPool)),
            powerBalances: powerBalances,
            writerPoolShares: writerPoolShares,
            writerPoolValue: writerPool.convertToAssets(writerPoolShares),
            unlockTime: writerPool.unlockTime(user),
            isDepositor: writerPool.isDepositor(user)
        });
    }

    /// @dev Field-by-field assembly split over helpers keeps every frame shallow enough for unoptimized via-IR
    /// builds (coverage), with the same values as a single struct literal.
    function _market(ILemniscateEngine engine, IWriterPool writerPool, uint8 id) private view returns (MarketView memory v) {
        MarketConfig memory config = engine.getConfig(id);
        MarketState memory state = engine.getState(id);
        v.id = id;
        v.token = address(config.token);
        v.stock = address(config.stock);
        v.symbol = OptionToken(address(config.token)).symbol();
        v.scale = config.scale;
        v.vaultShort = state.vaultShort;
        v.buysPaused = state.buysPaused || engine.globalBuysPaused();
        _fillSpot(engine, id, state, v);
        _fillEngine(engine, writerPool, id, v);
        _fillStock(config, v);
    }

    function _fillSpot(ILemniscateEngine engine, uint8 id, MarketState memory state, MarketView memory v) private view {
        (uint256 spot, uint256 spotUpdatedAt, bool oracleValid) = engine.spotPrice(id);
        uint8 regime = uint8(engine.currentRegime(id));
        if (regime == 2 || !oracleValid || spot == 0) {
            spot = state.lastGoodPrice;
            spotUpdatedAt = state.lastGoodAt;
        }
        v.regime = regime;
        v.spot = spot;
        v.spotUpdatedAt = spotUpdatedAt;
    }

    function _fillEngine(ILemniscateEngine engine, IWriterPool writerPool, uint8 id, MarketView memory v) private view {
        v.hedgeTarget = Math.mulDiv(engine.hedgeDelta(id), writerPool.hedgeRatioBps(), BPS);
        (v.bidPrice1, v.askPrice1, v.capacityUsdg) = _oneUsdQuotes(engine, id);
        v.index = engine.index(id);
        v.normFactor = engine.currentNormFactor(id);
        v.price = engine.tokenPrice(id);
        v.carryWad = engine.currentCarryWad(id);
        v.liability = engine.liability(id);
        v.hedgeUnits = writerPool.hedgeUnits(id);
    }

    function _fillStock(MarketConfig memory config, MarketView memory v) private view {
        v.multiplier = config.stock.uiMultiplier();
        v.pendingMultiplier = config.stock.newUIMultiplier();
        v.multiplierEffectiveAt = config.stock.effectiveAt();
        v.oraclePaused = config.stock.oraclePaused();
    }

    function _oneUsdQuotes(ILemniscateEngine engine, uint8 id)
        private
        view
        returns (uint256 bidPrice, uint256 askPrice, uint256 capacityUsdg)
    {
        try engine.quoteBuy(id, USDG_UNIT) returns (
            uint256, uint256, uint256 ask, uint256 maxUsdgIn
        ) {
            askPrice = ask;
            capacityUsdg = maxUsdgIn;
        } catch {
            askPrice = 0;
            capacityUsdg = 0;
        }

        uint256 fairPrice = engine.tokenPrice(id);
        if (fairPrice != 0) {
            uint256 tokensForOneUsd = Math.mulDiv(1e18, 1e18, fairPrice);
            try engine.quoteSell(id, tokensForOneUsd) returns (uint256, uint256, uint256 bid) {
                bidPrice = bid;
            } catch {
                bidPrice = 0;
            }
        }
    }
}
