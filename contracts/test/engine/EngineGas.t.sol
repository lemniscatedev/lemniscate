// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {LemniscateEngine} from "../../src/LemniscateEngine.sol";
import {EngineHelper} from "../../src/EngineHelper.sol";
import {PriceGuard} from "../../src/PriceGuard.sol";
import {VolOracle} from "../../src/VolOracle.sol";
import {SeriesRegistry} from "../../src/SeriesRegistry.sol";
import {IOptionEngine} from "../../src/interfaces/IOptionEngine.sol";
import {IPool} from "../../src/interfaces/IPool.sol";
import {IPriceGuard} from "../../src/interfaces/IPriceGuard.sol";
import {ISeriesRegistry} from "../../src/interfaces/ISeriesRegistry.sol";
import {IVolOracle} from "../../src/interfaces/IVolOracle.sol";
import {SessionKind, Speed} from "../../src/libs/OptionTypes.sol";
import {Roles} from "../../src/libs/Roles.sol";
import {MockGuardFeed, MockKindHours} from "../mocks/PriceGuardMocks.sol";
import {MockObservingPool, MockStock18} from "../mocks/TwapMocks.sol";
import {MockEnginePool, MockPausableUSDG} from "../mocks/EngineMocks.sol";

contract GasProbe {
    function liability(IOptionEngine e) external view returns (uint256 used, uint256 l) {
        uint256 g = gasleft();
        l = e.totalLiability();
        used = g - gasleft();
    }

    function accrueMany(IOptionEngine e, bytes32[] calldata ids) external returns (uint256 used) {
        uint256 g = gasleft();
        e.accrueMany(ids);
        used = g - gasleft();
    }
}

