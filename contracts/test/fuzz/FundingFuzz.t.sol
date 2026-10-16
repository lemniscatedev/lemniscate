// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Funding} from "../../src/libs/Funding.sol";
import {SeriesRegistry} from "../../src/SeriesRegistry.sol";
import {ISeriesRegistry} from "../../src/interfaces/ISeriesRegistry.sol";
import {IPriceGuard} from "../../src/interfaces/IPriceGuard.sol";
import {MockLastGoodPrice} from "../mocks/MockLastGoodPrice.sol";
import {MockFundingEngine} from "../mocks/MockFundingEngine.sol";

contract FundingFuzzTest is Test {
    uint256 internal constant WAD = 1e18;

    /// R5: the norm never rises, never goes below MIN_NORM (from a norm at or above it), and nothing overflows for any
    /// gap up to 3650 days and any mark up to 1e30.
    function testFuzz_R5_normMonotoneAndFloored(
        uint256 norm,
        uint256 v,
        uint256 payoff,
        uint256 dt,
        bool weekly
    ) public pure {
        norm = bound(norm, Funding.MIN_NORM, WAD);
        v = bound(v, 0, 1e30);
        payoff = bound(payoff, 0, 1e30);
        dt = bound(dt, 0, 3650 days);
        uint256 tau = weekly ? 604_800 : 86_400;
        uint256 n = Funding.step(norm, v, payoff, dt, tau);
        assertLe(n, norm, "never rises");
        assertGe(n, Funding.MIN_NORM, "floored");
        // Monotone in time: a longer gap never leaves a larger norm.
        uint256 n2 = Funding.step(norm, v, payoff, dt + 1 hours, tau);
        assertLe(n2, n, "monotone in dt");
        // And a repeated step keeps falling or stays.
        assertLe(Funding.step(n, v, payoff, dt, tau), n);
    }

    /// R5 (extremes): the largest inputs do not overflow.
    function testFuzz_R5_noOverflowAtExtremes(uint256 v, uint256 payoff, uint256 dt) public pure {
        v = bound(v, 0, type(uint128).max);
        payoff = bound(payoff, 0, type(uint128).max);
        dt = bound(dt, 0, 3650 days);
        uint256 n = Funding.step(type(uint128).max, v, payoff, dt, 86_400);
        assertLe(n, type(uint128).max);
    }
}

