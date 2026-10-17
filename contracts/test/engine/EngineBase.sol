// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {LemniscateEngine} from "../../src/LemniscateEngine.sol";
import {EngineHelper} from "../../src/EngineHelper.sol";
import {SeriesRegistry} from "../../src/SeriesRegistry.sol";
import {IOptionEngine} from "../../src/interfaces/IOptionEngine.sol";
import {IPool} from "../../src/interfaces/IPool.sol";
import {IPriceGuard} from "../../src/interfaces/IPriceGuard.sol";
import {ISeriesRegistry} from "../../src/interfaces/ISeriesRegistry.sol";
import {IVolOracle} from "../../src/interfaces/IVolOracle.sol";
import {Series, SessionKind, Speed} from "../../src/libs/OptionTypes.sol";
import {Roles} from "../../src/libs/Roles.sol";
import {MockStockToken} from "../mocks/MockStockToken.sol";
import {MockEnginePool, MockEnginePriceGuard, MockEngineVol, MockPausableUSDG} from "../mocks/EngineMocks.sol";
import {EngineStorage} from "../../src/engine/EngineStorage.sol";

/// @dev Engine behind an ERC1967 proxy, the real SeriesRegistry and option-token clones, mock PriceGuard / VolOracle /
/// Writer Pool. Two names (NVDA-like at $100, TSLA-like at $200), sigma 50% on both speeds, pool cash $2M.
abstract contract EngineBase is Test {
    uint256 internal constant T0 = 1_790_000_000; // 2026-09-21, a Monday
    uint256 internal constant WAD = 1e18;
    uint32 internal constant DAILY = 86_400;
    uint32 internal constant WEEKLY = 604_800;
    uint256 internal constant POOL_CASH = 2_000_000e6;

    address internal admin = makeAddr("admin");
    address internal lister = makeAddr("lister");
    address internal guardian = makeAddr("guardian");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");

    MockPausableUSDG internal usdg;
    MockStockToken internal nvda;
    MockStockToken internal tsla;
    MockEnginePriceGuard internal guard;
    MockEngineVol internal vol;
    MockEnginePool internal pool;
    SeriesRegistry internal registry;
    LemniscateEngine internal engine;
    LemniscateEngine internal impl;
    EngineHelper internal helper;

    function setUp() public virtual {
        vm.warp(T0);
        usdg = new MockPausableUSDG();
        nvda = new MockStockToken();
        tsla = new MockStockToken();
        guard = new MockEnginePriceGuard();
        vol = new MockEngineVol();
        pool = new MockEnginePool(IERC20(address(usdg)));
        registry = new SeriesRegistry(admin, IPriceGuard(address(guard)));

        impl = new LemniscateEngine();
        bytes memory init = abi.encodeCall(
            LemniscateEngine.initialize,
            (
                admin,
                IERC20(address(usdg)),
                IPool(address(pool)),
                ISeriesRegistry(address(registry)),
                IPriceGuard(address(guard)),
                IVolOracle(address(vol))
            )
        );
        engine = LemniscateEngine(address(new ERC1967Proxy(address(impl), init)));
        helper = engine.HELPER();
        pool.setEngine(address(engine));

        vm.startPrank(admin);
        registry.setEngine(address(engine));
        registry.setStock(address(nvda), true, 0, "NVDA");
        registry.setStock(address(tsla), true, 0, "TSLA");
        registry.grantRole(Roles.KEEPER_ROLE, lister);
        engine.grantRole(Roles.GUARDIAN_ROLE, guardian);
        vm.stopPrank();

        guard.set(address(nvda), 100e18, SessionKind.REGULAR, true);
        guard.set(address(tsla), 200e18, SessionKind.REGULAR, true);
        _setVol(address(nvda), 5000, 0);
        _setVol(address(tsla), 5000, 0);

        usdg.mint(address(pool), POOL_CASH);
        _fund(alice);
        _fund(bob);
    }

    // ------------------------------------------------------------------------------------------------ helpers

    function _setVol(address stock, uint64 sigma, uint64 skewK) internal {
        vol.set(stock, Speed.DAILY, sigma, skewK, uint64(vm.getBlockTimestamp() + 3650 days));
        vol.set(stock, Speed.WEEKLY, sigma, skewK, uint64(vm.getBlockTimestamp() + 3650 days));
    }

    /// @dev Suites written before the $1 minimum trade (review F08/F14) that trade fractions of a dollar.
    function _lowMinTrade() internal {
        vm.prank(admin);
        engine.setGuards(EngineStorage.Guards({minTradeUsdg: 1, holdSeconds: 0, haltSettleDelay: 0}));
    }

    function _fund(address who) internal {
        usdg.mint(who, 10_000_000e6);
        vm.prank(who);
        usdg.approve(address(engine), type(uint256).max);
    }

    function _list(address stock, bool isCall, uint128 strike, uint32 tau) internal returns (bytes32 id) {
        vm.startPrank(lister);
        id = registry.listSeries(stock, isCall, strike, tau);
        registry.setBuyable(id, true);
        vm.stopPrank();
    }

    function _token(bytes32 id) internal view returns (IERC20) {
        return IERC20(registry.seriesOf(id).token);
    }

    function _buy(address who, bytes32 id, uint256 units) internal returns (uint256 cost, uint256 tokens) {
        vm.prank(who);
        return engine.buy(id, uint128(units), type(uint128).max, uint64(vm.getBlockTimestamp()), who);
    }

    function _sell(address who, bytes32 id, uint256 tokens) internal returns (uint256 proceeds) {
        vm.prank(who);
        return engine.sell(id, uint128(tokens), 0, uint64(vm.getBlockTimestamp()), who);
    }

    function _nav() internal view returns (int256) {
        return pool.nav();
    }

    /// @dev Independent liability: sum over the engine's series of supply x norm x V at the current mock prices.
    function _liabilityRef() internal view returns (uint256 total) {
        address[] memory ss = engine.stocks();
        for (uint256 i; i < ss.length; ++i) {
            bytes32[] memory ids = engine.seriesOfStock(ss[i]);
            for (uint256 j; j < ids.length; ++j) {
                Series memory s = registry.seriesOf(ids[j]);
                uint256 supply = IERC20(s.token).totalSupply();
                if (supply == 0) continue;
                (uint256 sNow,,,,) = guard.px(ss[i]);
                (uint64 sigma, uint64 skew) = _vol(ss[i], s.tauSeconds);
                (uint256 v,) = helper.valueAt(s.isCall, sNow, s.strike, sigma, skew, 0, s.tauSeconds);
                total += Math.mulDiv(Math.mulDiv(supply, s.norm, WAD), v, WAD);
            }
        }
    }

    function _vol(address stock, uint32 tau) internal view returns (uint64 sigma, uint64 skew) {
        Speed sp = tau == DAILY ? Speed.DAILY : Speed.WEEKLY;
        sigma = vol.read(stock, sp).sigmaBps;
        skew = vol.read(stock, sp).skewK;
    }
}
