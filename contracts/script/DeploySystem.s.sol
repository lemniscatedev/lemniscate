// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {console2} from "forge-std/console2.sol";
import {LemniscateScript} from "./lib/LemniscateScript.sol";

/// @title DeploySystem
/// @notice Deploys the whole option system (MarketHours, PriceGuard, VolOracle, SeriesRegistry + token factory,
/// WriterPool + PoolHedging, LemniscateEngine + its libraries, Reserve, FeeRouter, hedge adapter, TWAP price reference,
/// AgentRouter), wires it, lists the launch names, hands every admin role to the timelock (fork, mainnet) or the owner
/// (testnet), runs the post-deploy check and writes `deployments/<profile>.json` in the app's deployment schema.
///
/// Usage (no keys in files: sign with Foundry's own flags, e.g. `--account <keystore>` or `--ledger`):
///   DEPLOY_CONFIG_JSON="$(cat <config.json>)" forge script script/DeploySystem.s.sol --rpc-url <rpc> [--broadcast]
/// Without --broadcast Forge only simulates. Profiles and their chains: fork 31337, testnet 46630, mainnet 4663; any
/// other chain is refused before the first transaction. `DEPLOYMENT_OUT` overrides the output path.
contract DeploySystem is LemniscateScript {
    /// @notice Deploys and wires the whole system from the config, then runs the post-deploy checks.
    /// @return d every deployed address
    function run() external returns (Deployed memory d) {
        requireRealDeployArmed("DeploySystem");
        Config memory c = loadConfig();
        validateConfig(c);
        console2.log("== DeploySystem profile", c.profileName, "chain", block.chainid);

        vm.startBroadcast();
        (, address deployer,) = vm.readCallers();
        console2.log("  deployer", deployer);
        d = _deploySystem(c, deployer);
        vm.stopBroadcast();

        string[] memory fails = systemFailures(c, d);
        for (uint256 i; i < fails.length; ++i) {
            console2.log("  [FAIL]", fails[i]);
        }
        logDeployment(d);
        string memory out = vm.envOr("DEPLOYMENT_OUT", string.concat("deployments/", c.profileName, ".json"));
        if (!vm.exists("deployments")) vm.createDir("deployments", true);
        vm.writeFile(out, deploymentJson(d));
        console2.log("  deployment file", out);
        require(fails.length == 0, "DeploySystem: post-deploy check failed (see [FAIL] lines)");
        console2.log("  [PASS] post-deploy check");
    }
}
