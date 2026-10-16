// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {WriterPool} from "../../src/WriterPool.sol";
import {Reserve} from "../../src/Reserve.sol";
import {FeeRouter} from "../../src/FeeRouter.sol";
import {UniswapV3HedgeAdapter} from "../../src/UniswapV3HedgeAdapter.sol";
import {IPool} from "../../src/interfaces/IPool.sol";
import {IOptionEngine} from "../../src/interfaces/IOptionEngine.sol";
import {IPriceGuard} from "../../src/interfaces/IPriceGuard.sol";
import {IPriceReference} from "../../src/interfaces/IPriceReference.sol";
import {ISwapRouter02} from "../../src/interfaces/ISwapRouter02.sol";
import {IReserve} from "../../src/interfaces/IReserve.sol";
import {IFeeRouter} from "../../src/interfaces/IFeeRouter.sol";
import {SessionKind} from "../../src/libs/OptionTypes.sol";
import {MockUSDG} from "../mocks/MockUSDG.sol";
import {MockStockToken} from "../mocks/MockStockToken.sol";
import {MockSwapRouter} from "../mocks/MockSwapRouter.sol";
import {MockPriceReference} from "../mocks/MockPriceReference.sol";
import {MockPoolEngine, MockPoolPriceGuard} from "./PoolMocks.sol";

/// @dev Pool + Reserve + FeeRouter behind a mock engine and PriceGuard, one stock hedged through the real
/// UniswapV3HedgeAdapter over a fixed-rate router.
abstract contract PoolFixture is Test {
    uint256 internal constant USDG = 1e6;
    uint24 internal constant FEE = 500;
    uint256 internal constant S0 = 100e18;

    MockUSDG internal usdg;
    MockStockToken internal stock;
    MockSwapRouter internal swapRouter;
    UniswapV3HedgeAdapter internal adapter;
    MockPoolEngine internal engine;
    MockPoolPriceGuard internal guard;
    MockPriceReference internal twap;
    WriterPool internal pool;
    Reserve internal reserve;
    FeeRouter internal fees;

    address internal admin = address(this);
    address internal hedger = makeAddr("hedger");
    address internal guardian = makeAddr("guardian");
    address internal treasury = makeAddr("treasury");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");
    address internal seller = makeAddr("seller");

    function _deploy() internal {
        usdg = new MockUSDG();
        stock = new MockStockToken();
        swapRouter = new MockSwapRouter();
        adapter = new UniswapV3HedgeAdapter(ISwapRouter02(address(swapRouter)));
        engine = new MockPoolEngine(IERC20(address(usdg)));
        guard = new MockPoolPriceGuard();
        twap = new MockPriceReference();
        _deployPool(address(guard));
    }

    function _deployPool(address guard_) internal {
        WriterPool impl = new WriterPool();
        bytes memory init = abi.encodeCall(
            WriterPool.initialize,
            (admin, IERC20(address(usdg)), IOptionEngine(address(engine)), IPriceGuard(guard_))
        );
        pool = WriterPool(address(new ERC1967Proxy(address(impl), init)));
        reserve = new Reserve(admin, IERC20(address(usdg)), address(pool));
        fees = new FeeRouter(admin, IERC20(address(usdg)), address(pool), treasury);
        pool.setModules(
            IOptionEngine(address(engine)), IReserve(address(reserve)), IFeeRouter(address(fees)), IPriceReference(address(0))
        );
        engine.setPool(IPool(address(pool)));
        MockPoolPriceGuard(guard_).set(address(stock), S0, SessionKind.REGULAR, true);
        pool.setHedgeRoute(address(stock), adapter, FEE);
        pool.grantRole(pool.HEDGER_ROLE(), hedger);
        pool.grantRole(pool.GUARDIAN_ROLE(), guardian);
        pool.setDepositor(alice, true);
        pool.setDepositor(bob, true);
        pool.setDepositor(carol, true);
        _setRouterPrice(S0);
        usdg.mint(address(swapRouter), 100_000_000 * USDG);
        stock.mint(address(swapRouter), 1_000_000e18);
    }

    /// @dev Router executes exactly at `s` (WAD USDG per whole token).
    function _setRouterPrice(uint256 s) internal {
        swapRouter.setRate(address(usdg), address(stock), FEE, 1e48 / s);
        swapRouter.setRate(address(stock), address(usdg), FEE, s / 1e12);
    }

    function _setPrice(uint256 s) internal {
        guard.set(address(stock), s, SessionKind.REGULAR, true);
        _setRouterPrice(s);
    }

    function _deposit(address who, uint256 amount) internal returns (uint256 shares) {
        usdg.mint(who, amount);
        vm.startPrank(who);
        usdg.approve(address(pool), amount);
        shares = pool.deposit(amount, who);
        vm.stopPrank();
    }

    function _request(address who, uint256 shares) internal returns (uint256 ticket) {
        vm.prank(who);
        ticket = pool.requestWithdraw(shares);
    }

    /// @dev Engine buy of `usdgIn` paid by a fresh buyer, liability grows by `liabilityUsdg` (6 dp).
    function _engineBuy(uint256 usdgIn, uint256 spreadUsdg, uint256 liabilityUsdg) internal {
        address buyer = makeAddr("buyer");
        usdg.mint(buyer, usdgIn);
        vm.startPrank(buyer);
        usdg.approve(address(engine), usdgIn);
        engine.buy(bytes32("s"), usdgIn, spreadUsdg, liabilityUsdg * 1e12);
        vm.stopPrank();
    }

    function _hedgeTo(uint256 units) internal {
        vm.prank(hedger);
        pool.rebalance(address(stock), units, 0);
    }

    function _shareValue(address who) internal view returns (uint256) {
        int256 n = pool.nav();
        if (n <= 0) return 0;
        return pool.balanceOf(who) * uint256(n) / 1e12 / pool.totalSupply();
    }
}
