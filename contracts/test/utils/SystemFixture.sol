// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {WriterPool} from "../../src/WriterPool.sol";
import {LemniscateEngine} from "../../src/LemniscateEngine.sol";
import {OptionToken} from "../../src/OptionToken.sol";
import {UniswapV3HedgeAdapter} from "../../src/UniswapV3HedgeAdapter.sol";
import {IWriterPool} from "../../src/interfaces/IWriterPool.sol";
import {IMarketHours} from "../../src/interfaces/IMarketHours.sol";
import {ILemniscateEngine} from "../../src/interfaces/ILemniscateEngine.sol";
import {ISwapRouter02} from "../../src/interfaces/ISwapRouter02.sol";
import {MarketConfig} from "../../src/libs/LemniscateTypes.sol";
import {CpmmRouter} from "../mocks/CpmmRouter.sol";
import {MockFeed} from "../mocks/MockFeed.sol";
import {MockMarketHours} from "../mocks/MockMarketHours.sol";
import {MockStockToken} from "../mocks/MockStockToken.sol";
import {MockUSDG} from "../mocks/MockUSDG.sol";

/// @dev Real LemniscateEngine + WriterPool behind ERC1967 proxies, two markets, each hedged through the real
/// UniswapV3HedgeAdapter over a constant-product router. Feeds, market hours, stock and USDG are mocks.
abstract contract SystemFixture is Test {
    uint256 internal constant USDG = 1e6;
    uint256 internal constant WAD = 1e18;
    uint256 internal constant MARKETS = 2;
    uint256 internal constant POOL_USDG_DEPTH = 500_000_000 * USDG;
    address internal constant TREASURY = address(0x5151);
    address internal constant GUARDIAN = address(0x6A2D);
    address internal constant KEEPER = address(0xCAFE);

    MockUSDG internal usdg;
    MockMarketHours internal hours_;
    WriterPool internal vault;
    LemniscateEngine internal engine;
    MockStockToken[MARKETS] internal stocks;
    MockFeed[MARKETS] internal feeds;
    OptionToken[MARKETS] internal tokens;
    CpmmRouter[MARKETS] internal routers;
    UniswapV3HedgeAdapter[MARKETS] internal adapters;

    function _deploySystem() internal {
        vm.warp(1_800_000_000);
        usdg = new MockUSDG();
        hours_ = new MockMarketHours();

        WriterPool vaultImpl = new WriterPool();
        LemniscateEngine engineImpl = new LemniscateEngine();
        address predictedEngine = vm.computeCreateAddress(address(this), vm.getNonce(address(this)) + 1);
        vault = WriterPool(
            address(
                new ERC1967Proxy(
                    address(vaultImpl),
                    abi.encodeCall(
                        WriterPool.initialize, (address(this), IERC20(address(usdg)), ILemniscateEngine(predictedEngine))
                    )
                )
            )
        );
        engine = LemniscateEngine(
            address(
                new ERC1967Proxy(
                    address(engineImpl),
                    abi.encodeCall(
                        LemniscateEngine.initialize,
                        (
                            address(this),
                            IERC20(address(usdg)),
                            IWriterPool(address(vault)),
                            IMarketHours(address(hours_)),
                            TREASURY
                        )
                    )
                )
            )
        );
        require(address(engine) == predictedEngine, "engine address");
        engine.grantRole(engine.GUARDIAN_ROLE(), GUARDIAN);
        engine.grantRole(engine.KEEPER_ROLE(), KEEPER);
        vault.grantRole(vault.KEEPER_ROLE(), KEEPER);
        engine.setGlobal(5_000, 2_000, TREASURY, address(0));

        int256[MARKETS] memory prices = [int256(100e8), int256(250e8)];
        for (uint256 i; i < MARKETS; ++i) {
            stocks[i] = new MockStockToken();
            feeds[i] = new MockFeed(8, prices[i]);
            engine.listMarket(_marketConfig(i), "POWER", "PWR", 4e15);
            tokens[i] = engine.getConfig(uint8(i)).token;

            routers[i] = new CpmmRouter(address(usdg), address(stocks[i]));
            usdg.mint(address(routers[i]), 1e12 * USDG);
            stocks[i].mint(address(routers[i]), 1e30);
            adapters[i] = new UniswapV3HedgeAdapter(ISwapRouter02(address(routers[i])));
            vault.setHedgeRoute(uint8(i), adapters[i], 500);
            _arbPool(i, 0);
        }

        vault.setParams(1 days, 1_000, 10_000, 1_000, 100, uint128(2 * USDG), uint128(1_000_000_000 * USDG));
        vault.setPublicDeposits(true);
    }

    function _marketConfig(uint256 i) internal view returns (MarketConfig memory c) {
        c.stock = stocks[i];
        c.feed = feeds[i];
        c.scale = i == 0 ? 100 : 250;
        c.feeBps = 10;
        c.openSpreadBps = 40;
        c.offHoursSpreadBps = 150;
        c.pausedSpreadBps = 300;
        c.openBandBps = 100;
        c.offHoursBandBps = 300;
        c.impactBps = 50;
        c.maxMarketExposureBps = 4_000;
        c.maxTradeUsdg = uint128(2_000_000 * USDG);
        c.minTradeUsdg = uint128(USDG);
        c.pausedSellCapPerBlockUsdg = uint128(100_000 * USDG);
        c.offHoursCarryWad = 4e15;
        c.skewCarryWad = 2e15;
        c.maxCarryWad = 5e15;
        c.baseCarryMinWad = 3e15;
        c.baseCarryMaxWad = 5e15;
        c.maxAgeOpen = 26 hours;
        c.maxAgeOffHours = 4 days;
        c.offHoursBuyMaxAge = i == 0 ? 6 hours : 0;
    }

    /// @dev Moves pool `i` to the feed price shifted by `deviationBps` (arbitrage, or a pool-only move).
    function _arbPool(uint256 i, int256 deviationBps) internal {
        (, int256 answer,,,) = feeds[i].latestRoundData();
        uint256 priceWad = uint256(answer) * 1e10 * uint256(10_000 + deviationBps) / 10_000;
        routers[i].setReserves(POOL_USDG_DEPTH, POOL_USDG_DEPTH * 1e30 / priceWad);
    }
}
