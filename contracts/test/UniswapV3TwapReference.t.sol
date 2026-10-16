// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {
    IUniswapV3FactoryLike, IUniswapV3PoolLike, UniswapV3TwapReference
} from "../src/UniswapV3TwapReference.sol";

contract MockTwapPool {
    address public token0;
    int56 public tickCumulativeDelta;
    bool public tooYoung;

    constructor(address token0_) {
        token0 = token0_;
    }

    function set(int56 delta, bool tooYoung_) external {
        tickCumulativeDelta = delta;
        tooYoung = tooYoung_;
    }

    function observe(uint32[] calldata) external view returns (int56[] memory ticks, uint160[] memory liq) {
        require(!tooYoung, "OLD");
        ticks = new int56[](2);
        ticks[0] = 1_000_000;
        ticks[1] = 1_000_000 + tickCumulativeDelta;
        liq = new uint160[](2);
    }
}

contract MockTwapFactory {
    mapping(bytes32 => address) public pools;

    function setPool(address a, address b, uint24 fee, address pool) external {
        pools[keccak256(abi.encode(a, b, fee))] = pool;
        pools[keccak256(abi.encode(b, a, fee))] = pool;
    }

    function getPool(address a, address b, uint24 fee) external view returns (address) {
        return pools[keccak256(abi.encode(a, b, fee))];
    }
}

contract UniswapV3TwapReferenceTest is Test {
    uint32 internal constant WINDOW = 1800;
    address internal constant STOCK_LOW = address(0x1000); // sorts before USDG
    address internal constant STOCK_HIGH = address(0x9000); // sorts after USDG
    address internal constant USDG = address(0x5000);

    MockTwapFactory internal factory;
    UniswapV3TwapReference internal ref;

    function setUp() public {
        factory = new MockTwapFactory();
        ref = new UniswapV3TwapReference(IUniswapV3FactoryLike(address(factory)), USDG, WINDOW);
    }

    function _assertClose(uint256 actual, uint256 expected) internal pure {
        // One part in 1e12.
        assertApproxEqRel(actual, expected, 1e6);
    }

    function testPriceAtTickMatchesHighPrecisionValues() public view {
        assertEq(ref.priceX128AtTick(0), 1 << 128);
        _assertClose(ref.priceX128AtTick(1), 340316395157630557309720944892511388277);
        _assertClose(ref.priceX128AtTick(-1), 340248342086729790484326174814286782777);
        _assertClose(ref.priceX128AtTick(100), 343702089724658134425462205873642501801);
        _assertClose(ref.priceX128AtTick(-100), 336896669234911992640369586824150439382);
        _assertClose(ref.priceX128AtTick(230_270), 3402816172152106897752883789203779004780791714000);
        _assertClose(ref.priceX128AtTick(-230_270), 34028311662831798279336896755);
        _assertClose(ref.priceX128AtTick(276_324), 340281467274263344194458752290081064433641032252902);
        _assertClose(ref.priceX128AtTick(-276_324), 340283266569992096456638595);
        _assertClose(ref.priceX128AtTick(500_000), 1759859011403883232411658396185743491736454138057830842837113);
        _assertClose(ref.priceX128AtTick(-500_000), 65796230542892166);
    }

    function testFuzzPriceIsMonotonicInTick(int24 tick) public view {
        tick = int24(bound(tick, -600_000, 600_000));
        assertGe(ref.priceX128AtTick(tick + 1), ref.priceX128AtTick(tick));
    }

    function testStockAsToken0() public {
        // $100 per 1e18 stock = 1e8 USDG wei per 1e18 stock wei = 1e-10 raw = tick ~ -230270.
        MockTwapPool pool = new MockTwapPool(STOCK_LOW);
        factory.setPool(STOCK_LOW, USDG, 3000, address(pool));
        pool.set(int56(-230_270) * int56(uint56(WINDOW)), false);
        assertApproxEqRel(ref.referencePrice(STOCK_LOW, 3000), 100e18, 1e14); // within one tick
    }

    function testStockAsToken1() public {
        // token0 = USDG: raw price = stock wei per USDG wei = 1e10 at $100, tick ~ +230270.
        MockTwapPool pool = new MockTwapPool(USDG);
        factory.setPool(STOCK_HIGH, USDG, 3000, address(pool));
        pool.set(int56(230_270) * int56(uint56(WINDOW)), false);
        assertApproxEqRel(ref.referencePrice(STOCK_HIGH, 3000), 100e18, 1e14);
    }

    function testNegativeMeanTickRoundsDown() public {
        MockTwapPool pool = new MockTwapPool(STOCK_LOW);
        factory.setPool(STOCK_LOW, USDG, 3000, address(pool));
        pool.set(int56(-230_270) * int56(uint56(WINDOW)) - 1, false);
        uint256 rounded = ref.referencePrice(STOCK_LOW, 3000);
        pool.set(int56(-230_271) * int56(uint56(WINDOW)), false);
        assertEq(rounded, ref.referencePrice(STOCK_LOW, 3000));
    }

    function testUnavailablePoolOrWindowReturnsZero() public {
        assertEq(ref.referencePrice(STOCK_LOW, 3000), 0);
        MockTwapPool pool = new MockTwapPool(STOCK_LOW);
        factory.setPool(STOCK_LOW, USDG, 3000, address(pool));
        pool.set(0, true);
        assertEq(ref.referencePrice(STOCK_LOW, 3000), 0);
    }

    function testConstructorRejectsZeroInputs() public {
        vm.expectRevert(UniswapV3TwapReference.InvalidParams.selector);
        new UniswapV3TwapReference(IUniswapV3FactoryLike(address(0)), USDG, WINDOW);
        vm.expectRevert(UniswapV3TwapReference.InvalidParams.selector);
        new UniswapV3TwapReference(IUniswapV3FactoryLike(address(factory)), address(0), WINDOW);
        vm.expectRevert(UniswapV3TwapReference.InvalidParams.selector);
        new UniswapV3TwapReference(IUniswapV3FactoryLike(address(factory)), USDG, 0);
    }

    // Silence unused-import lint for the pool interface used only by the reference.
    function _unused(IUniswapV3PoolLike) internal pure {}
}
