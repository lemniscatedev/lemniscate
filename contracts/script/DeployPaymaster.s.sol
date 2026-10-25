// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {console2} from "forge-std/console2.sol";
import {LemniscatePaymaster} from "../src/LemniscatePaymaster.sol";
import {LemniscateScript} from "./lib/LemniscateScript.sol";

interface IEntryPointDepositInfo {
    function getDepositInfo(address account)
        external
        view
        returns (uint256 deposit, bool staked, uint112 stake, uint32 unstakeDelaySec, uint48 withdrawTime);
}

/// @title DeployPaymaster
/// @notice Deploys LemniscatePaymaster for an existing system (security review F39): immutables from the deployment file
/// (engine, USDG, AgentRouter) and the `.paymaster` section of the deploy config (EntryPoint, Kernel factory, signer,
/// caps, stake), stakes it in the EntryPoint, optionally funds it, hands ownership to the Safe (2-step) and runs the
/// post-deploy check below. `check(address)` re-runs that check on a live paymaster (after the Safe accepted).
///   DEPLOYMENT_FILE=deployments/<profile>.json DEPLOY_CONFIG_JSON="$(cat <config.json>)" \
///     forge script script/DeployPaymaster.s.sol --rpc-url <rpc> [--broadcast]
///   ... forge script script/DeployPaymaster.s.sol --sig "check(address)" <paymaster> --rpc-url <rpc>
/// Nothing here reads keys: sign with Foundry's own flags.
contract DeployPaymaster is LemniscateScript {
    /// @dev Floors the check enforces whatever the config says.
    uint256 internal constant MIN_UNSTAKE_DELAY = 1 days;

    struct PaymasterCfg {
        address entryPoint;
        address kernelFactory;
        address signer;
        address owner; // the deployment's Safe (fork, mainnet) or roles.owner (testnet)
        uint256 maxCostPerOp;
        uint256 accountDailyCap;
        uint256 globalDailyCap;
        uint32 unstakeDelaySec;
        uint256 stakeWei;
        uint256 depositWei; // sent at deploy (0 = the owner funds it later)
        uint256 minDepositWei; // the check fails below this
    }

    function run() external returns (LemniscatePaymaster pm) {
        string memory json = _configJson();
        Config memory c = parseConfig(json);
        Deployed memory d = loadDeploymentFile();
        PaymasterCfg memory p = parsePaymaster(json, c, d);
        validatePaymasterCfg(c, p);
        vm.startBroadcast();
        (, address deployer,) = vm.readCallers();
        pm = _deployPaymaster(p, d, deployer);
        vm.stopBroadcast();
        _report(paymasterFailures(pm, p, c, d, true));
        console2.log("  paymaster", address(pm));
        console2.log("Next: the Safe calls acceptOwnership(), then run check(address) and set PAYMASTER_ADDRESS on the API host.");
    }

    function check(address paymaster) external {
        string memory json = _configJson();
        Config memory c = parseConfig(json);
        Deployed memory d = loadDeploymentFile();
        _report(paymasterFailures(LemniscatePaymaster(payable(paymaster)), parsePaymaster(json, c, d), c, d, false));
    }

    // ------------------------------------------------------------------------------------------------ config

    function parsePaymaster(string memory json, Config memory c, Deployed memory d)
        internal
        view
        returns (PaymasterCfg memory p)
    {
        p.entryPoint = vm.parseJsonAddress(json, ".paymaster.entryPoint");
        p.kernelFactory = vm.parseJsonAddress(json, ".paymaster.kernelFactory");
        p.signer = vm.parseJsonAddress(json, ".paymaster.signer");
        p.owner = c.profile == PROFILE_TESTNET ? c.roles.owner : d.safe;
        p.maxCostPerOp = vm.parseJsonUint(json, ".paymaster.maxCostPerOpWei");
        p.accountDailyCap = vm.parseJsonUint(json, ".paymaster.accountDailyCapWei");
        p.globalDailyCap = vm.parseJsonUint(json, ".paymaster.globalDailyCapWei");
        p.unstakeDelaySec = uint32(vm.parseJsonUint(json, ".paymaster.unstakeDelaySec"));
        p.stakeWei = vm.parseJsonUint(json, ".paymaster.stakeWei");
        p.depositWei = vm.keyExistsJson(json, ".paymaster.depositWei") ? vm.parseJsonUint(json, ".paymaster.depositWei") : 0;
        p.minDepositWei = vm.parseJsonUint(json, ".paymaster.minDepositWei");
    }

    /// @notice Refuses a paymaster config before any transaction (the caps are also bounded by the contract).
    function validatePaymasterCfg(Config memory c, PaymasterCfg memory p) internal view {
        require(block.chainid == chainOf(c.profile), "DeployPaymaster: chain id does not match the profile");
        require(p.entryPoint.code.length != 0 && p.kernelFactory.code.length != 0, "DeployPaymaster: EntryPoint or Kernel factory has no code");
        require(p.signer != address(0) && p.owner != address(0), "DeployPaymaster: signer and owner are required");
        Roles memory r = c.roles;
        require(
            p.signer != r.keeper && p.signer != r.hedger && p.signer != r.volSigner && p.signer != p.owner,
            "DeployPaymaster: the paymaster signer must be its own key"
        );
        require(p.unstakeDelaySec >= MIN_UNSTAKE_DELAY && p.stakeWei != 0, "DeployPaymaster: stake (>= 1 day delay) is required");
        validateDeposit(p);
    }

    /// @notice Review R18: the deposit sent at deploy is either 0 (the owner funds it after the deploy, the runbook's
    /// path; `run` then leaves only PM_DEPOSIT_LOW to `check`) or at least the runway the check requires, so a
    /// mismatch fails before any transaction instead of in the post-deploy check.
    function validateDeposit(PaymasterCfg memory p) internal pure {
        require(p.minDepositWei != 0, "DeployPaymaster: minDepositWei is required");
        require(
            p.depositWei == 0 || p.depositWei >= p.minDepositWei,
            "DeployPaymaster: depositWei must be 0 (fund later) or at least minDepositWei"
        );
    }

    // ------------------------------------------------------------------------------------------------ deploy

    function _deployPaymaster(PaymasterCfg memory p, Deployed memory d, address deployer)
        internal
        returns (LemniscatePaymaster pm)
    {
        pm = new LemniscatePaymaster(
            p.entryPoint,
            deployer,
            p.signer,
            d.engine,
            d.usdg,
            d.agentRouter,
            p.kernelFactory,
            p.maxCostPerOp,
            p.accountDailyCap,
            p.globalDailyCap
        );
        pm.addStake{value: p.stakeWei}(p.unstakeDelaySec);
        if (p.depositWei != 0) pm.deposit{value: p.depositWei}();
        pm.transferOwnership(p.owner);
    }

    // ------------------------------------------------------------------------------------------------ check

    /// @notice Every failed check of a deployed paymaster (empty = pass). `allowPending`: right after deploy the Safe
    /// has not accepted ownership yet, so a pending owner equal to the Safe is fine, and a config that funds the
    /// deposit later (depositWei 0, review R18) has no deposit yet; `check` (allowPending false) still requires both.
    function paymasterFailures(
        LemniscatePaymaster pm,
        PaymasterCfg memory p,
        Config memory c,
        Deployed memory d,
        bool allowPending
    ) internal view returns (string[] memory out) {
        string[16] memory f;
        uint256 n;
        if (address(pm).code.length == 0) {
            out = new string[](1);
            out[0] = "PM_NO_CODE";
            return out;
        }
        if (address(pm.ENTRY_POINT()) != p.entryPoint) f[n++] = "PM_ENTRY_POINT";
        if (pm.ENGINE() != d.engine) f[n++] = "PM_ENGINE";
        if (pm.USDG() != d.usdg) f[n++] = "PM_USDG";
        if (pm.AGENT_ROUTER() == address(0) || pm.AGENT_ROUTER() != d.agentRouter) f[n++] = "PM_AGENT_ROUTER";
        if (pm.KERNEL_FACTORY() != p.kernelFactory) f[n++] = "PM_KERNEL_FACTORY";
        address s = pm.signer();
        if (s != p.signer) f[n++] = "PM_SIGNER";
        if (s == c.roles.keeper || s == c.roles.hedger || s == c.roles.volSigner || s == d.deployer) {
            f[n++] = "PM_SIGNER_IS_BOT";
        }
        if (pm.owner() != p.owner && !(allowPending && pm.pendingOwner() == p.owner)) f[n++] = "PM_OWNER";
        if (pm.maxCostPerOp() != p.maxCostPerOp || pm.accountDailyCap() != p.accountDailyCap || pm.globalDailyCap() != p.globalDailyCap) {
            f[n++] = "PM_CAPS";
        }
        if (pm.paused()) f[n++] = "PM_PAUSED";
        (uint256 deposit, bool staked, uint112 stake, uint32 delay,) =
            IEntryPointDepositInfo(p.entryPoint).getDepositInfo(address(pm));
        if (!staked || stake < p.stakeWei || delay < p.unstakeDelaySec || delay < MIN_UNSTAKE_DELAY) f[n++] = "PM_NOT_STAKED";
        if (deposit < p.minDepositWei && !(allowPending && p.depositWei == 0)) f[n++] = "PM_DEPOSIT_LOW";
        out = new string[](n);
        for (uint256 i; i < n; ++i) {
            out[i] = f[i];
        }
    }

    function _report(string[] memory fails) internal pure {
        for (uint256 i; i < fails.length; ++i) {
            console2.log("  [FAIL]", fails[i]);
        }
        require(fails.length == 0, "DeployPaymaster: check failed (see [FAIL] lines)");
        console2.log("  [PASS] paymaster check");
    }

    function _configJson() internal view returns (string memory json) {
        json = vm.envOr("DEPLOY_CONFIG_JSON", string(""));
        if (bytes(json).length == 0) json = vm.readFile(vm.envString("DEPLOY_CONFIG"));
    }
}
