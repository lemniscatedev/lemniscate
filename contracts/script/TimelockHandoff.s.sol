// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {console2} from "forge-std/console2.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {LemniscateScript} from "./lib/LemniscateScript.sol";

/// @title TimelockHandoff
/// @notice Separate-step handoff for a deployment made with `"handoff": false` (for example when the launch team
/// deploys and the owner side wants to verify every address first): moves DEFAULT_ADMIN_ROLE on all eight
/// administered contracts (engine, pool, registry, priceGuard, volOracle, marketHours, reserve, feeRouter) from the
/// deployer EOA to an OpenZeppelin TimelockController whose only proposer, executor and canceller is a Safe.
///
/// Step 1 (always): deploy the timelock (or reuse TIMELOCK) and grant it DEFAULT_ADMIN_ROLE everywhere.
/// Step 2 (REVOKE_EOA_ADMIN=1 only): the EOA renounces DEFAULT_ADMIN_ROLE everywhere. Refused unless the timelock
/// already holds the role on every contract, is wired to the Safe exactly as expected, and the Safe has code.
/// Keeper, hedger and guardian roles are left alone (granted at deploy; changing them later goes through the timelock).
///   DEPLOYMENT_FILE=deployments/<profile>.json SAFE=<safe> forge script script/TimelockHandoff.s.sol --rpc-url <rpc> \
///     --account <deployer keystore> [--broadcast]
/// @dev Testnet (46630) has no timelock by design (decision: Safe/timelock only on mainnet); the script refuses it.
contract TimelockHandoff is LemniscateScript {
    function run() external {
        require(block.chainid != CHAIN_TESTNET, "TimelockHandoff: testnet has no timelock (admin is the owner)");
        Deployed memory d = loadDeploymentFile();
        address safe = vm.envAddress("SAFE");
        require(safe.code.length != 0, "TimelockHandoff: SAFE has no code");
        if (block.chainid == CHAIN_MAINNET) {
            require(
                _safeThreshold(safe) >= MAINNET_SAFE_MIN_THRESHOLD && _safeOwners(safe) >= MAINNET_SAFE_MIN_OWNERS,
                "TimelockHandoff: mainnet Safe must be at least 3-of-5"
            );
        }
        uint256 minDelay = vm.envOr("TIMELOCK_MIN_DELAY", FULL_TIMELOCK_DELAY);
        require(minDelay >= FULL_TIMELOCK_DELAY, "TimelockHandoff: delay below the 48h minimum");
        bool revoke = vm.envOr("REVOKE_EOA_ADMIN", false);

        vm.startBroadcast();
        (, address eoa,) = vm.readCallers();
        vm.stopBroadcast();
        address[] memory targets = adminTargets(d);
        for (uint256 i; i < targets.length; ++i) {
            require(
                IAccessControl(targets[i]).hasRole(ADMIN, eoa),
                string.concat("TimelockHandoff: sender lacks DEFAULT_ADMIN_ROLE on target ", vm.toString(i))
            );
        }
        console2.log("== TimelockHandoff chain", block.chainid);
        console2.log("  admin EOA (sender)", eoa);
        console2.log("  safe", safe);

        address timelock = vm.envOr("TIMELOCK", address(0));
        vm.startBroadcast();
        if (timelock == address(0)) {
            address[] memory members = new address[](1);
            members[0] = safe;
            // admin = address(0): the timelock administers itself; OZ v5 also makes every proposer a canceller.
            timelock = address(new TimelockController(minDelay, members, members, address(0)));
        }
        for (uint256 i; i < targets.length; ++i) {
            if (!IAccessControl(targets[i]).hasRole(ADMIN, timelock)) {
                IAccessControl(targets[i]).grantRole(ADMIN, timelock);
            }
        }
        vm.stopBroadcast();

        console2.log("  timelock", timelock);
        _verifyTimelock(TimelockController(payable(timelock)), safe, eoa, minDelay);
        for (uint256 i; i < targets.length; ++i) {
            require(IAccessControl(targets[i]).hasRole(ADMIN, timelock), "TimelockHandoff: timelock lacks admin");
        }
        console2.log("  [PASS] timelock holds DEFAULT_ADMIN_ROLE on all eight contracts");
        if (!revoke) {
            console2.log("  REVOKE_EOA_ADMIN not set: the EOA keeps its admin role (run again with it to finish)");
            return;
        }

        require(timelock != eoa && timelock.code.length != 0, "TimelockHandoff: refusing to revoke, bad timelock");
        vm.startBroadcast();
        for (uint256 i; i < targets.length; ++i) {
            IAccessControl(targets[i]).renounceRole(ADMIN, eoa);
        }
        vm.stopBroadcast();
        for (uint256 i; i < targets.length; ++i) {
            require(!IAccessControl(targets[i]).hasRole(ADMIN, eoa), "TimelockHandoff: EOA still admin");
            require(IAccessControl(targets[i]).hasRole(ADMIN, timelock), "TimelockHandoff: timelock lost admin");
        }
        console2.log("  [PASS] EOA renounced DEFAULT_ADMIN_ROLE; the timelock is the only admin");
        console2.log("  next: update the deployment file's admin/timelock/safe and run PostDeployCheck");
    }

    function _verifyTimelock(TimelockController tl, address safe, address eoa, uint256 minDelay) private view {
        require(tl.getMinDelay() >= minDelay, "TimelockHandoff: timelock delay below TIMELOCK_MIN_DELAY");
        require(tl.hasRole(tl.PROPOSER_ROLE(), safe), "TimelockHandoff: SAFE is not proposer");
        require(tl.hasRole(tl.EXECUTOR_ROLE(), safe), "TimelockHandoff: SAFE is not executor");
        require(tl.hasRole(tl.CANCELLER_ROLE(), safe), "TimelockHandoff: SAFE is not canceller");
        require(tl.hasRole(ADMIN, address(tl)), "TimelockHandoff: timelock does not administer itself");
        require(!tl.hasRole(ADMIN, eoa), "TimelockHandoff: EOA administers the timelock");
        require(!tl.hasRole(ADMIN, safe), "TimelockHandoff: SAFE bypasses the timelock delay");
        require(!tl.hasRole(tl.PROPOSER_ROLE(), eoa), "TimelockHandoff: EOA can propose");
        require(!tl.hasRole(tl.EXECUTOR_ROLE(), address(0)), "TimelockHandoff: execution is open to anyone");
        console2.log("  [PASS] timelock delay", tl.getMinDelay(), "s; SAFE proposer/executor/canceller; self-administered");
    }
}