/// @notice Engine todo R10 / R19 gas record with the REAL PriceGuard (feed + TWAP pool cross-check on buys) and the
/// REAL VolOracle (signed posts): buy, sell, accrueMany(50), totalLiability with 200 series over 4 names.
contract EngineGasTest is Test {
    uint256 internal constant T0 = 1_790_000_000;
    // Well-known anvil dev account 0 (public, never funded on a real network).
    uint256 internal constant SIGNER_PK = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80; // test-key
    int24 internal constant TICK_100 = -230_270; // $100 stock (token0) against 6-decimal USDG

    address internal admin = makeAddr("admin");
    address internal lister = makeAddr("lister");
    address internal alice = makeAddr("alice");

    MockPausableUSDG internal usdg;
    MockKindHours internal hours_;
    PriceGuard internal guard;
    VolOracle internal vol;
    SeriesRegistry internal registry;
    MockEnginePool internal pool;
    LemniscateEngine internal engine;
    MockStock18[4] internal stocks;
    MockGuardFeed[4] internal feeds;
    uint64 internal nonce;

    function setUp() public {
        vm.warp(T0);
        usdg = new MockPausableUSDG();
        hours_ = new MockKindHours(); // REGULAR
        guard = new PriceGuard(admin, address(hours_), 24 hours, 1 hours);
        vol = new VolOracle(admin, vm.addr(SIGNER_PK), 2 hours, 5 minutes);
        registry = new SeriesRegistry(admin, IPriceGuard(address(guard)));
        pool = new MockEnginePool(IERC20(address(usdg)));
        LemniscateEngine impl = new LemniscateEngine();
        engine = LemniscateEngine(
            address(
                new ERC1967Proxy(
                    address(impl),
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
        pool.setEngine(address(engine));
        usdg.mint(address(pool), 20_000_000e6);
        usdg.mint(alice, 100_000_000e6);
        vm.prank(alice);
        usdg.approve(address(engine), type(uint256).max);

        vm.startPrank(admin);
        registry.setEngine(address(engine));
        registry.grantRole(Roles.KEEPER_ROLE, lister);
        for (uint256 i; i < 4; ++i) {
            stocks[i] = new MockStock18();
            feeds[i] = new MockGuardFeed(8, 100e8);
            guard.setStock(
                address(stocks[i]),
                IPriceGuard.StockConfig({
                    feed: address(feeds[i]),
                    multiplierEmbedded: true,
                    maxAgeRegular: 26 hours,
                    maxAgeExtended: 26 hours,
                    continuityBps: 1500,
                    enabled: true
                })
            );
            MockObservingPool twap =
                new MockObservingPool(address(stocks[i]), address(usdg), TICK_100, 7200, 2 hours);
            guard.setTwapSource(address(stocks[i]), address(twap), 0, 0);
            registry.setStock(address(stocks[i]), true, 0, "STK");
        }
        vm.stopPrank();
        for (uint256 i; i < 4; ++i) {
            guard.poke(address(stocks[i]));
            _post(address(stocks[i]), Speed.DAILY);
            _post(address(stocks[i]), Speed.WEEKLY);
        }
    }

    function _post(address stock, Speed speed) internal {
        IVolOracle.Post memory p = IVolOracle.Post({
            stock: stock,
            speed: speed,
            sigmaBps: 5000,
            skewK: (uint64(12_000) << 32) | 4000,
            eventBumpBps: 0,
            buyBlockFrom: 0,
            buyBlockTo: 0,
            validUntil: uint64(vm.getBlockTimestamp() + 2 hours),
            nonce: ++nonce
        });
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(SIGNER_PK, vol.hashPost(p));
        vol.post(p, abi.encodePacked(r, s, v));
    }

    function _book(uint256 perStock) internal returns (bytes32[] memory ids) {
        ids = new bytes32[](4 * perStock);
        uint256 n;
        for (uint256 i; i < 4; ++i) {
            for (uint256 j; j < perStock; ++j) {
                bool isCall = j % 2 == 0;
                uint32 tau = j % 4 < 2 ? 86_400 : 604_800;
                uint128 k = uint128((75 + j) * 1e18);
                vm.startPrank(lister);
                bytes32 id = registry.listSeries(address(stocks[i]), isCall, k, tau);
                registry.setBuyable(id, true);
                vm.stopPrank();
                vm.prank(alice);
                engine.buy(id, 2e18, type(uint128).max, uint64(vm.getBlockTimestamp()), alice);
                ids[n++] = id;
            }
        }
    }

    function test_R19_gasRecord() public {
        bytes32[] memory ids = _book(50); // 200 series, 4 names
        skip(30 minutes);
        for (uint256 i; i < 4; ++i) feeds[i].push(100e8);

        // buy (real full read: feed + TWAP observe), accrues first
        vm.prank(alice);
        engine.buy(ids[3], 5e18, type(uint128).max, uint64(vm.getBlockTimestamp()), alice);
        uint256 buyGas = vm.lastCallGas().gasTotalUsed;
        skip(10 minutes);
        // sell (readLite), accrues first
        vm.prank(alice);
        engine.sell(ids[5], 1e18, 0, uint64(vm.getBlockTimestamp()), alice);
        uint256 sellGas = vm.lastCallGas().gasTotalUsed;
        skip(30 minutes);
        GasProbe probe = new GasProbe();
        bytes32[] memory fifty = new bytes32[](50);
        for (uint256 i; i < 50; ++i) fifty[i] = ids[i * 4];
        uint256 manyGas = probe.accrueMany(engine, fifty);
        (uint256 liabGas, uint256 l) = probe.liability(engine);

        emit log_named_uint("buy gas (real PriceGuard + TWAP, real VolOracle)", buyGas);
        emit log_named_uint("sell gas (readLite)", sellGas);
        emit log_named_uint("accrueMany(50 series over 4 names) gas", manyGas);
        emit log_named_uint("totalLiability() with 200 series gas", liabGas);
        assertGt(l, 0);
        assertLt(manyGas, 16_000_000, "accrueMany(50) within half a 32M block");
        assertLt(liabGas, 30_000_000, "totalLiability(200) fits a block-sized eth_call");
        assertLt(buyGas, 3_000_000);
        assertLt(sellGas, 2_000_000);
    }
}
