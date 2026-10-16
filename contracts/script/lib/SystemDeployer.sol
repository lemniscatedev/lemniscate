// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {LemniscateEngine} from "../../src/LemniscateEngine.sol";
import {EngineHelper} from "../../src/EngineHelper.sol";
import {WriterPool} from "../../src/WriterPool.sol";
import {Reserve} from "../../src/Reserve.sol";
import {FeeRouter} from "../../src/FeeRouter.sol";
import {PriceGuard} from "../../src/PriceGuard.sol";
import {VolOracle} from "../../src/VolOracle.sol";
import {SeriesRegistry} from "../../src/SeriesRegistry.sol";
import {MarketHours} from "../../src/MarketHours.sol";
import {AgentRouter} from "../../src/AgentRouter.sol";
import {UniswapV3HedgeAdapter} from "../../src/UniswapV3HedgeAdapter.sol";
import {UniswapV3TwapReference, IUniswapV3FactoryLike} from "../../src/UniswapV3TwapReference.sol";
import {IOptionEngine} from "../../src/interfaces/IOptionEngine.sol";
import {IPool} from "../../src/interfaces/IPool.sol";
import {IPriceGuard} from "../../src/interfaces/IPriceGuard.sol";
import {IPriceReference} from "../../src/interfaces/IPriceReference.sol";
import {ISeriesRegistry} from "../../src/interfaces/ISeriesRegistry.sol";
import {ISwapRouter02} from "../../src/interfaces/ISwapRouter02.sol";
import {IVolOracle} from "../../src/interfaces/IVolOracle.sol";
import {IReserve} from "../../src/interfaces/IReserve.sol";
import {IFeeRouter} from "../../src/interfaces/IFeeRouter.sol";
import {IHedgeAdapter} from "../../src/interfaces/IHedgeAdapter.sol";
import {Roles as RoleIds} from "../../src/libs/Roles.sol";
import {SystemConfig} from "./SystemConfig.sol";
import {TestnetUSDG, TestnetStockToken, TestnetFeed, TestnetSwapRouter} from "../testnet/TestnetMocks.sol";
import {ForkSafe} from "../fork/ForkSafe.sol";

