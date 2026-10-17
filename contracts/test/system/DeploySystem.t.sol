// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {SystemChecks} from "../../script/lib/SystemChecks.sol";
import {TestnetUSDG, TestnetFeed, TestnetStockToken} from "../../script/testnet/TestnetMocks.sol";
import {LemniscateEngine} from "../../src/LemniscateEngine.sol";
import {EngineHelper} from "../../src/EngineHelper.sol";
import {WriterPool} from "../../src/WriterPool.sol";
import {FeeRouter} from "../../src/FeeRouter.sol";
import {PriceGuard} from "../../src/PriceGuard.sol";
import {VolOracle} from "../../src/VolOracle.sol";
import {SeriesRegistry} from "../../src/SeriesRegistry.sol";
import {MarketHours} from "../../src/MarketHours.sol";
import {IPriceGuard} from "../../src/interfaces/IPriceGuard.sol";
import {IVolOracle} from "../../src/interfaces/IVolOracle.sol";
import {Session} from "../../src/libs/LemniscateTypes.sol";
import {SessionKind, Speed} from "../../src/libs/OptionTypes.sol";
import {MockGuardFeed} from "../mocks/PriceGuardMocks.sol";
import {MockStockToken} from "../mocks/MockStockToken.sol";
import {MockPausableUSDG} from "../mocks/EngineMocks.sol";
import {MockSwapRouter} from "../mocks/MockSwapRouter.sol";
import {MockObservingPool} from "../mocks/TwapMocks.sol";
import {VaultRegistry} from "../../src/vaults/VaultRegistry.sol";
import {WriterVault} from "../../src/vaults/WriterVault.sol";

contract MockV3Factory {
    mapping(bytes32 => address) internal _pools;

    function set(address a, address b, uint24 fee, address pool) external {
        _pools[keccak256(abi.encode(a, b, fee))] = pool;
        _pools[keccak256(abi.encode(b, a, fee))] = pool;
    }

    function getPool(address a, address b, uint24 fee) external view returns (address) {
        return _pools[keccak256(abi.encode(a, b, fee))];
    }
}

/// @notice Safe getters only (threshold / owners), for the mainnet profile's 3-of-5 rule.
contract MockSafe {
    uint256 public immutable threshold;
    uint256 public immutable ownerCount;

    constructor(uint256 t, uint256 n) {
        threshold = t;
        ownerCount = n;
    }

    function getThreshold() external view returns (uint256) {
        return threshold;
    }

    function getOwners() external view returns (address[] memory o) {
        o = new address[](ownerCount);
        for (uint256 i; i < ownerCount; ++i) {
            o[i] = address(uint160(0x1000 + i));
        }
    }
}

