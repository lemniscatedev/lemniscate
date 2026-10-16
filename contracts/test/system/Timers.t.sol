// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {WriterPool} from "../../src/WriterPool.sol";
import {FeeRouter} from "../../src/FeeRouter.sol";
import {VolOracle} from "../../src/VolOracle.sol";
import {PriceGuard} from "../../src/PriceGuard.sol";
import {IFeeRouter} from "../../src/interfaces/IFeeRouter.sol";
import {IVolOracle} from "../../src/interfaces/IVolOracle.sol";
import {Speed} from "../../src/libs/OptionTypes.sol";
import {MockPausableUSDG} from "../mocks/EngineMocks.sol";

/// @notice Todo 10 R8 (shortTimersOnTestnet): every time rule is a deploy-time parameter with a hard minimum the
/// contract enforces. Full values are what the fork and mainnet profiles deploy (DeploySystem.t.sol R8 tests).
contract TimersTest is Test {
    uint256 internal constant SIGNER_PK = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80; // test-key
    address internal admin = makeAddr("admin");

    function setUp() public {
        vm.warp(1_790_000_000);
    }

    function test_R8_poolQueueDelayHardBounds() public {
        vm.expectRevert(WriterPool.InvalidParams.selector);
        this.mkPool(5 minutes - 1);
        vm.expectRevert(WriterPool.InvalidParams.selector);
        this.mkPool(30 days + 1);
        assertEq(this.mkPool(5 minutes).QUEUE_DELAY(), 5 minutes);
        assertEq(this.mkPool(72 hours).QUEUE_DELAY(), 72 hours);
    }

    function test_R8_feePeriodHardBounds() public {
        MockPausableUSDG usdg = new MockPausableUSDG();
        address pool = makeAddr("pool");
        address treasury = makeAddr("treasury");
        vm.expectRevert(IFeeRouter.InvalidParams.selector);
        this.mkFees(admin, IERC20(address(usdg)), pool, treasury, 5 minutes - 1);
        vm.expectRevert(IFeeRouter.InvalidParams.selector);
        this.mkFees(admin, IERC20(address(usdg)), pool, treasury, 30 days + 1);
        FeeRouter f = this.mkFees(admin, IERC20(address(usdg)), pool, treasury, 5 minutes);
        assertEq(f.PERIOD(), 5 minutes);
        // Distribution runs on the short period.
        usdg.mint(address(f), 1_000e6);
        vm.expectRevert();
        f.distribute();
        skip(5 minutes);
        assertEq(f.distribute(), 1_000e6);
    }

    function test_R8_volTimersHardBounds() public {
        address signer = vm.addr(SIGNER_PK);
        vm.expectRevert(VolOracle.InvalidTimer.selector);
        this.mkVol(admin, signer, 5 minutes - 1, 5 minutes);
        vm.expectRevert(VolOracle.InvalidTimer.selector);
        this.mkVol(admin, signer, 2 hours + 1, 5 minutes);
        vm.expectRevert(VolOracle.InvalidTimer.selector);
        this.mkVol(admin, signer, 2 hours, 30 seconds - 1);
        vm.expectRevert(VolOracle.InvalidTimer.selector);
        this.mkVol(admin, signer, 2 hours, 1 hours + 1);
        VolOracle full = this.mkVol(admin, signer, 2 hours, 5 minutes);
        assertEq(full.ROLLING_WINDOW(), 1 hours, "mainnet window stays one hour");

        // Testnet: 30 s rate limit, 6 min window, 10 min validity.
        VolOracle v = this.mkVol(admin, signer, 10 minutes, 30 seconds);
        assertEq(v.ROLLING_WINDOW(), 6 minutes);
        address stock = makeAddr("stock");
        _post(v, stock, 5000, 1, 10 minutes);
        (IVolOracle.Post memory p, bytes memory sig) = _signed(v, stock, 5000, 2, 10 minutes + 1);
        vm.expectRevert(IVolOracle.Expired.selector); // longer than the deployed max validity
        v.post(p, sig);
        (p, sig) = _signed(v, stock, 5000, 2, 10 minutes);
        vm.expectRevert(abi.encodeWithSelector(VolOracle.RateLimited.selector, uint64(block.timestamp + 30)));
        v.post(p, sig);
        skip(30 seconds);
        _post(v, stock, 5500, 2, 10 minutes);
    }

    function test_R8_splitWindowHardBounds() public {
        address hours_ = makeAddr("hours");
        vm.expectRevert(PriceGuard.InvalidTimer.selector);
        this.mkGuard(admin, hours_, 10 minutes - 1, 1 hours);
        vm.expectRevert(PriceGuard.InvalidTimer.selector);
        this.mkGuard(admin, hours_, 24 hours, 5 minutes - 1);
        vm.expectRevert(PriceGuard.InvalidTimer.selector);
        this.mkGuard(admin, hours_, 7 days + 1, 1 hours);
        PriceGuard g = this.mkGuard(admin, hours_, 10 minutes, 5 minutes);
        assertEq(g.SPLIT_LEAD(), 10 minutes);
        assertEq(g.SPLIT_TAIL(), 5 minutes);
    }

    function test_R8_depositLockHardMinimum() public {
        // lockSeconds is set at deploy through setParams; below one minute is refused (initialize sets 1 day).
        WriterPool impl = this.mkPool(72 hours);
        assertEq(impl.MIN_LOCK_SECONDS(), 1 minutes);
        // Behaviour on a live pool is covered by DeploySystemTest.test_R8_testnetTimersBelowHardMinimumsRefused.
    }

    // `new` through an external call so expectRevert sees the creation revert at the call boundary.
    function mkPool(uint256 q) external returns (WriterPool) {
        return new WriterPool(q);
    }

    function mkFees(address a, IERC20 u, address p, address t, uint256 period) external returns (FeeRouter) {
        return new FeeRouter(a, u, p, t, period);
    }

    function mkVol(address a, address s, uint64 validity, uint64 interval) external returns (VolOracle) {
        return new VolOracle(a, s, validity, interval);
    }

    function mkGuard(address a, address h, uint256 lead, uint256 tail) external returns (PriceGuard) {
        return new PriceGuard(a, h, lead, tail);
    }

    function _post(VolOracle v, address stock, uint64 sigma, uint64 n, uint64 validFor) internal {
        (IVolOracle.Post memory p, bytes memory sig) = _signed(v, stock, sigma, n, validFor);
        v.post(p, sig);
    }

    function _signed(VolOracle v, address stock, uint64 sigma, uint64 n, uint64 validFor)
        internal
        view
        returns (IVolOracle.Post memory p, bytes memory sig)
    {
        p = IVolOracle.Post({
            stock: stock,
            speed: Speed.DAILY,
            sigmaBps: sigma,
            skewK: 0,
            eventBumpBps: 0,
            buyBlockFrom: 0,
            buyBlockTo: 0,
            validUntil: uint64(block.timestamp) + validFor,
            nonce: n
        });
        (uint8 v_, bytes32 r, bytes32 s) = vm.sign(SIGNER_PK, v.hashPost(p));
        sig = abi.encodePacked(r, s, v_);
    }
}
