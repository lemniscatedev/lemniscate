// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IPriceReference} from "./interfaces/IPriceReference.sol";

interface IUniswapV3FactoryLike {
    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool);
}

interface IUniswapV3PoolLike {
    function token0() external view returns (address);

    function observe(uint32[] calldata secondsAgos)
        external
        view
        returns (int56[] memory tickCumulatives, uint160[] memory secondsPerLiquidityCumulativeX128s);
}

/// @title UniswapV3TwapReference
/// @notice Time-weighted average price of a stock/USDG Uniswap v3 pool over a fixed window. One transaction cannot
/// move it, so a hedge sale floored at it cannot be sandwiched for more than the vault's slippage allowance.
/// @dev Returns zero (no reference) when the pool is missing or cannot serve the window, for example while its
/// observation cardinality is still 1. Stateless; redeploy to change the window.
contract UniswapV3TwapReference is IPriceReference {
    /// @dev 18-decimal stock and 6-decimal USDG: WAD USD per whole token = raw (USDG wei per stock wei) * 1e30.
    uint256 private constant RAW_TO_WAD = 1e30;
    uint256 private constant Q128 = 1 << 128;
    int24 private constant MAX_TICK = 887_272;

    IUniswapV3FactoryLike public immutable factory;
    address public immutable usdg;
    uint32 public immutable window;

    error InvalidParams();

    constructor(IUniswapV3FactoryLike factory_, address usdg_, uint32 window_) {
        if (address(factory_) == address(0) || usdg_ == address(0) || window_ == 0) revert InvalidParams();
        factory = factory_;
        usdg = usdg_;
        window = window_;
    }

    /// @inheritdoc IPriceReference
    function referencePrice(address stock, uint24 fee) external view override returns (uint256) {
        address pool = factory.getPool(stock, usdg, fee);
        if (pool == address(0)) return 0;

        uint32[] memory secondsAgos = new uint32[](2);
        secondsAgos[0] = window;
        int56[] memory cumulatives;
        try IUniswapV3PoolLike(pool).observe(secondsAgos) returns (int56[] memory tickCumulatives, uint160[] memory) {
            cumulatives = tickCumulatives;
        } catch {
            return 0;
        }

        int56 delta = cumulatives[1] - cumulatives[0];
        int56 span = int56(uint56(window));
        int56 meanTick = delta / span;
        if (delta < 0 && delta % span != 0) --meanTick; // round toward negative infinity
        if (meanTick > MAX_TICK || meanTick < -MAX_TICK) return 0;

        // priceX128 = token1 per token0 in raw units, Q128.
        uint256 priceX128 = priceX128AtTick(int24(meanTick));
        if (priceX128 == 0) return 0;
        if (IUniswapV3PoolLike(pool).token0() == stock) return Math.mulDiv(priceX128, RAW_TO_WAD, Q128);
        return Math.mulDiv(RAW_TO_WAD, Q128, priceX128);
    }

    /// @notice 1.0001^tick as a Q128.128 number, by binary exponentiation over constant powers of 1/1.0001.
    /// @dev Constant i is floor(2^128 / 1.0001^(2^i)). Accurate to well under one part in 1e12 for |tick| < 2^20.
    function priceX128AtTick(int24 tick) public pure returns (uint256 ratio) {
        uint256 absTick = tick < 0 ? uint256(-int256(tick)) : uint256(int256(tick));
        if (absTick > uint256(int256(MAX_TICK))) revert InvalidParams();

        ratio = Q128;
        if (absTick & 0x1 != 0) ratio = (ratio * 0xfff97272373d413259a46990580e2139) >> 128;
        if (absTick & 0x2 != 0) ratio = (ratio * 0xfff2e50f5f656932ef12357cf3c7fdcb) >> 128;
        if (absTick & 0x4 != 0) ratio = (ratio * 0xffe5caca7e10e4e61c3624eaa0941ccf) >> 128;
        if (absTick & 0x8 != 0) ratio = (ratio * 0xffcb9843d60f6159c9db58835c926643) >> 128;
        if (absTick & 0x10 != 0) ratio = (ratio * 0xff973b41fa98c081472e6896dfb254bf) >> 128;
        if (absTick & 0x20 != 0) ratio = (ratio * 0xff2ea16466c96a3843ec78b326b52860) >> 128;
        if (absTick & 0x40 != 0) ratio = (ratio * 0xfe5dee046a99a2a811c461f1969c3052) >> 128;
        if (absTick & 0x80 != 0) ratio = (ratio * 0xfcbe86c7900a88aedcffc83b479aa3a3) >> 128;
        if (absTick & 0x100 != 0) ratio = (ratio * 0xf987a7253ac413176f2b074cf7815e53) >> 128;
        if (absTick & 0x200 != 0) ratio = (ratio * 0xf3392b0822b70005940c7a398e4b70f2) >> 128;
        if (absTick & 0x400 != 0) ratio = (ratio * 0xe7159475a2c29b7443b29c7fa6e889d8) >> 128;
        if (absTick & 0x800 != 0) ratio = (ratio * 0xd097f3bdfd2022b8845ad8f792aa5825) >> 128;
        if (absTick & 0x1000 != 0) ratio = (ratio * 0xa9f746462d870fdf8a65dc1f90e061e4) >> 128;
        if (absTick & 0x2000 != 0) ratio = (ratio * 0x70d869a156d2a1b890bb3df62baf32f6) >> 128;
        if (absTick & 0x4000 != 0) ratio = (ratio * 0x31be135f97d08fd981231505542fcfa5) >> 128;
        if (absTick & 0x8000 != 0) ratio = (ratio * 0x9aa508b5b7a84e1c677de54f3e99bc8) >> 128;
        if (absTick & 0x10000 != 0) ratio = (ratio * 0x5d6af8dedb81196699c329225ee604) >> 128;
        if (absTick & 0x20000 != 0) ratio = (ratio * 0x2216e584f5fa1ea926041bedfe97) >> 128;
        if (absTick & 0x40000 != 0) ratio = (ratio * 0x48a170391f7dc42444e8fa2) >> 128;
        if (absTick & 0x80000 != 0) ratio = (ratio * 0x149b34ee7ac262) >> 128;

        // ratio = 1.0001^-|tick| in Q128 (at most 1.0); invert for positive ticks.
        if (tick > 0 && ratio != 0) ratio = Math.mulDiv(Q128, Q128, ratio);
    }
}