/// @notice Todo 10 R1, R2, R3, R9: the deploy script's own code path (SystemDeployer._deploySystem under
/// vm.startBroadcast(deployer), exactly what DeploySystem.s.sol runs) on the fork profile over mocks that stand in for
/// the mainnet tokens, feeds and pools, on the testnet profile with its own mocks, and on the mainnet profile; then the
/// post-deploy check on the fresh system and on twelve-plus deliberate misconfigurations, each with its named reason.
contract DeploySystemTest is Test, SystemChecks {
    uint256 internal constant T0 = 1_790_000_000; // 2026-09-21, a Monday
    int24 internal constant TICK_100 = -230_270; // stock (18 dp) / USDG (6 dp) at 100
    // Well-known anvil dev account 1 (public, never funded on a real network).
    uint256 internal constant VOL_PK = 0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d; // test-key

    address internal deployer = makeAddr("deployer");
    address internal owner = makeAddr("owner");
    address internal guardian = makeAddr("guardian");
    address internal keeper = makeAddr("keeper");
    address internal hedger = makeAddr("hedger");
    address internal volSigner = vm.addr(VOL_PK);
    address internal treasury = makeAddr("treasury");
    address internal keepersPot = makeAddr("keepersPot");
    address internal hedgerPot = makeAddr("hedgerPot");
    address internal lp = makeAddr("lp");
    address internal alice = makeAddr("alice");

    string[5] internal NAMES = ["NVDA", "TSLA", "SPY", "QQQ", "AAPL"];
    uint64 internal nonce;

    function setUp() public {
        vm.warp(T0);
    }

    // ------------------------------------------------------------------------------------------------- harness

    /// @dev The script path: everything `_deploySystem` sends is broadcast from `deployer`.
    function doDeploy(Config memory c) external returns (Deployed memory d) {
        try vm.stopBroadcast() {} catch {} // a reverted deploy leaves the broadcast cheatcode active
        vm.startBroadcast(deployer);
        d = _deploySystem(c, deployer);
        vm.stopBroadcast();
    }

    function doParse(string memory json) external view returns (Config memory) {
        return parseConfig(json);
    }

    function _deploy(Config memory c) internal returns (Deployed memory d) {
        d = this.doDeploy(c);
        if (c.profile == PROFILE_TESTNET) _fill(c, d);
    }

    function _fill(Config memory c, Deployed memory d) internal pure {
        for (uint256 i; i < d.stocks.length; ++i) {
            c.stocks[i].stock = d.stocks[i];
            c.stocks[i].feed = d.feeds[i];
        }
    }

    function _roles() internal view returns (Roles memory r) {
        r.owner = owner;
        r.guardian = guardian;
        r.keeper = keeper;
        r.hedger = hedger;
        r.volSigner = volSigner;
        r.treasury = treasury;
        r.keepersPot = keepersPot;
        r.hedgerPot = hedgerPot;
        r.depositors = new address[](1);
        r.depositors[0] = lp;
    }

    function _stockCfg(string memory name) internal pure returns (StockCfg memory s) {
        s.name = name;
        s.poolFee = 500;
        s.twapBandBps = keccak256(bytes(name)) == keccak256("TSLA") ? 125 : 75;
        s.twapWindow = 1800;
        s.maxAgeRegular = 26 hours;
        s.maxAgeExtended = 26 hours;
        s.continuityBps = 1500;
        s.strikeStepUsd = 5;
        s.hedgeDepthCapUsd = 300_000;
        s.mockPriceUsdE8 = 100e8;
    }

    /// @dev Fork profile over mocks of the mainnet externals: USDG, five Stock Tokens with feeds at 100, an observing
    /// Uniswap pool per name at the same price, a swap router and a factory for the hedge-floor TWAP reference.
    function _forkConfig() internal returns (Config memory c) {
        c.profileName = "fork";
        c.profile = PROFILE_FORK;
        MockPausableUSDG usdg = new MockPausableUSDG();
        MockSwapRouter router = new MockSwapRouter();
        MockV3Factory factory = new MockV3Factory();
        c.usdg = address(usdg);
        c.swapRouter = address(router);
        c.uniswapFactory = address(factory);
        c.referenceWindow = 1800;
        c.handoff = true;
        c.roles = _roles();
        c.timers = fullTimers();
        c.stocks = new StockCfg[](NAMES.length);
        for (uint256 i; i < NAMES.length; ++i) {
            MockStockToken stock = new MockStockToken();
            MockGuardFeed feed = new MockGuardFeed(8, 100e8);
            MockObservingPool pool = new MockObservingPool(address(stock), address(usdg), TICK_100, 7200, 2 hours);
            factory.set(address(stock), address(usdg), 500, address(pool));
            router.setRate(address(usdg), address(stock), 500, 1e48 / 100e18);
            router.setRate(address(stock), address(usdg), 500, 100e18 / 1e12);
            stock.mint(address(router), 1_000_000e18);
            c.stocks[i] = _stockCfg(NAMES[i]);
            c.stocks[i].stock = address(stock);
            c.stocks[i].feed = address(feed);
            c.stocks[i].uniPool = address(pool);
        }
        usdg.mint(address(router), 1_000_000_000e6);
    }

    function _testnetConfig() internal view returns (Config memory c) {
        c.profileName = "testnet";
        c.profile = PROFILE_TESTNET;
        c.handoff = true;
        c.roles = _roles();
        c.timers = Timers({
            poolQueueDelay: 10 minutes,
            depositLock: 2 minutes,
            feePeriod: 15 minutes,
            timelockDelay: 0,
            volMaxValidity: 30 minutes,
            volMinPostInterval: 30 seconds,
            splitLead: 15 minutes,
            splitTail: 5 minutes
        });
        c.stocks = new StockCfg[](NAMES.length);
        for (uint256 i; i < NAMES.length; ++i) {
            c.stocks[i] = _stockCfg(NAMES[i]);
            c.stocks[i].hedgeDepthCapUsd = 0;
        }
    }

    function _has(string[] memory fails, string memory reason) internal pure returns (bool) {
        for (uint256 i; i < fails.length; ++i) {
            if (keccak256(bytes(fails[i])) == keccak256(bytes(reason))) return true;
        }
        return false;
    }

    function _expectFail(Config memory c, Deployed memory d, string memory reason) internal {
        string[] memory fails = systemFailures(c, d);
        for (uint256 i; i < fails.length; ++i) {
            emit log_named_string("failure", fails[i]);
        }
        assertTrue(_has(fails, reason), reason);
    }

    function _assertClean(Config memory c, Deployed memory d) internal {
        string[] memory fails = systemFailures(c, d);
        for (uint256 i; i < fails.length; ++i) {
            emit log_named_string("unexpected failure", fails[i]);
        }
        assertEq(fails.length, 0, "post-deploy check passes");
    }

    // ------------------------------------------------------------------------------------------ live smoke

    function _openSession(Deployed memory d) internal {
        Session[] memory s = new Session[](1);
        s[0] = Session({open: uint64(block.timestamp - 1 hours), close: uint64(block.timestamp + 6 hours)});
        SessionKind[] memory k = new SessionKind[](1);
        k[0] = SessionKind.REGULAR;
        vm.prank(keeper);
        MarketHours(d.marketHours).setSessionsWithKinds(s, k);
        for (uint256 i; i < d.stocks.length; ++i) {
            PriceGuard(d.priceGuard).poke(d.stocks[i]);
        }
    }

    function _postVols(Deployed memory d) internal {
        for (uint256 i; i < d.stocks.length; ++i) {
            for (uint8 sp; sp < 2; ++sp) {
                IVolOracle.Post memory p = IVolOracle.Post({
                    stock: d.stocks[i],
                    speed: Speed(sp),
                    sigmaBps: 5000,
                    skewK: 0,
                    eventBumpBps: 0,
                    buyBlockFrom: 0,
                    buyBlockTo: 0,
                    validUntil: uint64(block.timestamp + 20 minutes),
                    nonce: ++nonce
                });
                (uint8 v, bytes32 r, bytes32 s) = vm.sign(VOL_PK, VolOracle(d.volOracle).hashPost(p));
                VolOracle(d.volOracle).post(p, abi.encodePacked(r, s, v));
            }
        }
    }

    function _mintUsdg(Config memory c, Deployed memory d, address to, uint256 amount) internal {
        if (c.profile == PROFILE_TESTNET) {
            vm.prank(deployer);
            TestnetUSDG(d.usdg).mint(to, amount);
        } else {
            MockPausableUSDG(d.usdg).mint(to, amount);
        }
    }

    /// @dev Session pushed, vols posted, an allowlisted LP deposits, the keeper lists, alice buys and sells.
    function _smoke(Config memory c, Deployed memory d) internal returns (bytes32 id, uint256 tokens) {
        _openSession(d);
        _postVols(d);
        _mintUsdg(c, d, lp, 1_000_000e6);
        vm.startPrank(lp);
        IERC20(d.usdg).approve(d.pool, type(uint256).max);
        WriterPool(d.pool).deposit(1_000_000e6, lp);
        vm.stopPrank();

        vm.startPrank(keeper);
        id = SeriesRegistry(d.registry).listSeries(d.stocks[0], true, 100e18, 86_400);
        SeriesRegistry(d.registry).setBuyable(id, true);
        vm.stopPrank();

        _mintUsdg(c, d, alice, 10_000e6);
        vm.startPrank(alice);
        IERC20(d.usdg).approve(d.engine, type(uint256).max);
        uint256 cost;
        (cost, tokens) = LemniscateEngine(d.engine).buy(id, 5e18, type(uint128).max, uint64(block.timestamp), alice);
        vm.stopPrank();
        assertGt(cost, 0, "buy costs USDG");
        assertGt(tokens, 0, "buy mints option tokens");
    }

    function _sellAll(Deployed memory d, bytes32 id) internal returns (uint256 proceeds) {
        address token = SeriesRegistry(d.registry).seriesOf(id).token;
        uint256 bal = IERC20(token).balanceOf(alice);
        vm.prank(alice);
        proceeds = LemniscateEngine(d.engine).sell(id, uint128(bal), 0, uint64(block.timestamp), alice);
    }

    // ------------------------------------------------------------------------------------------------- R1

    function test_R1_deployOnAnvilWorks_forkProfile() public {
        Config memory c = _forkConfig();
        Deployed memory d = _deploy(c);
        address[16] memory all = [
            d.engine, d.engineImpl, d.pool, d.poolImpl, d.registry, d.priceGuard, d.volOracle, d.marketHours,
            d.marketHoursImpl, d.reserve, d.feeRouter, d.agentRouter, d.hedgeAdapter, d.priceReference, d.timelock, d.safe
        ];
        for (uint256 i; i < all.length; ++i) {
            assertGt(all[i].code.length, 0, "every contract has code");
        }
        assertEq(address(SeriesRegistry(d.registry).factory()).code.length > 0, true, "option token factory");
        _assertClean(c, d);

        // Deployment file: the app's OptionDeployment shape, parsed back by the post-deploy check.
        string memory json = deploymentJson(d);
        vm.writeFile("out/deploy-system-test.json", json);
        Deployed memory back = parseDeployment(vm.readFile("out/deploy-system-test.json"));
        assertEq(back.engine, d.engine);
        assertEq(back.pool, d.pool);
        assertEq(back.registry, d.registry);
        assertEq(back.priceGuard, d.priceGuard);
        assertEq(back.volOracle, d.volOracle);
        assertEq(back.usdg, d.usdg);
        assertEq(back.agentRouter, d.agentRouter);
        assertEq(back.timelock, d.timelock);
        assertEq(back.stocks.length, 5);
        assertEq(back.names[2], "SPY");
        assertEq(back.feeds[4], d.feeds[4]);
        assertEq(vm.parseJsonUint(json, ".poolShareDecimals"), 12);
        assertEq(vm.parseJsonUint(json, ".chainId"), 31_337);
        assertEq(vm.parseJsonString(json, ".network"), "fork");
        assertEq(vm.parseJsonUint(json, ".stocks[0].deployBlock"), d.deployBlock);

        // The deployed system trades.
        (bytes32 id,) = _smoke(c, d);
        assertGt(_sellAll(d, id), 0, "sell pays");
    }

    function test_R1_testnetProfileDeploysMocksAndTrades() public {
        vm.chainId(CHAIN_TESTNET);
        Config memory c = _testnetConfig();
        Deployed memory d = _deploy(c);
        assertEq(d.timelock, address(0), "no timelock on testnet");
        assertEq(d.admin, owner, "testnet admin is the owner");
        for (uint256 i; i < d.stocks.length; ++i) {
            assertEq(TestnetFeed(d.feeds[i]).updater(), keeper, "keeper mirrors the feeds");
            assertEq(TestnetStockToken(d.stocks[i]).decimals(), 18);
        }
        assertEq(TestnetUSDG(d.usdg).decimals(), 6);
        _assertClean(c, d);
        (bytes32 id,) = _smoke(c, d);
        assertGt(_sellAll(d, id), 0);
    }

    // ------------------------------------------------------------------------------------------------- R2

    function test_R2_rolesWired() public {
        Config memory c = _forkConfig();
        Deployed memory d = _deploy(c);
        address[] memory t = adminTargets(d);
        bytes32[4] memory roles = [ADMIN, KEEPER, GUARDIAN, HEDGER];
        for (uint256 i; i < t.length; ++i) {
            for (uint256 r; r < roles.length; ++r) {
                assertFalse(IAccessControl(t[i]).hasRole(roles[r], deployer), "fresh deployer holds nothing");
            }
            assertTrue(IAccessControl(t[i]).hasRole(ADMIN, d.timelock), "admin = timelock");
            assertFalse(IAccessControl(t[i]).hasRole(ADMIN, d.safe), "the Safe only acts through the timelock");
            assertFalse(IAccessControl(t[i]).hasRole(ADMIN, guardian), "guardian is not admin");
        }
        TimelockController tl = TimelockController(payable(d.timelock));
        assertEq(tl.getMinDelay(), 48 hours);
        assertTrue(tl.hasRole(tl.PROPOSER_ROLE(), d.safe));
        assertTrue(tl.hasRole(tl.EXECUTOR_ROLE(), d.safe));
        assertFalse(tl.hasRole(ADMIN, deployer));
        assertGt(d.safe.code.length, 0, "the Safe is a contract on forks too");
        // Three different bot addresses.
        assertTrue(keeper != hedger && keeper != volSigner && hedger != volSigner);
        assertEq(VolOracle(d.volOracle).signer(), volSigner);
        assertTrue(IAccessControl(d.registry).hasRole(KEEPER, keeper));
        assertTrue(IAccessControl(d.marketHours).hasRole(KEEPER, keeper));
        assertTrue(IAccessControl(d.pool).hasRole(HEDGER, hedger));
        assertFalse(IAccessControl(d.pool).hasRole(HEDGER, keeper));
        assertFalse(IAccessControl(d.registry).hasRole(KEEPER, hedger));
    }

    function test_R2_botsMustBeThreeDifferentAddresses() public {
        Config memory c = _forkConfig();
        c.roles.volSigner = keeper;
        vm.expectRevert("SystemConfig: keeper, hedger and volSigner must be three different addresses");
        this.doDeploy(c);
        c.roles.volSigner = volSigner;
        c.roles.hedger = keeper;
        vm.expectRevert("SystemConfig: keeper, hedger and volSigner must be three different addresses");
        this.doDeploy(c);
    }

    /// The guardian can pause buys (engine, per name), shield (via buys) and deposits, and nothing else: it cannot
    /// unpause, change params or upgrade, and sells and withdrawal claims keep working through every pause.
    function test_R2_guardianCanOnlyPauseBuysShieldAndDeposits() public {
        Config memory c = _forkConfig();
        Deployed memory d = _deploy(c);
        (bytes32 id,) = _smoke(c, d);
        LemniscateEngine engine = LemniscateEngine(d.engine);
        WriterPool pool = WriterPool(d.pool);

        vm.warp(block.timestamp + 24 hours); // the deposit lock
        _openSession(d);
        _postVols(d);
        uint256 shares = pool.balanceOf(lp) / 10;
        vm.prank(lp);
        uint256 ticket = pool.requestWithdraw(shares);

        vm.startPrank(guardian);
        engine.setBuysPaused(true);
        engine.setSeriesBuysPaused(id, true);
        PriceGuard(d.priceGuard).setBuysPaused(d.stocks[0], true);
        pool.setDepositsPaused(true);

        vm.expectRevert();
        engine.setBuysPaused(false);
        vm.expectRevert();
        pool.setDepositsPaused(false);
        vm.expectRevert();
        PriceGuard(d.priceGuard).setBuysPaused(d.stocks[0], false);
        EngineHelper.Params memory p = engine.params();
        vm.expectRevert();
        engine.setParams(p);
        vm.expectRevert();
        pool.setParams(1 days, 0, 0, 0);
        vm.expectRevert();
        engine.upgradeToAndCall(d.engineImpl, "");
        vm.expectRevert();
        VolOracle(d.volOracle).setSigner(guardian);
        vm.expectRevert();
        SeriesRegistry(d.registry).setStock(d.stocks[0], false, 0, "NVDA");
        vm.stopPrank();

        // Buys and shield are paused, sells are not.
        vm.prank(alice);
        vm.expectRevert();
        engine.buy(id, 1e18, type(uint128).max, uint64(block.timestamp), alice);
        assertGt(_sellAll(d, id), 0, "sells work while everything is paused");

        // Withdrawal claims work while deposits are paused.
        vm.warp(block.timestamp + 72 hours);
        _openSession(d);
        assertGt(pool.claim(ticket), 0, "claims work while deposits are paused");
    }

    // ------------------------------------------------------------------------------------------------- R3

    function test_R3_postDeployCheckPassesOnFreshDeployment() public {
        Config memory c = _forkConfig();
        Deployed memory d = _deploy(c);
        _assertClean(c, d);
        _openSession(d); // in session: feed age and in-session reads are checked too
        _assertClean(c, d);
    }

    function _fresh() internal returns (Config memory c, Deployed memory d) {
        c = _forkConfig();
        d = _deploy(c);
        _assertClean(c, d);
    }

    function test_R3_fails_eoaAdminLeft() public {
        (Config memory c, Deployed memory d) = _fresh();
        vm.prank(d.timelock);
        IAccessControl(d.engine).grantRole(ADMIN, deployer);
        _expectFail(c, d, "EOA_ADMIN_LEFT");
    }

    function test_R3_fails_signerIsKeeper() public {
        (Config memory c, Deployed memory d) = _fresh();
        vm.prank(d.timelock);
        VolOracle(d.volOracle).setSigner(keeper);
        _expectFail(c, d, "SIGNER_IS_BOT");
        _expectFail(c, d, "VOL_SIGNER_MISMATCH");
    }

    function test_R3_fails_feedStale() public {
        (Config memory c, Deployed memory d) = _fresh();
        _openSession(d);
        MockGuardFeed(d.feeds[1]).setRound(100e8, block.timestamp - 27 hours);
        _expectFail(c, d, "FEED_STALE:TSLA");
    }

    function test_R3_fails_stockNotAllowed() public {
        (Config memory c, Deployed memory d) = _fresh();
        vm.prank(d.timelock);
        SeriesRegistry(d.registry).setStock(d.stocks[2], false, 5e18, "SPY");
        _expectFail(c, d, "STOCK_NOT_ALLOWED:SPY");
    }

    function test_R3_fails_poolAllowlistOff() public {
        (Config memory c, Deployed memory d) = _fresh();
        vm.prank(d.timelock);
        WriterPool(d.pool).setPublicDeposits(true);
        _expectFail(c, d, "POOL_ALLOWLIST_OFF");
    }

    function test_R3_fails_multiplierNotEmbedded() public {
        (Config memory c, Deployed memory d) = _fresh();
        IPriceGuard.StockConfig memory cfg = PriceGuard(d.priceGuard).config(d.stocks[0]);
        cfg.multiplierEmbedded = false;
        vm.prank(d.timelock);
        PriceGuard(d.priceGuard).setStock(d.stocks[0], cfg);
        _expectFail(c, d, "MULTIPLIER_NOT_EMBEDDED:NVDA");
    }

    function test_R3_fails_twapMissing() public {
        (Config memory c, Deployed memory d) = _fresh();
        vm.prank(d.timelock);
        PriceGuard(d.priceGuard).setTwapSource(d.stocks[3], address(0), 0, 0);
        _expectFail(c, d, "TWAP_MISSING:QQQ");
    }

    function test_R3_fails_hedgerRoleMissing() public {
        (Config memory c, Deployed memory d) = _fresh();
        vm.prank(d.timelock);
        IAccessControl(d.pool).revokeRole(HEDGER, hedger);
        _expectFail(c, d, "HEDGER_ROLE_MISSING");
    }

    function test_R3_fails_keeperRoleMissing() public {
        (Config memory c, Deployed memory d) = _fresh();
        vm.prank(d.timelock);
        IAccessControl(d.registry).revokeRole(KEEPER, keeper);
        _expectFail(c, d, "KEEPER_ROLE_MISSING");
    }

    /// todo 23 (fork run): the keeper's risk monitor pauses buys through the engine's GUARDIAN role (todo 13 R5); the deploy
    /// never granted it, so the keeper refused to start on the fork. The keeper may pause engine buys, nothing else.
    function test_R2_keeperCanPauseEngineBuysForTheRiskMonitor() public {
        (, Deployed memory d) = _fresh();
        assertTrue(IAccessControl(d.engine).hasRole(GUARDIAN, keeper), "keeper holds engine GUARDIAN (risk monitor)");
        assertFalse(IAccessControl(d.pool).hasRole(GUARDIAN, keeper), "keeper does not pause deposits");
        assertFalse(IAccessControl(d.priceGuard).hasRole(GUARDIAN, keeper), "keeper does not pause PriceGuard");
    }

    function test_R3_fails_keeperGuardianMissing() public {
        (Config memory c, Deployed memory d) = _fresh();
        vm.prank(d.timelock);
        IAccessControl(d.engine).revokeRole(GUARDIAN, keeper);
        _expectFail(c, d, "KEEPER_GUARDIAN_MISSING");
    }

    function test_R3_fails_guardianHasAdmin() public {
        (Config memory c, Deployed memory d) = _fresh();
        vm.prank(d.timelock);
        IAccessControl(d.priceGuard).grantRole(ADMIN, guardian);
        _expectFail(c, d, "GUARDIAN_HAS_ADMIN");
    }

    function test_R3_fails_safeBypassesTimelock() public {
        (Config memory c, Deployed memory d) = _fresh();
        vm.prank(d.timelock);
        IAccessControl(d.pool).grantRole(ADMIN, d.safe);
        _expectFail(c, d, "SAFE_BYPASSES_TIMELOCK");
    }

    function test_R3_fails_depthCapChanged() public {
        (Config memory c, Deployed memory d) = _fresh();
        vm.prank(d.timelock);
        LemniscateEngine(d.engine).setHedgeDepthCap(d.stocks[4], 0);
        _expectFail(c, d, "DEPTH_CAP:AAPL");
    }

    function test_R3_fails_feeRecipientWrong() public {
        (Config memory c, Deployed memory d) = _fresh();
        vm.prank(d.timelock);
        FeeRouter(d.feeRouter).setRecipient("hedger", alice);
        _expectFail(c, d, "FEE_RECIPIENT");
    }

    function test_R3_fails_shortQueueTimerOnFork() public {
        (Config memory c, Deployed memory d) = _fresh();
        WriterPool shortImpl = new WriterPool(5 minutes);
        vm.prank(d.timelock);
        WriterPool(d.pool).upgradeToAndCall(address(shortImpl), "");
        _expectFail(c, d, "TIMER:poolQueueDelay");
        _expectFail(c, d, "IMPLEMENTATION_MISMATCH");
    }

    function test_R3_fails_shortTimelockDelay() public {
        (Config memory c, Deployed memory d) = _fresh();
        TimelockController tl = TimelockController(payable(d.timelock));
        vm.prank(d.timelock);
        tl.updateDelay(1 hours);
        _expectFail(c, d, "TIMELOCK_DELAY_SHORT");
    }

    function test_R3_fails_buysLeftPaused() public {
        (Config memory c, Deployed memory d) = _fresh();
        vm.prank(guardian);
        LemniscateEngine(d.engine).setBuysPaused(true);
        _expectFail(c, d, "ENGINE_BUYS_PAUSED");
    }

    function test_R3_fails_wrongChain() public {
        (Config memory c, Deployed memory d) = _fresh();
        vm.chainId(CHAIN_MAINNET);
        _expectFail(c, d, "CHAIN_ID_MISMATCH");
    }

    function test_R3_fails_noTimelockOnFork() public {
        Config memory c = _forkConfig();
        c.handoff = false; // the deployer keeps admin: refused on fork/mainnet
        Deployed memory d = this.doDeploy(c);
        _expectFail(c, d, "EOA_ADMIN_LEFT");
        _expectFail(c, d, "ADMIN_NOT_TIMELOCK");
    }

    // ------------------------------------------------------------------------------------------------- R8 / R9

    function test_R8_forkAndMainnetUseFullTimers() public {
        Config memory c = _forkConfig();
        Deployed memory d = _deploy(c);
        assertEq(WriterPool(d.pool).QUEUE_DELAY(), 72 hours);
        assertEq(WriterPool(d.pool).lockSeconds(), 24 hours);
        assertEq(FeeRouter(d.feeRouter).PERIOD(), 7 days);
        assertEq(TimelockController(payable(d.timelock)).getMinDelay(), 48 hours);
        assertEq(VolOracle(d.volOracle).MAX_VALIDITY(), 2 hours);
        assertEq(VolOracle(d.volOracle).MIN_POST_INTERVAL(), 5 minutes);
        assertEq(VolOracle(d.volOracle).ROLLING_WINDOW(), 1 hours);
        assertEq(PriceGuard(d.priceGuard).SPLIT_LEAD(), 24 hours);
        assertEq(PriceGuard(d.priceGuard).SPLIT_TAIL(), 1 hours);
    }

    function test_R8_testnetUsesShortTimers() public {
        vm.chainId(CHAIN_TESTNET);
        Config memory c = _testnetConfig();
        Deployed memory d = _deploy(c);
        assertEq(WriterPool(d.pool).QUEUE_DELAY(), 10 minutes);
        assertEq(WriterPool(d.pool).lockSeconds(), 2 minutes);
        assertEq(FeeRouter(d.feeRouter).PERIOD(), 15 minutes);
        assertEq(VolOracle(d.volOracle).MAX_VALIDITY(), 30 minutes);
        assertEq(VolOracle(d.volOracle).MIN_POST_INTERVAL(), 30 seconds);
        assertEq(VolOracle(d.volOracle).ROLLING_WINDOW(), 6 minutes);
        assertEq(PriceGuard(d.priceGuard).SPLIT_LEAD(), 15 minutes);
        assertEq(PriceGuard(d.priceGuard).SPLIT_TAIL(), 5 minutes);

        // A whole LP cycle finishes in minutes: deposit, lock, queue, claim.
        (bytes32 id,) = _smoke(c, d);
        _sellAll(d, id);
        WriterPool pool = WriterPool(d.pool);
        vm.warp(block.timestamp + 2 minutes);
        uint256 shares = pool.balanceOf(lp) / 2;
        vm.prank(lp);
        uint256 ticket = pool.requestWithdraw(shares);
        vm.warp(block.timestamp + 10 minutes);
        _openSession(d);
        assertGt(pool.claim(ticket), 0, "claim after 10 minutes on testnet");
    }

    function test_R8_testnetTimersBelowHardMinimumsRefused() public {
        vm.chainId(CHAIN_TESTNET);
        Config memory c = _testnetConfig();
        c.timers.poolQueueDelay = 4 minutes;
        vm.expectRevert(WriterPool.InvalidParams.selector);
        this.doDeploy(c);
        c = _testnetConfig();
        c.timers.feePeriod = 1 minutes;
        vm.expectRevert();
        this.doDeploy(c);
        c = _testnetConfig();
        c.timers.volMinPostInterval = 10 seconds;
        vm.expectRevert(VolOracle.InvalidTimer.selector);
        this.doDeploy(c);
        c = _testnetConfig();
        c.timers.splitLead = 1 minutes;
        vm.expectRevert(PriceGuard.InvalidTimer.selector);
        this.doDeploy(c);
        c = _testnetConfig();
        c.timers.depositLock = 30;
        vm.expectRevert(WriterPool.InvalidParams.selector);
        this.doDeploy(c);
    }

    function test_R9_mainnetRefusesOtherChains() public {
        Config memory c = _forkConfig();
        c.profileName = "mainnet";
        c.profile = PROFILE_MAINNET;
        c.roles.safe = address(new MockSafe(3, 5));
        vm.expectRevert("SystemConfig: chain id does not match the profile");
        this.doDeploy(c); // chain 31337
        vm.chainId(CHAIN_TESTNET);
        vm.expectRevert("SystemConfig: chain id does not match the profile");
        this.doDeploy(c);
    }

    function test_R9_mainnetNeedsA3of5Safe() public {
        Config memory c = _forkConfig();
        vm.chainId(CHAIN_MAINNET);
        c.profileName = "mainnet";
        c.profile = PROFILE_MAINNET;
        vm.expectRevert("SystemConfig: mainnet Safe has no code");
        this.doDeploy(c);
        c.roles.safe = address(new MockSafe(2, 5));
        vm.expectRevert("SystemConfig: mainnet Safe must be at least 3-of-5");
        this.doDeploy(c);
        c.roles.safe = address(new MockSafe(3, 4));
        vm.expectRevert("SystemConfig: mainnet Safe must be at least 3-of-5");
        this.doDeploy(c);

        c.roles.safe = address(new MockSafe(3, 5));
        Deployed memory d = this.doDeploy(c);
        assertEq(d.safe, c.roles.safe);
        assertEq(WriterPool(d.pool).QUEUE_DELAY(), 72 hours, "mainnet: full timers");
        assertEq(TimelockController(payable(d.timelock)).getMinDelay(), 48 hours);
        _assertClean(c, d);
    }

    function test_R9_testnetProfileOnlyOnItsChain() public {
        Config memory c = _testnetConfig();
        vm.expectRevert("SystemConfig: chain id does not match the profile");
        this.doDeploy(c); // 31337
    }

    function test_R9_configJson() public view {
        // Fork/mainnet configs cannot carry timers (full timers only).
        string memory forkJson = string.concat(
            '{"profile":"fork","usdg":"', vm.toString(address(0xA11CE)), '","timers":{"poolQueueDelay":300},"stocks":[]}'
        );
        try this.doParse(forkJson) {
            revert("fork config with timers was accepted");
        } catch Error(string memory reason) {
            assertEq(reason, "SystemConfig: fork/mainnet use full timers; remove .timers");
        }
        string memory testnetJson = string.concat(
            '{"profile":"testnet","roles":{"owner":"',
            vm.toString(owner),
            '","keeper":"',
            vm.toString(keeper),
            '","depositors":["',
            vm.toString(lp),
            '"]},"timers":{"poolQueueDelay":600,"depositLock":120,"feePeriod":900,"volMaxValidity":1800,',
            '"volMinPostInterval":30,"splitLead":900,"splitTail":300},',
            '"stocks":[{"name":"NVDA","strikeStepUsd":5,"mockPriceUsdE8":21799000000},{"name":"TSLA","twapBandBps":125}]}'
        );
        Config memory c = this.doParse(testnetJson);
        assertEq(c.profile, PROFILE_TESTNET);
        assertEq(c.roles.owner, owner);
        assertEq(c.roles.depositors[0], lp);
        assertEq(c.timers.poolQueueDelay, 600);
        assertEq(c.timers.volMinPostInterval, 30);
        assertEq(c.stocks.length, 2);
        assertEq(c.stocks[0].strikeStepUsd, 5);
        assertEq(c.stocks[0].mockPriceUsdE8, 21_799_000_000);
        assertEq(c.stocks[1].twapBandBps, 125);
        assertEq(c.stocks[0].twapBandBps, 75, "default band");
        assertEq(c.stocks[0].maxAgeRegular, 26 hours, "default maxAge");
        assertTrue(c.handoff, "handoff defaults on");
    }

    // ------------------------------------------------------------------------------- todo 19 vaults flag

    function test_T19_vaultsOffByDefault() public {
        Config memory c = _forkConfig();
        assertFalse(c.vaults.enabled);
        Deployed memory d = _deploy(c);
        assertEq(WriterPool(d.pool).vaultHook(), address(0), "no vault hook");
        assertEq(d.vaultRegistry, address(0));
        _assertClean(c, d);
    }

    /// todo 20c: $LMNS staking and fee tiers are off after DeploySystem; PostDeployCheck fails if either is wired.
    function test_T20_lmnsOffByDefaultAndChecked() public {
        (Config memory c, Deployed memory d) = _fresh();
        assertEq(address(WriterPool(d.pool).staking()), address(0), "no staking loss layer");
        assertEq(LemniscateEngine(d.engine).feeTiers(), address(0), "no fee tiers");
        vm.prank(d.timelock);
        LemniscateEngine(d.engine).setFeeTiers(d.registry); // any contract: the check only asks "is anything wired"
        _expectFail(c, d, "LMNS_NOT_OFF");
    }

    function test_T19_vaultsFlagDeploysClosedVaults_fork() public {
        Config memory c = _forkConfig();
        c.vaults = VaultCfg({enabled: true, epoch: FULL_VAULT_EPOCH});
        Deployed memory d = _deploy(c);
        assertEq(WriterPool(d.pool).vaultHook(), d.vaultRegistry);
        assertEq(d.vaults.length, 2 * NAMES.length);
        for (uint256 i; i < d.vaults.length; ++i) {
            WriterVault v = WriterVault(d.vaults[i]);
            assertFalse(v.open(), "closed by default");
            assertEq(v.EPOCH(), 7 days);
            assertTrue(IAccessControl(address(v)).hasRole(bytes32(0), d.timelock), "timelock administers the vault");
            assertFalse(IAccessControl(address(v)).hasRole(bytes32(0), deployer));
        }
        VaultRegistry reg = VaultRegistry(d.vaultRegistry);
        assertTrue(reg.hasRole(bytes32(0), d.timelock));
        assertTrue(reg.hasRole(reg.ALLOCATOR_ROLE(), keeper));
        _assertClean(c, d);
        // the post-deploy check catches an open vault
        vm.prank(d.timelock);
        WriterVault(d.vaults[0]).setOpen(true);
        _expectFail(c, d, "VAULT_OPEN");
    }

    function test_T19_vaultsFlagTestnetShortEpoch() public {
        vm.chainId(CHAIN_TESTNET);
        Config memory c = _testnetConfig();
        c.vaults = VaultCfg({enabled: true, epoch: 10 minutes});
        Deployed memory d = _deploy(c);
        assertEq(WriterVault(d.vaults[0]).EPOCH(), 10 minutes);
        _assertClean(c, d);
        (bytes32 id,) = _smoke(c, d); // trading works with the hook set and no slices
        assertGt(_sellAll(d, id), 0);
        // below the contract's hard minimum the deploy is refused
        vm.chainId(CHAIN_TESTNET);
        Config memory bad = _testnetConfig();
        bad.vaults = VaultCfg({enabled: true, epoch: 5 minutes - 1});
        vm.expectRevert();
        this.doDeploy(bad);
    }

    function test_T19_vaultConfigJson() public view {
        string memory forkJson = string.concat(
            '{"profile":"fork","usdg":"', vm.toString(address(0xA11CE)), '","vaults":{"enabled":true,"epoch":600},"stocks":[]}'
        );
        try this.doParse(forkJson) {
            revert("fork config with a vault epoch was accepted");
        } catch Error(string memory reason) {
            assertEq(reason, "SystemConfig: fork/mainnet use the full vault epoch");
        }
        Config memory c = this.doParse('{"profile":"fork","vaults":{"enabled":true},"stocks":[]}');
        assertTrue(c.vaults.enabled);
        assertEq(c.vaults.epoch, 7 days);
        c = this.doParse('{"profile":"testnet","vaults":{"enabled":true,"epoch":600},"stocks":[]}');
        assertEq(c.vaults.epoch, 600);
        c = this.doParse('{"profile":"testnet","stocks":[]}');
        assertFalse(c.vaults.enabled, "off by default");
    }
}
