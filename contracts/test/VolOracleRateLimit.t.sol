// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {VolOracle} from "../src/VolOracle.sol";
import {IVolOracle} from "../src/interfaces/IVolOracle.sol";
import {Speed} from "../src/libs/OptionTypes.sol";

/// @notice Todo 04b R7 `volRateLimit`: one post per stock and speed per 5 minutes, and any rolling hour moves sigma by
/// at most +-50% of the value at the start of that hour, even with a compromised signer posting maximum steps.
contract VolOracleRateLimitTest is Test {
    uint256 internal constant T0 = 1_790_000_000;
    // Well-known anvil dev account 0 (public, never funded on a real network).
    uint256 internal constant SIGNER_PK = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80; // test-key

    address internal admin = makeAddr("admin");
    address internal stock = makeAddr("stock");
    VolOracle internal oracle;
    uint64 internal nonce;

    struct Point {
        uint64 at;
        uint64 sigma;
    }

    Point[] internal series; // accepted posts, oldest first

    function setUp() public {
        vm.warp(T0);
        oracle = new VolOracle(admin, vm.addr(SIGNER_PK));
    }

    // ------------------------------------------------------------------ helpers

    function _p(address stock_, Speed speed, uint64 sigma) internal returns (IVolOracle.Post memory p) {
        p = IVolOracle.Post({
            stock: stock_,
            speed: speed,
            sigmaBps: sigma,
            skewK: 0,
            eventBumpBps: 0,
            buyBlockFrom: 0,
            buyBlockTo: 0,
            validUntil: uint64(vm.getBlockTimestamp() + 1 hours),
            nonce: ++nonce
        });
    }

    function _sig(IVolOracle.Post memory p) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(SIGNER_PK, oracle.hashPost(p));
        return abi.encodePacked(r, s, v);
    }

    function _post(uint64 sigma) internal {
        IVolOracle.Post memory p = _p(stock, Speed.DAILY, sigma);
        oracle.post(p, _sig(p));
        series.push(Point(uint64(vm.getBlockTimestamp()), sigma));
    }

    function _tryPost(uint64 sigma) internal returns (bool ok) {
        IVolOracle.Post memory p = _p(stock, Speed.DAILY, sigma);
        bytes memory sig = _sig(p);
        try oracle.post(p, sig) {
            series.push(Point(uint64(vm.getBlockTimestamp()), sigma));
            ok = true;
        } catch {
            --nonce; // the nonce was not consumed
        }
    }

    function _expectRevertPost(uint64 sigma, bytes memory err) internal {
        IVolOracle.Post memory p = _p(stock, Speed.DAILY, sigma);
        bytes memory sig = _sig(p);
        vm.expectRevert(err);
        oracle.post(p, sig);
        --nonce;
    }

    /// @dev Strict rolling check over the accepted series: for every post j and every time t in [at_j - 1h, at_j],
    /// the value in force at t is within +-50% band of which post j is measured (value at the start of that hour).
    function _assertRollingBound() internal view {
        for (uint256 j = 1; j < series.length; ++j) {
            Point memory b = series[j];
            for (uint256 i; i < j; ++i) {
                Point memory a = series[i];
                bool inForceInWindow =
                    (i + 1 < series.length && series[i + 1].at > b.at - 1 hours) || a.at + 1 hours >= b.at;
                if (!inForceInWindow) continue;
                assertLe(uint256(b.sigma) * 10_000, uint256(a.sigma) * 15_000, "rolling 1h: at most +50%");
                assertGe(uint256(b.sigma) * 10_000, uint256(a.sigma) * 5_000, "rolling 1h: at most -50%");
            }
        }
    }

    // ------------------------------------------------------------------ rate limit

    function test_R7_volRateLimit_onePostPerFiveMinutes() public {
        _post(5000);
        skip(299);
        _expectRevertPost(5000, abi.encodeWithSelector(VolOracle.RateLimited.selector, uint64(T0 + 300)));
        (,, uint64 nextAt) = oracle.windowBounds(stock, Speed.DAILY);
        assertEq(nextAt, T0 + 300);
        skip(1);
        _post(5100);

        // Other speed and other stock have their own clocks.
        IVolOracle.Post memory w = _p(stock, Speed.WEEKLY, 5000);
        oracle.post(w, _sig(w));
        IVolOracle.Post memory o = _p(makeAddr("other"), Speed.DAILY, 5000);
        oracle.post(o, _sig(o));
    }

    function test_R7_volRateLimit_firstPostNotLimited() public {
        (uint64 lo, uint64 hi, uint64 nextAt) = oracle.windowBounds(stock, Speed.DAILY);
        assertEq(lo, 0);
        assertEq(hi, type(uint64).max);
        assertEq(nextAt, 0);
        _post(60_000);
    }

    // ------------------------------------------------------------------ rolling 1h bound

    function test_R7_volRateLimit_hourlyBoundUp() public {
        _post(4000);
        skip(5 minutes);
        _post(5000); // +25%: one full step
        skip(5 minutes);
        // 6250 is a legal 25% step from 5000 but +56% vs the start of the hour.
        _expectRevertPost(
            6250, abi.encodeWithSelector(VolOracle.WindowMoveTooLarge.selector, uint64(4000), uint64(6250))
        );
        (uint64 lo, uint64 hi,) = oracle.windowBounds(stock, Speed.DAILY);
        assertEq(hi, 6000);
        assertEq(lo, 2500);
        _post(6000);
    }

    function test_R7_volRateLimit_hourlyBoundDown() public {
        vm.prank(admin);
        oracle.setFloor(stock, 1000);
        _post(4000);
        skip(5 minutes);
        _post(3000);
        skip(5 minutes);
        _post(2250);
        skip(5 minutes);
        _expectRevertPost(
            1688, abi.encodeWithSelector(VolOracle.WindowMoveTooLarge.selector, uint64(4000), uint64(1688))
        );
        _post(2000); // exactly -50%
    }

    function test_R7_volRateLimit_windowRolls() public {
        _post(4000);
        skip(5 minutes);
        _post(5000);
        skip(5 minutes);
        _post(5500);
        // At exactly T0 + 1h the 4000 post is still the value in force at the window start.
        vm.warp(T0 + 60 minutes);
        _expectRevertPost(
            6001, abi.encodeWithSelector(VolOracle.WindowMoveTooLarge.selector, uint64(4000), uint64(6001))
        );
        (, uint64 hi,) = oracle.windowBounds(stock, Speed.DAILY);
        assertEq(hi, 6000);
        // 4000 stays in force at the window start until the 5000 post (T0 + 5 min) is an hour old.
        vm.warp(T0 + 65 minutes - 1);
        (, hi,) = oracle.windowBounds(stock, Speed.DAILY);
        assertEq(hi, 6000);
        vm.warp(T0 + 65 minutes);
        (, hi,) = oracle.windowBounds(stock, Speed.DAILY);
        assertEq(hi, 7500);
        _post(6001);
        _assertRollingBound();
    }

    function test_R7_volRateLimit_quietHistoryOnlyStepApplies() public {
        _post(4000);
        vm.warp(T0 + 3 hours);
        _post(5000); // only the 25% step binds after a quiet period
        skip(5 minutes);
        _post(6000);
    }

    function test_R7_volRateLimit_floorRaiseDoesNotFreeze() public {
        _post(3000);
        skip(5 minutes);
        vm.prank(admin);
        oracle.setFloor(stock, 6000);
        _post(6000); // history lifted to the floor, like the step reference
        skip(5 minutes);
        _post(7500);
    }

    // ------------------------------------------------------------------ compromised signer

    /// @dev A stolen key posts the largest value the contract accepts every 5 minutes for 3 hours. The first hour
    /// stops at exactly 1.5x; no rolling hour ever exceeds +50%.
    function test_R7_volRateLimit_compromisedSignerStopsAtHourlyBound() public {
        _post(4000);
        uint256 rejectedNaive;
        for (uint256 k; k < 36; ++k) {
            skip(5 minutes);
            uint64 prior = series[series.length - 1].sigma;
            uint64 naive = prior + prior / 4; // the 25% step limit alone would allow this
            if (_tryPost(naive)) continue;
            ++rejectedNaive;
            (, uint64 hi,) = oracle.windowBounds(stock, Speed.DAILY);
            uint64 best = hi < naive ? hi : naive;
            if (best > prior) assertTrue(_tryPost(best), "the largest allowed value is accepted");
            if (vm.getBlockTimestamp() <= T0 + 1 hours) {
                assertLe(series[series.length - 1].sigma, 6000, "first hour cap 1.5x");
            }
        }
        assertGt(rejectedNaive, 0, "the hourly bound, not the step, stopped the walk");
        uint256 hourOneMax;
        for (uint256 i; i < series.length; ++i) {
            if (series[i].at <= T0 + 1 hours && series[i].sigma > hourOneMax) hourOneMax = series[i].sigma;
        }
        assertEq(hourOneMax, 6000, "reached exactly the bound in hour one");
        // Without R7 a 25% step every 5 minutes for 3h would reach 4000 * 1.25^36 (~12 million %).
        assertLe(series[series.length - 1].sigma, 4000 * 3375 / 1000, "at most 1.5^3 after three hours");
        _assertRollingBound();
    }

    function test_R7_volRateLimit_compromisedSignerDownward() public {
        vm.prank(admin);
        oracle.setFloor(stock, 100);
        _post(8000);
        for (uint256 k; k < 12; ++k) {
            skip(5 minutes);
            uint64 prior = series[series.length - 1].sigma;
            if (_tryPost(prior - prior / 4)) continue;
            (uint64 lo,,) = oracle.windowBounds(stock, Speed.DAILY);
            if (lo < prior) _tryPost(lo);
        }
        for (uint256 i; i < series.length; ++i) {
            if (series[i].at < T0 + 1 hours) assertGe(series[i].sigma, 4000, "first hour floor 0.5x");
        }
        _assertRollingBound();
    }

    /// @dev Random walks with random spacing: whatever is accepted satisfies the strict rolling bound.
    function testFuzz_R7_volRateLimit_rollingBoundHolds(uint256 seed) public {
        vm.prank(admin);
        oracle.setFloor(stock, 500);
        _post(5000);
        for (uint256 k; k < 30; ++k) {
            seed = uint256(keccak256(abi.encode(seed, k)));
            skip(4 minutes + (seed % 20 minutes)); // sometimes inside the rate limit on purpose
            uint64 prior = series[series.length - 1].sigma;
            uint256 moveBps = (seed >> 32) % 2600; // up to +-26%
            uint64 next = (seed >> 64) % 2 == 0
                ? uint64(uint256(prior) * (10_000 + moveBps) / 10_000)
                : uint64(uint256(prior) * (10_000 - moveBps) / 10_000);
            _tryPost(next);
        }
        _assertRollingBound();
    }
}
