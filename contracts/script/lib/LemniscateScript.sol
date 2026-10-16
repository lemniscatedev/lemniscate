// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {SystemChecks} from "./SystemChecks.sol";

/// @title LemniscateScript
/// @notice Base of the operational scripts: the option system's deploy config (SystemConfig), deployer
/// (SystemDeployer), post-deploy checks (SystemChecks) and loading of a deployment file written by DeploySystem.
/// @dev No address of a deployment, token, feed or pool is built into source. Deployments come from
/// `DEPLOYMENT_FILE` (a path inside contracts/) or the raw JSON in `DEPLOYMENT_JSON`; configs from `DEPLOY_CONFIG` /
/// `DEPLOY_CONFIG_JSON`. Nothing here stores or reads keys: sign with Foundry's own flags.
abstract contract LemniscateScript is Script, SystemChecks {
    function loadDeploymentFile() internal view returns (Deployed memory d) {
        string memory json = vm.envOr("DEPLOYMENT_JSON", string(""));
        if (bytes(json).length == 0) {
            string memory path = vm.envOr("DEPLOYMENT_FILE", string(""));
            require(bytes(path).length != 0, "LemniscateScript: set DEPLOYMENT_FILE (path) or DEPLOYMENT_JSON");
            json = vm.readFile(path);
        }
        d = parseDeployment(json);
        require(d.chainId == block.chainid, "LemniscateScript: deployment chainId does not match the RPC chain");
    }

    function logDeployment(Deployed memory d) internal pure {
        console2.log("  engine        ", d.engine);
        console2.log("  pool          ", d.pool);
        console2.log("  registry      ", d.registry);
        console2.log("  priceGuard    ", d.priceGuard);
        console2.log("  volOracle     ", d.volOracle);
        console2.log("  marketHours   ", d.marketHours);
        console2.log("  reserve       ", d.reserve);
        console2.log("  feeRouter     ", d.feeRouter);
        console2.log("  agentRouter   ", d.agentRouter);
        console2.log("  hedgeAdapter  ", d.hedgeAdapter);
        console2.log("  usdg          ", d.usdg);
        console2.log("  admin         ", d.admin);
        console2.log("  timelock      ", d.timelock);
        console2.log("  safe          ", d.safe);
        for (uint256 i; i < d.stocks.length; ++i) {
            console2.log("  stock", d.names[i], d.stocks[i]);
        }
    }
}