/// @title SystemDeployer
/// @notice Deploys and wires the whole option system from a SystemConfig, then (with `handoff`) moves every admin role
/// to the timelock (fork, mainnet) or the owner (testnet) and renounces the deployer. Shared by DeploySystem.s.sol and
/// the system tests, which call `_deploySystem` under `vm.startBroadcast(deployer)` exactly like the script.
/// @dev Order: MarketHours (proxy) -> PriceGuard -> VolOracle -> SeriesRegistry (+ its OptionTokenFactory) -> WriterPool
/// (proxy; the implementation links the external library PoolHedging, which forge deploys and links) -> engine (proxy;
/// links EngineTradeLib / EngineOpsLib) -> Reserve, FeeRouter -> pool.setModules after the engine exists ->
/// registry.setEngine -> stocks -> params -> roles -> AgentRouter -> handoff.
abstract contract SystemDeployer is SystemConfig {
    bytes32 internal constant ADMIN = bytes32(0);
    bytes32 internal constant KEEPER = RoleIds.KEEPER_ROLE;
    bytes32 internal constant GUARDIAN = RoleIds.GUARDIAN_ROLE;
    bytes32 internal constant HEDGER = keccak256("HEDGER_ROLE");

    struct Deployed {
        uint256 chainId;
        string network;
        uint256 deployBlock;
        address deployer;
        address admin; // timelock (fork, mainnet) or owner (testnet); the deployer until handoff
        address timelock;
        address safe;
        address engine;
        address engineImpl;
        address pool;
        address poolImpl;
        address registry;
        address priceGuard;
        address volOracle;
        address usdg;
        address marketHours;
        address marketHoursImpl;
        address agentRouter;
        address reserve;
        address feeRouter;
        address hedgeAdapter;
        address priceReference;
        address swapRouter;
        string[] names;
        address[] stocks;
        address[] feeds;
    }

    function _deploySystem(Config memory c, address deployer) internal returns (Deployed memory d) {
        validateConfig(c);
        d.chainId = block.chainid;
        d.network = c.profileName;
        d.deployBlock = _rpcBlockNumber();
        d.deployer = deployer;
        d.admin = deployer;

        if (c.profile == PROFILE_TESTNET) _deployTestnetMocks(c, d);
        else _useRealAddresses(c, d);

        _deployCore(c, d);
        _wire(c, d);
        _listStocks(c, d);
        _params(c, d);
        _grantRoles(c, d);
        d.agentRouter = address(new AgentRouter(d.engine));
        if (c.handoff) _handoff(c, d);
    }

    /// @dev The RPC's own block number (what the indexer's eth_getLogs counts). On Arbitrum-style chains, and on an
    /// anvil fork of one, `block.number` is the L1 block number, so it cannot be the indexer's start block. Falls back
    /// to block.number when there is no RPC (forge test).
    function _rpcBlockNumber() internal returns (uint256 n) {
        try vm.rpc("eth_blockNumber", "[]") returns (bytes memory raw) {
            for (uint256 i; i < raw.length; ++i) {
                n = (n << 8) | uint8(raw[i]);
            }
        } catch {
            n = block.number;
        }
    }

    // ------------------------------------------------------------------------------------------------ external

    function _useRealAddresses(Config memory c, Deployed memory d) private {
        d.usdg = c.usdg;
        d.swapRouter = c.swapRouter;
        uint256 n = c.stocks.length;
        d.names = new string[](n);
        d.stocks = new address[](n);
        d.feeds = new address[](n);
        for (uint256 i; i < n; ++i) {
            d.names[i] = c.stocks[i].name;
            d.stocks[i] = c.stocks[i].stock;
            d.feeds[i] = c.stocks[i].feed;
        }
        if (c.uniswapFactory != address(0)) {
            d.priceReference = address(
                new UniswapV3TwapReference(IUniswapV3FactoryLike(c.uniswapFactory), c.usdg, c.referenceWindow)
            );
        }
    }

    /// @dev Testnet: mock USDG, one mock Stock Token and keeper-pushed feed per name, and a feed-priced swap venue with
    /// inventory so the pool can hedge. The deployer owns the mocks (it mints); the keeper is the feeds' updater.
    function _deployTestnetMocks(Config memory c, Deployed memory d) private {
        TestnetUSDG usdg = new TestnetUSDG(d.deployer);
        d.usdg = address(usdg);
        TestnetSwapRouter router = new TestnetSwapRouter(d.deployer, address(usdg));
        d.swapRouter = address(router);
        uint256 n = c.stocks.length;
        d.names = new string[](n);
        d.stocks = new address[](n);
        d.feeds = new address[](n);
        for (uint256 i; i < n; ++i) {
            StockCfg memory s = c.stocks[i];
            require(s.mockPriceUsdE8 != 0, "SystemDeployer: testnet stock needs mockPriceUsdE8");
            TestnetStockToken token = new TestnetStockToken(string.concat("Test ", s.name), s.name, d.deployer);
            TestnetFeed feed =
                new TestnetFeed(string.concat(s.name, " / USD (testnet mirror)"), d.deployer, c.roles.keeper, int256(s.mockPriceUsdE8));
            router.setFeed(address(token), address(feed));
            token.mint(address(router), 1_000_000e18);
            d.names[i] = s.name;
            d.stocks[i] = address(token);
            d.feeds[i] = address(feed);
            c.stocks[i].stock = address(token);
            c.stocks[i].feed = address(feed);
        }
        usdg.mint(address(router), 1_000_000_000e6);
    }

    // ---------------------------------------------------------------------------------------------------- core

    function _deployCore(Config memory c, Deployed memory d) private {
        address deployer = d.deployer;
        d.marketHoursImpl = address(new MarketHours());
        d.marketHours = address(
            new ERC1967Proxy(d.marketHoursImpl, abi.encodeCall(MarketHours.initialize, (deployer, c.roles.keeper)))
        );
        d.priceGuard = address(new PriceGuard(deployer, d.marketHours, c.timers.splitLead, c.timers.splitTail));
        d.volOracle = address(
            new VolOracle(deployer, c.roles.volSigner, c.timers.volMaxValidity, c.timers.volMinPostInterval)
        );
        d.registry = address(new SeriesRegistry(deployer, IPriceGuard(d.priceGuard)));

        // Pool first (the engine is initialised with the pool's address), engine set once later via setModules.
        d.poolImpl = address(new WriterPool(c.timers.poolQueueDelay));
        d.pool = address(
            new ERC1967Proxy(
                d.poolImpl,
                abi.encodeCall(
                    WriterPool.initialize,
                    (deployer, IERC20(d.usdg), IOptionEngine(address(0)), IPriceGuard(d.priceGuard))
                )
            )
        );
        d.engineImpl = address(new LemniscateEngine());
        d.engine = address(
            new ERC1967Proxy(
                d.engineImpl,
                abi.encodeCall(
                    LemniscateEngine.initialize,
                    (
                        deployer,
                        IERC20(d.usdg),
                        IPool(d.pool),
                        ISeriesRegistry(d.registry),
                        IPriceGuard(d.priceGuard),
                        IVolOracle(d.volOracle)
                    )
                )
            )
        );
        d.reserve = address(new Reserve(deployer, IERC20(d.usdg), d.pool));
        d.feeRouter = address(new FeeRouter(deployer, IERC20(d.usdg), d.pool, c.roles.treasury, c.timers.feePeriod));
        d.hedgeAdapter = address(new UniswapV3HedgeAdapter(ISwapRouter02(d.swapRouter)));
    }

    function _wire(Config memory c, Deployed memory d) private {
        WriterPool(d.pool).setModules(
            IOptionEngine(d.engine), IReserve(d.reserve), IFeeRouter(d.feeRouter), IPriceReference(d.priceReference)
        );
        SeriesRegistry(d.registry).setEngine(d.engine);
        FeeRouter fees = FeeRouter(d.feeRouter);
        if (c.roles.keepersPot != address(0)) fees.setRecipient("keepers", c.roles.keepersPot);
        if (c.roles.hedgerPot != address(0)) fees.setRecipient("hedger", c.roles.hedgerPot);
    }

    function _listStocks(Config memory c, Deployed memory d) private {
        PriceGuard guard = PriceGuard(d.priceGuard);
        SeriesRegistry registry = SeriesRegistry(d.registry);
        WriterPool pool = WriterPool(d.pool);
        LemniscateEngine engine = LemniscateEngine(d.engine);
        VolOracle vol = VolOracle(d.volOracle);
        for (uint256 i; i < c.stocks.length; ++i) {
            StockCfg memory s = c.stocks[i];
            address stock = d.stocks[i];
            guard.setStock(
                stock,
                IPriceGuard.StockConfig({
                    feed: d.feeds[i],
                    multiplierEmbedded: true, // decision: every Robinhood feed embeds the multiplier (todo 00)
                    maxAgeRegular: s.maxAgeRegular,
                    maxAgeExtended: s.maxAgeExtended,
                    continuityBps: s.continuityBps,
                    enabled: true
                })
            );
            if (s.uniPool != address(0)) guard.setTwapSource(stock, s.uniPool, s.twapWindow, s.twapBandBps);
            guard.poke(stock);
            registry.setStock(stock, true, uint128(s.strikeStepUsd * 1e18), s.name);
            pool.setHedgeRoute(stock, IHedgeAdapter(d.hedgeAdapter), s.poolFee);
            if (s.hedgeDepthCapUsd != 0) engine.setHedgeDepthCap(stock, s.hedgeDepthCapUsd * 1e18);
            if (s.volFloorBps != 0) vol.setFloor(stock, s.volFloorBps);
        }
    }

    function _params(Config memory c, Deployed memory d) private {
        LemniscateEngine engine = LemniscateEngine(d.engine);
        EngineHelper.Params memory p = engine.params();
        p.seriesCapWad = c.limits.seriesCapWad == 0 ? UNLIMITED_ENGINE_CAP : c.limits.seriesCapWad;
        p.accountCapWad = c.limits.accountCapWad == 0 ? UNLIMITED_ENGINE_CAP : c.limits.accountCapWad;
        engine.setParams(p);

        WriterPool pool = WriterPool(d.pool);
        uint128 maxDeposits = c.limits.maxTotalDepositsUsdg == 0 ? type(uint128).max : c.limits.maxTotalDepositsUsdg;
        pool.setParams(c.timers.depositLock, 1_000, 100, maxDeposits);
        pool.setPublicDeposits(c.limits.publicDeposits);
        for (uint256 i; i < c.roles.depositors.length; ++i) {
            pool.setDepositor(c.roles.depositors[i], true);
        }
    }

    function _grantRoles(Config memory c, Deployed memory d) private {
        IAccessControl(d.engine).grantRole(GUARDIAN, c.roles.guardian);
        IAccessControl(d.pool).grantRole(GUARDIAN, c.roles.guardian);
        IAccessControl(d.priceGuard).grantRole(GUARDIAN, c.roles.guardian);
        IAccessControl(d.pool).grantRole(HEDGER, c.roles.hedger);
        IAccessControl(d.registry).grantRole(KEEPER, c.roles.keeper);
        // MarketHours.initialize already granted KEEPER_ROLE to the keeper.
    }

    // ------------------------------------------------------------------------------------------------- handoff

    /// @notice Every contract whose DEFAULT_ADMIN_ROLE the handoff moves.
    function adminTargets(Deployed memory d) internal pure returns (address[] memory t) {
        t = new address[](8);
        t[0] = d.engine;
        t[1] = d.pool;
        t[2] = d.registry;
        t[3] = d.priceGuard;
        t[4] = d.volOracle;
        t[5] = d.marketHours;
        t[6] = d.reserve;
        t[7] = d.feeRouter;
    }

    function _handoff(Config memory c, Deployed memory d) private {
        address admin;
        if (c.profile == PROFILE_TESTNET) {
            admin = c.roles.owner; // testnet: no Safe, no timelock (Kal's testnet owner wallet)
        } else {
            address safe = c.roles.safe;
            if (safe == address(0)) {
                require(c.profile == PROFILE_FORK, "SystemDeployer: mainnet needs roles.safe");
                require(c.roles.owner != address(0), "SystemDeployer: fork needs roles.safe or roles.owner");
                safe = address(new ForkSafe(c.roles.owner));
            }
            require(c.timers.timelockDelay >= FULL_TIMELOCK_DELAY, "SystemDeployer: timelock below 48h");
            address[] memory members = new address[](1);
            members[0] = safe;
            // admin = address(0): the timelock administers itself; OZ v5 makes every proposer a canceller.
            admin = address(new TimelockController(c.timers.timelockDelay, members, members, address(0)));
            d.timelock = admin;
            d.safe = safe;
        }
        require(admin != address(0) && admin != d.deployer, "SystemDeployer: bad admin");
        address[] memory t = adminTargets(d);
        for (uint256 i; i < t.length; ++i) {
            IAccessControl(t[i]).grantRole(ADMIN, admin);
        }
        for (uint256 i; i < t.length; ++i) {
            IAccessControl(t[i]).renounceRole(ADMIN, d.deployer);
        }
        d.admin = admin;
    }

    // ---------------------------------------------------------------------------------------------- output

    /// @notice The deployment file in the app's OptionDeployment shape (app/src/chain/deployment.ts) plus the extra
    /// contract and role addresses the post-deploy check and the runbooks use (the app ignores unknown keys).
    function deploymentJson(Deployed memory d) internal view returns (string memory) {
        string memory stocks = "[";
        for (uint256 i; i < d.stocks.length; ++i) {
            stocks = string.concat(
                stocks,
                i == 0 ? "" : ",",
                '{"name":"',
                d.names[i],
                '","stock":"',
                vm.toString(d.stocks[i]),
                '","feed":"',
                vm.toString(d.feeds[i]),
                '","deployBlock":',
                vm.toString(d.deployBlock),
                "}"
            );
        }
        stocks = string.concat(stocks, "]");
        string memory contracts = string.concat(
            '{"engine":"',
            vm.toString(d.engine),
            '","pool":"',
            vm.toString(d.pool),
            '","registry":"',
            vm.toString(d.registry),
            '","priceGuard":"',
            vm.toString(d.priceGuard),
            '","volOracle":"',
            vm.toString(d.volOracle),
            '","usdg":"',
            vm.toString(d.usdg),
            '","marketHours":"',
            vm.toString(d.marketHours),
            '","agentRouter":"',
            vm.toString(d.agentRouter),
            '","reserve":"',
            vm.toString(d.reserve)
        );
        contracts = string.concat(
            contracts,
            '","feeRouter":"',
            vm.toString(d.feeRouter),
            '","hedgeAdapter":"',
            vm.toString(d.hedgeAdapter),
            '","priceReference":"',
            vm.toString(d.priceReference),
            '","swapRouter":"',
            vm.toString(d.swapRouter),
            '","engineImpl":"',
            vm.toString(d.engineImpl),
            '","poolImpl":"',
            vm.toString(d.poolImpl),
            '","marketHoursImpl":"',
            vm.toString(d.marketHoursImpl),
            '","timelock":"',
            vm.toString(d.timelock),
            '"}'
        );
        return string.concat(
            '{"chainId":',
            vm.toString(d.chainId),
            ',"network":"',
            d.network,
            '","deployBlock":',
            vm.toString(d.deployBlock),
            ',"deployer":"',
            vm.toString(d.deployer),
            '","admin":"',
            vm.toString(d.admin),
            '","safe":"',
            vm.toString(d.safe),
            '","poolShareDecimals":',
            vm.toString(uint256(WriterPool(d.pool).decimals())),
            ',"contracts":',
            contracts,
            ',"stocks":',
            stocks,
            "}"
        );
    }
}
