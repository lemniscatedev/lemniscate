// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {TimelockHandoff} from "../../script/TimelockHandoff.s.sol";

contract TimelockHandoffHarness is TimelockHandoff {
    function inputs(Config memory c, address safe, address eoa, address reuse, bool revoke) external view {
        checkHandoffInputs(c, safe, eoa, reuse, revoke);
    }

    function verify(TimelockController tl, address safe, address eoa, uint256 minDelay) external view {
        _verifyTimelock(tl, safe, eoa, minDelay);
    }
}

/// @notice Skeptic L2 on the EOA owner model: the separate-step handoff applies the deploy's owner rule, refuses a bot
/// key or the guardian as owner, refuses a pre-existing timelock on mainnet, and refuses a timelock in which the sender
/// keeps any proposer, executor or canceller role.
contract TimelockHandoffTest is Test {
    TimelockHandoffHarness internal h;
    TimelockHandoff.Config internal c;
    address internal owner = makeAddr("owner-eoa");
    address internal sender = makeAddr("deployer");

    function setUp() public {
        h = new TimelockHandoffHarness();
        c.profileName = "mainnet";
        c.profile = 2; // PROFILE_MAINNET
        c.allowEoaOwner = true;
        c.roles.keeper = makeAddr("keeper");
        c.roles.hedger = makeAddr("hedger");
        c.roles.volSigner = makeAddr("volSigner");
        c.roles.guardian = makeAddr("guardian");
        vm.chainId(4663);
    }

    function test_L2_mainnetEoaOwnerPassesInOneRun() public view {
        h.inputs(c, owner, sender, address(0), true);
    }

    function test_L2_ownerRuleFromTheConfig() public {
        TimelockHandoff.Config memory m = c;
        m.allowEoaOwner = false;
        vm.expectRevert(
            bytes("TimelockHandoff: SAFE refused: OWNER_IS_EOA (deploy the owner Safe first, or ALLOW_EOA_OWNER=1)")
        );
        h.inputs(m, owner, sender, address(0), true);
        vm.etch(owner, abi.encodePacked(hex"ef0100", makeAddr("sweeper")));
        vm.expectRevert(bytes("TimelockHandoff: SAFE refused: OWNER_IS_DELEGATED_EOA"));
        h.inputs(c, owner, sender, address(0), true);
    }

    function test_L2_ownerIsNotABotTheGuardianOrTheSender() public {
        address[4] memory refused = [c.roles.keeper, c.roles.hedger, c.roles.volSigner, c.roles.guardian];
        for (uint256 i; i < refused.length; ++i) {
            vm.expectRevert(bytes("TimelockHandoff: SAFE must not be a bot key or the guardian"));
            h.inputs(c, refused[i], sender, address(0), true);
        }
        vm.expectRevert(bytes("TimelockHandoff: SAFE must not be the sender (the deployer keeps no role)"));
        h.inputs(c, sender, sender, address(0), true);
    }

    function test_L2_mainnetRefusesAReusedTimelockAndATwoStepRun() public {
        vm.expectRevert(bytes("TimelockHandoff: mainnet refuses a pre-existing TIMELOCK (this run deploys it)"));
        h.inputs(c, owner, sender, makeAddr("old-timelock"), true);
        vm.expectRevert(bytes("TimelockHandoff: mainnet hands off in one run (set REVOKE_EOA_ADMIN=1)"));
        h.inputs(c, owner, sender, address(0), false);
        // The fork keeps the two-step flow and may reuse its timelock.
        TimelockHandoff.Config memory f = c;
        f.profileName = "fork";
        f.profile = 0;
        vm.chainId(31_337);
        h.inputs(f, owner, sender, makeAddr("old-timelock"), false);
    }

    function test_L2_configMustMatchTheChain() public {
        vm.chainId(31_337);
        vm.expectRevert(bytes("TimelockHandoff: chain id does not match the config profile"));
        h.inputs(c, owner, sender, address(0), true);
    }

    function _timelock(address[] memory proposers, address[] memory executors) internal returns (TimelockController) {
        return new TimelockController(48 hours, proposers, executors, address(0));
    }

    function test_L2_verifyRefusesASenderExecutorOrCanceller() public {
        address[] memory one = new address[](1);
        one[0] = owner;
        h.verify(_timelock(one, one), owner, sender, 48 hours);

        address[] memory two = new address[](2);
        two[0] = owner;
        two[1] = sender;
        TimelockController senderExecutes = _timelock(one, two); // built before expectRevert (it binds the next call)
        vm.expectRevert(bytes("TimelockHandoff: EOA can execute"));
        h.verify(senderExecutes, owner, sender, 48 hours);

        TimelockController tl = _timelock(one, one);
        bytes32 canceller = tl.CANCELLER_ROLE();
        vm.prank(address(tl));
        tl.grantRole(canceller, sender);
        vm.expectRevert(bytes("TimelockHandoff: EOA can cancel"));
        h.verify(tl, owner, sender, 48 hours);

        TimelockController senderProposes = _timelock(two, one);
        vm.expectRevert(bytes("TimelockHandoff: EOA can propose"));
        h.verify(senderProposes, owner, sender, 48 hours);
    }
}
