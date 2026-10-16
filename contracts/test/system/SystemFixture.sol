// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {LemniscateEngine} from "../../src/LemniscateEngine.sol";
import {WriterPool} from "../../src/WriterPool.sol";
import {Reserve} from "../../src/Reserve.sol";
import {FeeRouter} from "../../src/FeeRouter.sol";
import {PriceGuard} from "../../src/PriceGuard.sol";
import {VolOracle} from "../../src/VolOracle.sol";
import {SeriesRegistry} from "../../src/SeriesRegistry.sol";
import {UniswapV3HedgeAdapter} from "../../src/UniswapV3HedgeAdapter.sol";
import {IOptionEngine} from "../../src/interfaces/IOptionEngine.sol";
import {IPool} from "../../src/interfaces/IPool.sol";
import {IPriceGuard} from "../../src/interfaces/IPriceGuard.sol";
import {IPriceReference} from "../../src/interfaces/IPriceReference.sol";
import {ISeriesRegistry} from "../../src/interfaces/ISeriesRegistry.sol";
import {ISwapRouter02} from "../../src/interfaces/ISwapRouter02.sol";
import {IVolOracle} from "../../src/interfaces/IVolOracle.sol";
import {IReserve} from "../../src/interfaces/IReserve.sol";
import {IFeeRouter} from "../../src/interfaces/IFeeRouter.sol";
import {Speed} from "../../src/libs/OptionTypes.sol";
import {Roles} from "../../src/libs/Roles.sol";
import {MockGuardFeed, MockKindHours} from "../mocks/PriceGuardMocks.sol";
import {MockStockToken} from "../mocks/MockStockToken.sol";
import {MockPausableUSDG} from "../mocks/EngineMocks.sol";
import {MockSwapRouter} from "../mocks/MockSwapRouter.sol";

