// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {MockSwitchingStock} from "./PriceGuardMocks.sol";

/// @notice The multiplier-switching stock with ERC20 decimals (18, as every Stock Token), for TWAP pool setup.
contract MockStock18 is MockSwitchingStock {
    uint8 public constant decimals = 18;
}

/// @notice ERC20 decimals surface only (the quote token of a TWAP pool).
contract MockDecimalsToken {
    uint8 public decimals;

    constructor(uint8 decimals_) {
        decimals = decimals_;
    }
}

/// @notice Uniswap v3 style oracle: one observation per block, written by the first "swap" of the block with the tick
/// in force before it (so a price set and reverted inside one block never enters the TWAP), a fixed cardinality, and
/// `observe` reverting "OLD" for a target older than the oldest kept observation.
contract MockObservingPool {
    struct Obs {
        uint32 ts;
        int56 cum;
    }

    address public token0;
    address public token1;
    int24 public tick;
    uint16 public cardinality;
    bool public shouldRevert;
    Obs[] private _obs;

    /// @param seedAgo the first observation is written this many seconds before now (history to read from)
    constructor(address token0_, address token1_, int24 tick_, uint16 cardinality_, uint32 seedAgo) {
        token0 = token0_;
        token1 = token1_;
        tick = tick_;
        cardinality = cardinality_;
        _obs.push(Obs({ts: uint32(block.timestamp - seedAgo), cum: 0}));
    }

    function setRevert(bool v) external {
        shouldRevert = v;
    }

    function setCardinality(uint16 c) external {
        cardinality = c;
    }

    /// @notice Moves the price to `newTick`, writing this block's observation first (Uniswap's write-then-swap order).
    function swapTo(int24 newTick) external {
        Obs memory last = _obs[_obs.length - 1];
        if (last.ts != uint32(block.timestamp)) {
            _obs.push(
                Obs({
                    ts: uint32(block.timestamp),
                    cum: last.cum + int56(tick) * int56(uint56(uint32(block.timestamp) - last.ts))
                })
            );
        }
        tick = newTick;
    }

    function observe(uint32[] calldata secondsAgos)
        external
        view
        returns (int56[] memory tickCumulatives, uint160[] memory secondsPerLiquidityCumulativeX128s)
    {
        require(!shouldRevert, "pool down");
        tickCumulatives = new int56[](secondsAgos.length);
        secondsPerLiquidityCumulativeX128s = new uint160[](secondsAgos.length);
        for (uint256 i; i < secondsAgos.length; ++i) {
            tickCumulatives[i] = _cumAt(uint32(block.timestamp) - secondsAgos[i]);
        }
    }

    function _cumAt(uint32 target) private view returns (int56) {
        uint256 n = _obs.length;
        Obs memory last = _obs[n - 1];
        if (target >= last.ts) return last.cum + int56(tick) * int56(uint56(target - last.ts));
        uint256 kept = n < cardinality ? n : cardinality;
        uint256 oldest = n - kept;
        require(target >= _obs[oldest].ts, "OLD");
        for (uint256 j = n - 1; j > oldest; --j) {
            Obs memory a = _obs[j - 1];
            if (target >= a.ts) {
                Obs memory b = _obs[j];
                int56 slope = (b.cum - a.cum) / int56(uint56(b.ts - a.ts)); // constant tick between observations
                return a.cum + slope * int56(uint56(target - a.ts));
            }
        }
        return _obs[oldest].cum;
    }
}

/// @notice Pool whose observe() answer is raw bytes chosen by the test (real-shaped mainnet values, or garbage).
contract MockRawObservePool {
    address public token0;
    address public token1;
    bytes private _raw;

    constructor(address token0_, address token1_) {
        token0 = token0_;
        token1 = token1_;
    }

    function setCumulatives(int56 c0, int56 c1) external {
        int56[] memory t = new int56[](2);
        t[0] = c0;
        t[1] = c1;
        _raw = abi.encode(t, new uint160[](2));
    }

    function setRaw(bytes calldata raw) external {
        _raw = raw;
    }

    fallback() external {
        bytes memory r = _raw;
        assembly {
            return(add(r, 32), mload(r))
        }
    }
}

/// @notice Storage-free pool: fixed cumulatives from immutables, so a gas measurement sees only the caller's cost.
contract MockConstPool {
    address public immutable token0;
    address public immutable token1;
    int56 private immutable _c0;
    int56 private immutable _c1;

    constructor(address token0_, address token1_, int56 c0, int56 c1) {
        token0 = token0_;
        token1 = token1_;
        _c0 = c0;
        _c1 = c1;
    }

    function observe(uint32[] calldata) external view returns (int56[] memory t, uint160[] memory l) {
        t = new int56[](2);
        t[0] = _c0;
        t[1] = _c1;
        l = new uint160[](2);
    }
}