/// @dev R8 handler: two holders, an engine that accrues at a settable mark, and the pool's short of the same supply.
contract ConservationHandler is Test {
    MockFundingEngine public immutable engine;
    ISeriesRegistry public immutable registry;
    bytes32 public immutable id;
    IERC20 public immutable token;
    address public immutable a = makeAddr("holderA");
    address public immutable b = makeAddr("holderB");

    /// Funding the pool has received so far: the sum of liability drops across accruals, valued at the mark of each step.
    uint256 public poolGain;
    /// holders' value + poolGain should equal this (moves only on mint, burn and re-marking).
    uint256 public baseline;
    uint256 public ops;
    uint256 public maxStepDrift;

    constructor(MockFundingEngine engine_, ISeriesRegistry registry_, bytes32 id_, IERC20 token_) {
        engine = engine_;
        registry = registry_;
        id = id_;
        token = token_;
    }

    function _norm() internal view returns (uint256) {
        return registry.seriesOf(id).norm;
    }

    /// Value of `bal` tokens at the current norm and mark, WAD USDG, rounded down.
    function _value(uint256 bal) internal view returns (uint256) {
        return Math.mulDiv(bal, _norm() * engine.vWad(), 1e36);
    }

    function holdersValue() public view returns (uint256) {
        return _value(token.balanceOf(a)) + _value(token.balanceOf(b));
    }

    function poolLiability() public view returns (uint256) {
        return _value(token.totalSupply());
    }

    function _holder(bool first) internal view returns (address) {
        return first ? a : b;
    }

    function mint(bool toA, uint256 amount) external {
        amount = bound(amount, 1, 1e24);
        address to = _holder(toA);
        engine.accrue(id); // settle funding at the old supply first, as the real engine does before minting
        _settleAccrual();
        engine.mint(id, to, amount);
        baseline += _value(amount);
        ++ops;
    }

    function burn(bool fromA, uint256 amount) external {
        address from = _holder(fromA);
        uint256 bal = token.balanceOf(from);
        if (bal == 0) return;
        amount = bound(amount, 1, bal);
        engine.accrue(id);
        _settleAccrual();
        engine.burn(id, from, amount);
        baseline -= _value(amount);
        ++ops;
    }

    function transfer(bool fromA, uint256 amount, bool viaTransferFrom) external {
        address from = _holder(fromA);
        address to = _holder(!fromA);
        uint256 bal = token.balanceOf(from);
        amount = bound(amount, 0, bal);
        // The token's hook accrues first; book that accrual before the balances move.
        engine.accrue(id);
        _settleAccrual();
        if (viaTransferFrom) {
            vm.prank(from);
            token.approve(to, amount);
            vm.prank(to);
            token.transferFrom(from, to, amount);
        } else {
            vm.prank(from);
            token.transfer(to, amount);
        }
        ++ops;
    }

    function warpAndAccrue(uint256 dt) external {
        dt = bound(dt, 1, 30 days);
        vm.warp(block.timestamp + dt);
        uint256 hvBefore = holdersValue();
        uint256 liabBefore = poolLiability();
        engine.accrue(id);
        uint256 hvAfter = holdersValue();
        uint256 liabAfter = poolLiability();
        poolGain += liabBefore - liabAfter;
        // What the holders lost equals what the pool's liability dropped, up to the floor rounding of two balances.
        uint256 dh = hvBefore - hvAfter;
        uint256 dl = liabBefore - liabAfter;
        uint256 drift = dh > dl ? dh - dl : dl - dh;
        if (drift > maxStepDrift) maxStepDrift = drift;
        ++ops;
    }

    function setMark(uint256 v, uint256 payoffBps) external {
        // Settle at the old mark first, then re-base at the new one (value changes with the mark on both sides equally).
        engine.accrue(id);
        _settleAccrual();
        v = bound(v, 1e15, 1000e18);
        payoffBps = bound(payoffBps, 0, 12_000);
        engine.setMark(v, v * payoffBps / 10_000);
        baseline = holdersValue() + poolGain;
        ++ops;
    }

    /// @dev accrue() was just called at the current timestamp; any accrual since the last booked one happened in the
    /// same block (dt 0), so there is nothing new to book. Kept as a hook to make the bookkeeping explicit.
    function _settleAccrual() internal view {
        assert(registry.seriesOf(id).lastAccrual == block.timestamp);
    }
}

/// R8: value conservation between holders and the pool across random transfers, mints, burns, re-marks and accruals.
contract FundingConservationInvariant is Test {
    ConservationHandler internal handler;
    SeriesRegistry internal registry;

    function setUp() public {
        vm.warp(1_800_000_000);
        address nvda = makeAddr("nvda");
        MockLastGoodPrice guard = new MockLastGoodPrice();
        guard.setLast(nvda, 100e18);
        registry = new SeriesRegistry(address(this), IPriceGuard(address(guard)));
        MockFundingEngine engine = new MockFundingEngine(ISeriesRegistry(address(registry)));
        registry.setEngine(address(engine));
        registry.grantRole(registry.KEEPER_ROLE(), address(this));
        registry.setStock(nvda, true, 0, "NVDA");
        bytes32 id = registry.listSeries(nvda, true, 110e18, 604_800);
        engine.setMark(3e18, 1e18);
        handler = new ConservationHandler(engine, ISeriesRegistry(address(registry)), id, IERC20(registry.seriesOf(id).token));
        targetContract(address(handler));
    }

    /// Holders' value + funding the pool has received stays equal to the baseline within 2 wei per operation.
    function invariant_R8_valueConservationAcrossTransfer() public view {
        uint256 lhs = handler.holdersValue() + handler.poolGain();
        uint256 rhs = handler.baseline();
        uint256 diff = lhs > rhs ? lhs - rhs : rhs - lhs;
        assertLe(diff, 2 * handler.ops() + 2, "value conserved within 2 wei per op");
    }

    /// The pool's liability is always the holders' value (sum of two floors vs one floor: under 2 wei).
    function invariant_R8_liabilityEqualsHolderValue() public view {
        uint256 hv = handler.holdersValue();
        uint256 l = handler.poolLiability();
        assertLe(hv, l);
        assertLe(l - hv, 2);
        assertLe(handler.maxStepDrift(), 2, "each accrual moves the same value from holders to the pool");
    }
}