/// @notice The whole option system with REAL contracts: LemniscateEngine (ERC1967 proxy, linked libraries),
/// WriterPool (ERC1967 proxy, linked PoolHedging) with its Reserve and FeeRouter, SeriesRegistry with option-token
/// clones, PriceGuard (Chainlink-style mock feeds, session calendar mock), VolOracle (EIP-712 signed posts) and the
/// UniswapV3HedgeAdapter over a fixed-rate router. Only the feeds, the calendar, the router and the tokens are mocks.
/// No TWAP source is set (the TWAP cross-check is covered by EngineGas / PriceGuardTwap); continuity is 30% so a 25%
/// gap is priced, not latched.
abstract contract SystemFixture is Test {
    uint256 internal constant T0 = 1_790_000_000; // 2026-09-21, a Monday
    uint256 internal constant WAD = 1e18;
    uint32 internal constant DAILY = 86_400;
    uint32 internal constant WEEKLY = 604_800;
    uint24 internal constant FEE = 500;
    // Well-known anvil dev account 0 (public, never funded on a real network).
    uint256 internal constant SIGNER_PK = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80; // test-key

    address internal admin = makeAddr("admin");
    address internal keeper = makeAddr("keeper");
    address internal hedger = makeAddr("hedger");
    address internal treasury = makeAddr("treasury");
    address internal lp = makeAddr("lp");
    address internal alice = makeAddr("alice");

    MockPausableUSDG internal usdg;
    MockKindHours internal hours_;
    PriceGuard internal guard;
    VolOracle internal vol;
    SeriesRegistry internal registry;
    LemniscateEngine internal engine;
    WriterPool internal pool;
    Reserve internal reserve;
    FeeRouter internal fees;
    MockSwapRouter internal router;
    UniswapV3HedgeAdapter internal adapter;
    MockStockToken[] internal stocks;
    MockGuardFeed[] internal feeds;
    uint256[] internal px; // WAD
    uint64 internal nonce;
    uint256 internal lastVolPost;

    function _deploySystem(uint256 names, uint256 lpUsdg) internal {
        vm.warp(T0);
        usdg = new MockPausableUSDG();
        hours_ = new MockKindHours(); // REGULAR
        guard = new PriceGuard(admin, address(hours_), 24 hours, 1 hours);
        vol = new VolOracle(admin, vm.addr(SIGNER_PK), 2 hours, 5 minutes);
        registry = new SeriesRegistry(admin, IPriceGuard(address(guard)));
        router = new MockSwapRouter();
        adapter = new UniswapV3HedgeAdapter(ISwapRouter02(address(router)));

        // Pool first (engine set once later), then the engine with the pool's address.
        WriterPool poolImpl = new WriterPool(72 hours);
        pool = WriterPool(
            address(
                new ERC1967Proxy(
                    address(poolImpl),
                    abi.encodeCall(
                        WriterPool.initialize,
                        (admin, IERC20(address(usdg)), IOptionEngine(address(0)), IPriceGuard(address(guard)))
                    )
                )
            )
        );
        LemniscateEngine engineImpl = new LemniscateEngine();
        engine = LemniscateEngine(
            address(
                new ERC1967Proxy(
                    address(engineImpl),
                    abi.encodeCall(
                        LemniscateEngine.initialize,
                        (
                            admin,
                            IERC20(address(usdg)),
                            IPool(address(pool)),
                            ISeriesRegistry(address(registry)),
                            IPriceGuard(address(guard)),
                            IVolOracle(address(vol))
                        )
                    )
                )
            )
        );
        reserve = new Reserve(admin, IERC20(address(usdg)), address(pool));
        fees = new FeeRouter(admin, IERC20(address(usdg)), address(pool), treasury, 7 days);

        vm.startPrank(admin);
        pool.setModules(
            IOptionEngine(address(engine)), IReserve(address(reserve)), IFeeRouter(address(fees)), IPriceReference(address(0))
        );
        pool.setPublicDeposits(true);
        pool.setParams(1 days, 1_000, 100, type(uint128).max);
        pool.grantRole(pool.HEDGER_ROLE(), hedger);
        registry.setEngine(address(engine));
        registry.grantRole(Roles.KEEPER_ROLE, keeper);
        for (uint256 i; i < names; ++i) {
            MockStockToken stock = new MockStockToken();
            MockGuardFeed feed = new MockGuardFeed(8, int256(100e8 * (i + 1)));
            stocks.push(stock);
            feeds.push(feed);
            px.push(100e18 * (i + 1));
            guard.setStock(
                address(stock),
                IPriceGuard.StockConfig({
                    feed: address(feed),
                    multiplierEmbedded: true,
                    maxAgeRegular: 26 hours,
                    maxAgeExtended: 26 hours,
                    continuityBps: 3000,
                    enabled: true
                })
            );
            registry.setStock(address(stock), true, 0, "STK");
            pool.setHedgeRoute(address(stock), adapter, FEE);
        }
        vm.stopPrank();

        for (uint256 i; i < names; ++i) {
            guard.poke(address(stocks[i]));
            _setRouterPrice(i);
            stocks[i].mint(address(router), 1_000_000_000e18);
        }
        usdg.mint(address(router), 1_000_000_000_000e6);
        _postVols();

        _deposit(lp, lpUsdg);
        usdg.mint(alice, 1_000_000_000e6);
        vm.prank(alice);
        usdg.approve(address(engine), type(uint256).max);
    }

    // ------------------------------------------------------------------------------------------------ helpers

    function _deposit(address who, uint256 amount) internal returns (uint256 shares) {
        usdg.mint(who, amount);
        vm.startPrank(who);
        usdg.approve(address(pool), amount);
        shares = pool.deposit(amount, who);
        vm.stopPrank();
    }

    function _setRouterPrice(uint256 i) internal {
        router.setRate(address(usdg), address(stocks[i]), FEE, 1e48 / px[i]);
        router.setRate(address(stocks[i]), address(usdg), FEE, px[i] / 1e12);
    }

    /// @dev New feed round at `s` (WAD), poked into PriceGuard, router moved to the same price.
    function _setPrice(uint256 i, uint256 s) internal {
        px[i] = s;
        feeds[i].push(int256(s / 1e10));
        guard.poke(address(stocks[i]));
        _setRouterPrice(i);
    }

    function _postVols() internal {
        for (uint256 i; i < stocks.length; ++i) {
            _post(address(stocks[i]), Speed.DAILY);
            _post(address(stocks[i]), Speed.WEEKLY);
        }
        lastVolPost = vm.getBlockTimestamp();
    }

    /// @dev Re-posts the same sigma when the 5-minute rate limit allows (keeps posts valid across warps).
    function _refreshVols() internal {
        if (vm.getBlockTimestamp() >= lastVolPost + 5 minutes) _postVols();
    }

    function _post(address stock, Speed speed) internal {
        IVolOracle.Post memory p = IVolOracle.Post({
            stock: stock,
            speed: speed,
            sigmaBps: 5000,
            skewK: 0,
            eventBumpBps: 0,
            buyBlockFrom: 0,
            buyBlockTo: 0,
            validUntil: uint64(vm.getBlockTimestamp() + 2 hours),
            nonce: ++nonce
        });
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(SIGNER_PK, vol.hashPost(p));
        vol.post(p, abi.encodePacked(r, s, v));
    }

    function _list(uint256 i, bool isCall, uint128 strike, uint32 tau) internal returns (bytes32 id) {
        vm.startPrank(keeper);
        id = registry.listSeries(address(stocks[i]), isCall, strike, tau);
        registry.setBuyable(id, true);
        vm.stopPrank();
    }

    function _buy(address who, bytes32 id, uint256 units) internal returns (uint256 cost, uint256 tokens) {
        vm.prank(who);
        return engine.buy(id, uint128(units), type(uint128).max, uint64(vm.getBlockTimestamp()), who);
    }

    function _sell(address who, bytes32 id, uint256 tokens) internal returns (uint256 proceeds) {
        vm.prank(who);
        return engine.sell(id, uint128(tokens), 0, uint64(vm.getBlockTimestamp()), who);
    }

    /// @dev Every live series of every name, as the keeper would accrue them.
    function _liveIds() internal view returns (bytes32[] memory all) {
        uint256 n;
        for (uint256 i; i < stocks.length; ++i) {
            n += engine.liveSeries(address(stocks[i])).length;
        }
        all = new bytes32[](n);
        n = 0;
        for (uint256 i; i < stocks.length; ++i) {
            bytes32[] memory l = engine.liveSeries(address(stocks[i]));
            for (uint256 j; j < l.length; ++j) {
                all[n++] = l[j];
            }
        }
    }

    function _accrueAll() internal {
        engine.accrueMany(_liveIds());
    }

    function _token(bytes32 id) internal view returns (IERC20) {
        return IERC20(registry.seriesOf(id).token);
    }
}
