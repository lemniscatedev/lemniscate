// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {AgentRouter} from "../../src/AgentRouter.sol";
import {EngineBase} from "../engine/EngineBase.sol";

/// @notice Round-2 review R03 (MEDIUM): 1 wei of an option token donated to AgentRouter turned every agent sellFor of
/// that series into a partial sell of the router's balance whose dust remainder reverted BelowMinimum, forever; the
/// same dust sent to a holder just before their whole-balance sell reverted it. The engine now sizes agent sells on the
/// owner (R04) and sweeps a sub-minimum remainder into the sale instead of reverting.
contract R03DustDonationTest is EngineBase {
    AgentRouter internal router;
    address internal agent = makeAddr("agent");
    address internal mallory = makeAddr("mallory");
    bytes32 internal callN;

    function setUp() public override {
        super.setUp();
        router = new AgentRouter(address(engine));
        vm.prank(admin);
        engine.setAgentRouter(address(router));
        callN = _list(address(nvda), true, 100e18, WEEKLY);
        _fund(mallory);
        address[] memory s = new address[](1);
        s[0] = address(nvda);
        vm.startPrank(alice);
        usdg.approve(address(router), type(uint256).max);
        router.setPolicy(agent, type(uint128).max, type(uint128).max, uint64(T0 + 365 days), true, true, s);
        vm.stopPrank();
    }

    function _donate(address to, uint256 amount) internal {
        (, uint256 t) = _buy(mallory, callN, 5e18);
        skip(31 minutes); // mallory's own tokens are free once her hold ends
        IERC20 tk = _token(callN);
        vm.prank(mallory);
        tk.transfer(to, amount > t ? t : amount);
    }

    /// @dev Reviewer PoC: alice's agent buys 10 units; mallory sends 1 wei to the router; 31 min later the agent's
    /// sellFor(alice, aliceBalance) reverted BelowMinimum. It now sells and pays alice.
    function test_R03_routerDustDoesNotBlockSellFor() public {
        vm.prank(agent);
        router.buyFor(alice, callN, 10e18, type(uint128).max, uint64(vm.getBlockTimestamp()));
        _donate(address(router), 1);
        uint256 bal = _token(callN).balanceOf(alice);
        vm.prank(agent);
        uint256 proceeds = router.sellFor(alice, callN, uint128(bal), 0, uint64(vm.getBlockTimestamp()));
        assertGt(proceeds, 0);
        assertEq(_token(callN).balanceOf(alice), 0);
    }

    /// @dev Variant: 1 wei sent to the seller just before a whole-balance sell (mempool race) no longer reverts it; the
    /// dust is sold with the balance.
    function test_R03_dustSentToSellerIsSweptIntoTheSale() public {
        (, uint256 tokens) = _buy(bob, callN, 10e18);
        _donate(bob, 1);
        _sell(bob, callN, tokens);
        assertEq(_token(callN).balanceOf(bob), 0, "remainder swept");
    }

    /// @dev PROPERTY: after any donation (any amount below the minimum's worth) to the seller or to the router, selling
    /// the balance held before the donation never reverts BelowMinimum, and the router's sell pays what the owner
    /// selling directly gets.
    function testFuzz_R03_wholeBalanceSellSurvivesDonations(uint256 toSeller, uint256 toRouter, uint8 who) public {
        vm.prank(agent);
        router.buyFor(alice, callN, 20e18, type(uint128).max, uint64(vm.getBlockTimestamp()));
        uint256 bal = _token(callN).balanceOf(alice);
        toSeller = bound(toSeller, 0, 1e17); // worth well under $1
        toRouter = bound(toRouter, 0, 5e18);
        if (toRouter != 0) _donate(address(router), toRouter);
        if (toSeller != 0) _donate(alice, toSeller);
        skip(31 minutes);
        uint256 snap = vm.snapshotState();
        uint256 direct = _sell(alice, callN, bal);
        vm.revertToState(snap);
        uint256 got;
        if (who % 2 == 0) {
            vm.prank(agent);
            got = router.sellFor(alice, callN, uint128(bal), 0, uint64(vm.getBlockTimestamp()));
        } else {
            got = _sell(alice, callN, bal);
        }
        assertEq(got, direct);
        assertEq(_token(callN).balanceOf(alice), 0);
    }
}
