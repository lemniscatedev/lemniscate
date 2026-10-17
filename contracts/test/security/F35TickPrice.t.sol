// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {PriceGuard} from "../../src/PriceGuard.sol";
import {IPriceGuard} from "../../src/interfaces/IPriceGuard.sol";
import {PriceReading, SessionKind} from "../../src/libs/OptionTypes.sol";
import {TickPrice} from "../../src/libs/TickPrice.sol";
import {MockGuardFeed, MockKindHours} from "../mocks/PriceGuardMocks.sol";
import {MockDecimalsToken, MockRawObservePool, MockStock18} from "../mocks/TwapMocks.sol";

/// @dev External wrapper so a revert inside the internal library is observable.
contract TickPriceProbe {
    function priceX128(int24 tick) external pure returns (uint256) {
        return TickPrice.priceX128(tick);
    }
}

/// @notice Review finding F35 (LOW): TickPrice.priceX128 overflowed for ticks 880341..887272 (the Q128 ratio floors to
/// 1 and 2^256 / 1 overflows), so PriceGuard's "never reverts" TWAP read reverted read/poke/twapCheck instead of
/// reporting TWAP_UNAVAILABLE.
contract F35TickPriceTest is Test {
    uint256 internal constant T0 = 1_790_000_000;

    address internal admin = makeAddr("admin");
    PriceGuard internal guard;
    MockKindHours internal hours_;
    MockStock18 internal stock;
    MockGuardFeed internal feed;
    MockDecimalsToken internal usdg;
    MockRawObservePool internal raw;
    TickPriceProbe internal probe;

    function setUp() public {
        vm.warp(T0);
        hours_ = new MockKindHours();
        stock = new MockStock18();
        feed = new MockGuardFeed(8, 100e8);
        usdg = new MockDecimalsToken(6);
        guard = new PriceGuard(admin, address(hours_), 24 hours, 1 hours);
        raw = new MockRawObservePool(address(stock), address(usdg));
        probe = new TickPriceProbe();
        vm.startPrank(admin);
        guard.setStock(
            address(stock),
            IPriceGuard.StockConfig({
                feed: address(feed),
                multiplierEmbedded: true,
                maxAgeRegular: 26 hours,
                maxAgeExtended: 26 hours,
                continuityBps: 1500,
                enabled: true
            })
        );
        guard.setTwapSource(address(stock), address(raw), 0, 0);
        vm.stopPrank();
    }

    function test_F35_priceX128NeverRevertsAtExtremeTicks() public view {
        int24[5] memory ticks = [int24(880_340), 880_341, 884_000, 887_271, 887_272];
        for (uint256 i; i < ticks.length; ++i) {
            probe.priceX128(ticks[i]); // must not revert
            probe.priceX128(-ticks[i]);
        }
        assertEq(probe.priceX128(0), TickPrice.Q128);
    }

    function test_F35_extremeMeanTickReadsTwapUnavailable() public {
        int24[3] memory ticks = [int24(880_341), 884_000, 887_272];
        for (uint256 i; i < ticks.length; ++i) {
            raw.setCumulatives(0, int56(1800) * int56(ticks[i]));
            PriceReading memory r = guard.read(address(stock)); // must not revert
            assertEq(uint8(r.session), uint8(SessionKind.REGULAR));
            assertEq(r.s, 100e18, "S still comes from the feed");
            assertTrue(r.buysPaused);
            assertEq(guard.buysPausedReason(address(stock)), guard.REASON_TWAP_UNAVAILABLE());
            guard.poke(address(stock)); // the keeper's poke keeps working
            (uint256 twap, bool ok) = guard.twapCheck(address(stock));
            assertEq(twap, 0);
            assertFalse(ok);
        }
    }
}
