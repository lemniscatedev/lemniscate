// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {LmnsStaking} from "../../src/LmnsStaking.sol";
import {LmnsBuyBurn} from "../../src/LmnsBuyBurn.sol";
import {ILmnsStaking} from "../../src/interfaces/ILmnsStaking.sol";
import {IPriceReference} from "../../src/interfaces/IPriceReference.sol";
import {IHedgeAdapter} from "../../src/interfaces/IHedgeAdapter.sol";
import {MockLmns} from "../mocks/MockLmns.sol";
import {PoolFixture} from "../pool/PoolFixture.sol";

/// @dev Security review 2026-10-17, F37: buyAndBurn and the claim-triggered slash are swaps a caller can sandwich in one
/// transaction by moving the LMNS pool's spot price away from its TWAP (up to the 3% floor).
contract LmnsSandwichTest is PoolFixture {
    uint24 internal constant LMNS_FEE = 3000;
    MockLmns internal lmns;
    LmnsStaking internal staking;
    LmnsBuyBurn internal burn;
    address internal staker = makeAddr("staker");
    address internal attacker = makeAddr("attacker");

    function setUp() public {
        vm.warp(1_790_000_000);
        _deploy();
        lmns = new MockLmns();
        staking = new LmnsStaking(
            admin, IERC20(address(lmns)), IERC20(address(usdg)), address(pool), 14 days, 7 days, 1 days
        );
        burn = new LmnsBuyBurn(admin, IERC20(address(lmns)), IERC20(address(usdg)));
        twap.setPrice(1e18);
        _setLmnsExec(1e18);
        lmns.mint(address(swapRouter), 1_000_000e18);
        staking.setSlashRoute(IPriceReference(address(twap)), IHedgeAdapter(address(adapter)), LMNS_FEE, 300);
        staking.setCoverCap(1_000_000 * USDG);
        burn.setRoute(IPriceReference(address(twap)), IHedgeAdapter(address(adapter)), LMNS_FEE, 300);
        pool.setStaking(ILmnsStaking(address(staking)));
        _deposit(alice, 10_000 * USDG);
        _deposit(bob, 10_000 * USDG);
        _engineBuy(4_000 * USDG, 4_000 * USDG, 0);
        pool.checkpoint();
        lmns.mint(staker, 1_000e18);
        vm.startPrank(staker);
        lmns.approve(address(staking), 1_000e18);
        staking.stake(1_000e18);
        vm.stopPrank();
        usdg.mint(address(burn), 10_000 * USDG);
        burn.grantRole(burn.KEEPER_ROLE(), keeper);
    }

    address internal keeper = makeAddr("keeper");

    /// @dev The swap executes at `p` (WAD USDG per LMNS) both ways: the attacker's push of the spot price.
    function _setLmnsExec(uint256 p) internal {
        swapRouter.setRate(address(lmns), address(usdg), LMNS_FEE, p / 1e12);
        swapRouter.setRate(address(usdg), address(lmns), LMNS_FEE, 1e48 / p);
    }

    /// Spot pushed 2.9% above the TWAP: a buy at that price must not happen (no burn bucket sold at the top).
    function test_F37_buyAndBurnNotSandwichable() public {
        _setLmnsExec(1.029e18);
        _pushSpot(1.029e18);
        uint256 burned;
        vm.prank(attacker);
        try burn.buyAndBurn(type(uint256).max) returns (uint256 b) {
            burned = b;
        } catch {}
        assertEq(burned, 0, "burn bucket bought at a pushed price");
        assertEq(usdg.balanceOf(address(burn)), 10_000 * USDG);
    }

    /// Spot pushed 2.9% below the TWAP, then a stranger triggers a slash through claim(): stakers' LMNS must not be
    /// sold at that price.
    function test_F37_slashNotSandwichable() public {
        vm.warp(vm.getBlockTimestamp() + 1 days + 1);
        uint256 ticket = _request(bob, pool.balanceOf(bob));
        vm.warp(vm.getBlockTimestamp() + 72 hours);
        engine.setLiability(1_500e18);
        _setLmnsExec(0.971e18);
        _pushSpot(0.971e18);
        uint256 lmnsBefore = staking.totalAssets() + _locked();
        vm.prank(attacker);
        try pool.claim(ticket) {} catch {}
        assertEq(staking.totalAssets() + _locked(), lmnsBefore, "stake sold at a pushed price");
    }

    function _pushSpot(uint256 p) internal virtual {
        (bool ok,) = address(twap).call(abi.encodeWithSignature("setSpot(uint256)", p));
        ok;
    }

    function _locked() internal view returns (uint256) {
        return staking.lockedForPool();
    }

    /// Even the keeper's call is skipped while spot is off the TWAP, and a normal call spends at most the per-call cap.
    function test_F37_keeperBuyBandAndCap() public {
        _setLmnsExec(1.029e18);
        _pushSpot(1.029e18);
        vm.prank(keeper);
        assertEq(burn.buyAndBurn(type(uint256).max), 0);
        _setLmnsExec(1e18);
        _pushSpot(1.004e18); // inside the 50 bps band
        vm.prank(keeper);
        assertGt(burn.buyAndBurn(type(uint256).max), 0);
        assertEq(usdg.balanceOf(address(burn)), 9_000 * USDG); // capped at 1,000 per call
        vm.expectRevert();
        burn.setMaxUsdgPerCall(0);
        vm.prank(attacker);
        vm.expectRevert();
        burn.setMaxUsdgPerCall(1e30);
    }

    /// The owner's own claim during a pushed spot is charged for the skipped slash rather than selling stakers cheap;
    /// once spot is back, the slash runs at the TWAP floor.
    function test_F37_slashResumesWhenSpotReturns() public {
        vm.warp(vm.getBlockTimestamp() + 1 days + 1);
        uint256 ticket = _request(bob, pool.balanceOf(bob));
        vm.warp(vm.getBlockTimestamp() + 72 hours);
        engine.setLiability(1_500e18);
        _pushSpot(1e18);
        uint256 lmnsBefore = staking.totalAssets() + _locked();
        vm.prank(bob);
        pool.claim(ticket);
        assertLt(staking.totalAssets() + _locked(), lmnsBefore, "slash ran at a normal spot");
    }
}
