// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @title TickPrice
/// @notice 1.0001^tick as a Q128.128 number (token1 per token0 in raw units), for TWAP maths inside view functions.
/// @dev Same constants and method as UniswapV3TwapReference.priceX128AtTick (constant i is floor(2^128 / 1.0001^(2^i)));
/// kept as an internal library so PriceGuard does not pay an external call per read.
library TickPrice {
    uint256 internal constant Q128 = 1 << 128;
    int24 internal constant MAX_TICK = 887_272;

    /// @dev Caller guarantees |tick| <= MAX_TICK. Accurate to well under one part in 1e12 for |tick| < 2^20.
    function priceX128(int24 tick) internal pure returns (uint256 ratio) {
        uint256 absTick = tick < 0 ? uint256(-int256(tick)) : uint256(int256(tick));

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

        // ratio = 1.0001^-|tick| in Q128 (at most 1.0); invert for positive ticks. For ticks 880341..887272 the ratio
        // floors to 1 and 2^256 / 1 does not fit (review F35): saturate at the largest uint256, as Uniswap's TickMath
        // inverts with type(uint256).max / ratio. Callers bound the result before scaling it.
        if (tick > 0 && ratio != 0) ratio = ratio > 1 ? Math.mulDiv(Q128, Q128, ratio) : type(uint256).max;
    }
}
