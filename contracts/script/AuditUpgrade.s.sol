// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {console2} from "forge-std/console2.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {LemniscateEngine} from "../src/LemniscateEngine.sol";
import {WriterPool} from "../src/WriterPool.sol";
import {LemniscateScript} from "./lib/LemniscateScript.sol";

/// @title AuditUpgrade (audit 2026-10-29: M-1, M-2 fail-closed consumers, L-1, L-2)
/// @notice Step 1 (`run`): deploys the new LemniscateEngine and WriterPool implementations (forge links and deploys the
/// changed libraries) and prints the timelock batch the owner schedules, then executes 48 h later. The proxies, their
/// storage and every role stay; PriceGuard is not redeployed (the engine and pool read only `twapSource` and
/// `tradeTwap`, which the live PriceGuard has).
///   DEPLOYMENT_FILE=deployments/mainnet.json forge script script/AuditUpgrade.s.sol --rpc-url <rpc> \
///     [--broadcast --keystore ... --password-file ...]   (broadcast needs LEMNISCATE_ALLOW_REAL_DEPLOY + LEMNISCATE_ALLOW_FILE)
/// The queue delay of the new pool implementation is read from the live one, so the immutable is unchanged.
contract AuditUpgrade is LemniscateScript {
    bytes32 internal constant SALT = keccak256("lemniscate-audit-2026-10-29");

    function run() external returns (address engineImpl, address poolImpl) {
        requireRealDeployArmed("AuditUpgrade");
        Deployed memory d = loadDeploymentFile();
        uint256 queueDelay = WriterPool(d.poolImpl).QUEUE_DELAY();
        vm.startBroadcast();
        engineImpl = address(new LemniscateEngine());
        poolImpl = address(new WriterPool(queueDelay));
        vm.stopBroadcast();
        _printBatch(d, engineImpl, poolImpl);
    }

    /// @dev The timelock batch for given implementations (used by `run` and by the fork proof).
    function batch(address engine, address pool, address engineImpl, address poolImpl)
        public
        pure
        returns (address[] memory targets, uint256[] memory values, bytes[] memory payloads)
    {
        targets = new address[](2);
        values = new uint256[](2);
        payloads = new bytes[](2);
        targets[0] = engine;
        targets[1] = pool;
        payloads[0] = abi.encodeCall(UUPSUpgradeable.upgradeToAndCall, (engineImpl, ""));
        payloads[1] = abi.encodeCall(UUPSUpgradeable.upgradeToAndCall, (poolImpl, ""));
    }

    function _printBatch(Deployed memory d, address engineImpl, address poolImpl) internal view {
        (address[] memory t, uint256[] memory v, bytes[] memory p) = batch(d.engine, d.pool, engineImpl, poolImpl);
        uint256 delay = TimelockController(payable(d.admin)).getMinDelay();
        bytes memory schedule = abi.encodeCall(TimelockController.scheduleBatch, (t, v, p, bytes32(0), SALT, delay));
        bytes memory execute = abi.encodeCall(TimelockController.executeBatch, (t, v, p, bytes32(0), SALT));
        console2.log("== AuditUpgrade");
        console2.log("  new engine implementation", engineImpl);
        console2.log("  new pool implementation  ", poolImpl);
        console2.log("  timelock", d.admin);
        console2.log("  operation id");
        console2.logBytes32(TimelockController(payable(d.admin)).hashOperationBatch(t, v, p, bytes32(0), SALT));
        console2.log("  owner sends to the timelock now (scheduleBatch):");
        console2.logBytes(schedule);
        console2.log("  owner sends to the timelock after the delay (executeBatch):");
        console2.logBytes(execute);
    }
}
