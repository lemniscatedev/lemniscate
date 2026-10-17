// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {LmnsStaking} from "../../src/LmnsStaking.sol";
import {MockUSDG} from "../mocks/MockUSDG.sol";
import {MockLmns} from "../mocks/MockLmns.sol";
import {MockPriceReference} from "../mocks/MockPriceReference.sol";
import {LmnsBase} from "./LmnsStaking.t.sol";

/// @dev Random stake / request / cancel / complete / claim / fee inflow / pool slash / LMNS donation / time.
contract LmnsHandler is Test {
    LmnsStaking internal s;
    MockLmns internal lmns;
    MockUSDG internal usdg;
    MockPriceReference internal twap;
    address internal pool;
    address[3] internal actors;

    uint256 public donated;
    uint256 public inflow;
    uint256 public claimed;
    bool public panicked;

    constructor(LmnsStaking s_, MockLmns lmns_, MockUSDG usdg_, MockPriceReference twap_, address pool_) {
        (s, lmns, usdg, twap, pool) = (s_, lmns_, usdg_, twap_, pool_);
        actors = [makeAddr("a0"), makeAddr("a1"), makeAddr("a2")];
    }

    function actorAt(uint256 i) external view returns (address) {
        return actors[i];
    }

    function stake(uint256 who, uint256 amount) external {
        address a = actors[who % 3];
        amount = bound(amount, 1, 1e24);
        lmns.mint(a, amount);
        vm.startPrank(a);
        lmns.approve(address(s), amount);
        try s.stake(amount) {} catch (bytes memory e) {
            _check(e);
        }
        vm.stopPrank();
    }

    function requestUnstake(uint256 who, uint256 frac) external {
        address a = actors[who % 3];
        uint256 sh = s.sharesOf(a) * bound(frac, 0, 100) / 100;
        vm.prank(a);
        try s.requestUnstake(sh) {} catch (bytes memory e) {
            _check(e);
        }
    }

    function cancel(uint256 who) external {
        vm.prank(actors[who % 3]);
        try s.cancelUnstake() {} catch (bytes memory e) {
            _check(e);
        }
    }

    function complete(uint256 who) external {
        vm.prank(actors[who % 3]);
        try s.completeUnstake() {} catch (bytes memory e) {
            _check(e);
        }
    }

    function claim(uint256 who) external {
        vm.prank(actors[who % 3]);
        try s.claimRewards() returns (uint256 p) {
            claimed += p;
        } catch (bytes memory e) {
            _check(e);
        }
    }

    function feeInflow(uint256 amount) external {
        amount = bound(amount, 0, 1e12);
        usdg.mint(address(s), amount);
        inflow += amount;
        try s.syncRewards() {} catch (bytes memory e) {
            _check(e);
        }
    }

    function slash(uint256 usdgNeeded, uint256 price) external {
        twap.setPrice(bound(price, 0, 10e18));
        vm.prank(pool);
        try s.slash(bound(usdgNeeded, 0, 1e13)) {} catch (bytes memory e) {
            _check(e);
        }
    }

    function donate(uint256 amount) external {
        amount = bound(amount, 0, 1e21);
        lmns.mint(address(s), amount);
        donated += amount;
    }

    function warp(uint256 dt) external {
        skip(bound(dt, 0, 20 days));
    }

    function _check(bytes memory e) private {
        if (e.length >= 4 && bytes4(e) == bytes4(0x4e487b71)) panicked = true;
    }
}

/// @notice Todo 20 R7: staked balances equal contract holdings, rewards stay covered, no panics.
contract LmnsInvariantTest is LmnsBase {
    LmnsHandler internal h;

    function setUp() public override {
        super.setUp();
        _route(staking);
        // The router must hold LMNS-for-USDG liquidity for slashes; the TWAP is moved by the handler, the executed
        // price stays at $2, so slashes succeed while the TWAP <= ~$2.06 and fail (return 0) above.
        h = new LmnsHandler(staking, lmns, usdg, twap, poolAddr);
        targetContract(address(h));
    }

    function invariant_R7_stakedEqualsHoldings() public view {
        assertEq(lmns.balanceOf(address(staking)), staking.totalAssets() + h.donated());
        uint256 shares;
        uint256 active;
        for (uint256 i; i < 3; ++i) {
            address a = h.actorAt(i);
            (uint256 q,) = staking.requests(a);
            shares += staking.sharesOf(a) + q;
            active += staking.sharesOf(a);
        }
        assertEq(shares, staking.totalShares());
        assertEq(active, staking.activeShares());
        // Every share's claim is backed: the sum of all stakes never exceeds the LMNS held.
        assertLe(staking.assetsOf(staking.totalShares()), staking.totalAssets());
        // Share counts stay bounded after any sequence of slashes (the slash floor keeps the share price above zero).
        assertLt(staking.totalShares(), 2 ** 200);
    }

    function invariant_R7_rewardsCovered() public view {
        uint256 owedSum;
        for (uint256 i; i < 3; ++i) {
            owedSum += staking.earned(h.actorAt(i));
        }
        assertLe(owedSum, usdg.balanceOf(address(staking)));
        assertLe(staking.committed(), usdg.balanceOf(address(staking)));
        assertLe(h.claimed() + owedSum, h.inflow());
    }

    function invariant_R7_noPanics() public view {
        assertFalse(h.panicked());
    }
}
