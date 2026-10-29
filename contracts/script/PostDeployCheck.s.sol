// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {console2} from "forge-std/console2.sol";
import {LemniscateScript} from "./lib/LemniscateScript.sol";

/// @title PostDeployCheck
/// @notice Read-only check of a live deployment against its deploy config: wiring, admin = timelock (or owner on
/// testnet) with the deployer renounced, separated bots, guardian pause-only, timers, every launch name configured,
/// allowed, routed and priced. Prints one named reason per failure and reverts if there is any.
///   DEPLOYMENT_FILE=deployments/<profile>.json DEPLOY_CONFIG_JSON="$(cat <config.json>)" \
///     forge script script/PostDeployCheck.s.sol --rpc-url <rpc>
/// It never broadcasts. Without a config only the profile-independent part could run, so the config is required.
contract PostDeployCheck is LemniscateScript {
    /// @notice Runs every read-only check and reverts with the list of failures if any.
    function run() external {
        Config memory c = loadConfig();
        Deployed memory d = loadDeploymentFile();
        if (c.profile == PROFILE_TESTNET) {
            for (uint256 i; i < d.stocks.length && i < c.stocks.length; ++i) {
                c.stocks[i].stock = d.stocks[i];
                c.stocks[i].feed = d.feeds[i];
            }
        }
        string[] memory fails = systemFailures(c, d);
        console2.log("== PostDeployCheck", d.network, "chain", block.chainid);
        for (uint256 i; i < fails.length; ++i) {
            console2.log("  [FAIL]", fails[i]);
        }
        require(fails.length == 0, "PostDeployCheck: FAILED (see [FAIL] lines)");
        console2.log("  [PASS] every check");
    }
}
