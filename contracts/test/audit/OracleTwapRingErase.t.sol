// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {PriceGuard} from "../../src/PriceGuard.sol";
import {IPriceGuard} from "../../src/interfaces/IPriceGuard.sol";
import {MockGuardFeed, MockKindHours} from "../mocks/PriceGuardMocks.sol";
import {MockDecimalsToken, MockObservingPool, MockStock18} from "../mocks/TwapMocks.sol";

/// @notice Audit 2026-10-29 M-2: refilling a short Uniswap observation ring with dust swaps (one per second) made
/// `observe([window, 0])` revert "OLD", `tradeTwap` read 0 and every consumer skipped its worse-of guard, so a weekend
/// sell settled at Friday's last good price. Now the trade TWAP falls back to the longest window the ring still covers
/// (never spot), and a source that cannot serve even that reports `tradeTwapLost` so consumers fail closed.
contract OracleTwapRingEraseTest is Test {
    uint256 internal constant T0 = 1_790_000_000;
    int24 internal constant TICK_100 = -230_270; // ~$100, stock token0 vs 6-dp USDG
    int24 internal constant TICK_80 = -232_502; // ~$80

    address internal admin = makeAddr("admin");
    PriceGuard internal guard;
    MockStock18 internal stock;
    MockDecimalsToken internal usdg;
    MockObservingPool internal pool;

    function setUp() public {
        vm.warp(T0);
        MockKindHours hours_ = new MockKindHours();
        stock = new MockStock18();
        usdg = new MockDecimalsToken(6);
        MockGuardFeed feed = new MockGuardFeed(8, 100e8);
        guard = new PriceGuard(admin, address(hours_), 24 hours, 1 hours);
        pool = new MockObservingPool(address(stock), address(usdg), TICK_100, 300, 2 hours); // short ring
        vm.startPrank(admin);
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
        guard.setTwapSource(address(stock), address(pool), 0, 0);
        vm.stopPrank();
    }

    /// @dev The pool reprices to ~80, then the attacker writes 310 dust observations in separate seconds.
    function _eraseRing() internal {
        pool.swapTo(TICK_80);
        for (uint256 i; i < 310; ++i) {
            skip(1);
            pool.swapTo(TICK_80);
        }
    }

    function test_M2_ringRefillDoesNotEraseTradeTwap() public {
        _eraseRing();
        uint256 twap = guard.tradeTwap(address(stock));
        assertGt(twap, 0, "tradeTwap must not read 0 after a ring refill");
        assertApproxEqRel(twap, 80e18, 0.02e18, "the fallback window reads the pool's real price");
        assertFalse(guard.tradeTwapLost(address(stock)));
    }

    function test_M2_ringTooShortForAnyWindowFailsClosed() public {
        // A ring that covers less than MIN_TRADE_TWAP_WINDOW cannot be served: the source is reported lost.
        MockObservingPool tiny = new MockObservingPool(address(stock), address(usdg), TICK_100, 10, 5);
        vm.prank(admin);
        guard.setTwapSource(address(stock), address(tiny), 0, 0);
        for (uint256 i; i < 20; ++i) {
            skip(1);
            tiny.swapTo(TICK_80);
        }
        assertEq(guard.tradeTwap(address(stock)), 0);
        assertTrue(guard.tradeTwapLost(address(stock)), "a set but unservable source is lost");
    }

    function test_M2_noSourceIsNotLost() public {
        MockStock18 other = new MockStock18();
        assertFalse(guard.tradeTwapLost(address(other)));
    }
}
