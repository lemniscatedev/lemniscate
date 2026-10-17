// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {LemniscatePaymaster} from "../../src/LemniscatePaymaster.sol";
import {DeployPaymaster} from "../../script/DeployPaymaster.s.sol";
import {MockPaymasterEntryPoint} from "../mocks/PaymasterMocks.sol";

contract DeployPaymasterHarness is DeployPaymaster {
    function deploy(PaymasterCfg memory p, Deployed memory d, address deployer) external returns (LemniscatePaymaster) {
        return _deployPaymaster(p, d, deployer);
    }

    function failures(LemniscatePaymaster pm, PaymasterCfg memory p, Config memory c, Deployed memory d, bool pending)
        external
        view
        returns (string[] memory)
    {
        return paymasterFailures(pm, p, c, d, pending);
    }

    function parse(string memory json, Config memory c, Deployed memory d) external view returns (PaymasterCfg memory) {
        return parsePaymaster(json, c, d);
    }
}

/// @notice Security review F39: the paymaster is deployed by script with reviewed caps and a post-deploy check that
/// names every misconfiguration (owner, signer, immutables, stake, deposit, caps).
contract DeployPaymasterTest is Test {
    DeployPaymasterHarness internal h;
    MockPaymasterEntryPoint internal ep;
    DeployPaymaster.PaymasterCfg internal p;
    DeployPaymaster.Config internal c;
    DeployPaymaster.Deployed internal d;
    address internal safe = makeAddr("safe");
    address internal deployer;

    function setUp() public {
        h = new DeployPaymasterHarness();
        ep = new MockPaymasterEntryPoint();
        deployer = address(h);
        vm.deal(deployer, 10 ether);
        c.roles.keeper = makeAddr("keeper");
        c.roles.hedger = makeAddr("hedger");
        c.roles.volSigner = makeAddr("volSigner");
        d.safe = safe;
        d.engine = makeAddr("engine");
        d.usdg = makeAddr("usdg");
        d.agentRouter = makeAddr("agentRouter");
        d.deployer = deployer;
        // The mainnet section of docs/runbooks/deploy/deploy-config.mainnet.json (values, not addresses).
        string memory json = string.concat(
            '{"paymaster":{"entryPoint":"', vm.toString(address(ep)), '","kernelFactory":"',
            vm.toString(makeAddr("kernelFactory")), '","signer":"', vm.toString(makeAddr("pmSigner")),
            '","maxCostPerOpWei":2000000000000000,"accountDailyCapWei":10000000000000000,',
            '"globalDailyCapWei":250000000000000000,"unstakeDelaySec":86400,"stakeWei":100000000000000000,',
            '"depositWei":500000000000000000,"minDepositWei":500000000000000000}}'
        );
        p = h.parse(json, c, d);
    }

    function _deploy() internal returns (LemniscatePaymaster pm) {
        pm = h.deploy(p, d, deployer);
    }

    function _has(string[] memory f, string memory r) internal pure returns (bool) {
        for (uint256 i; i < f.length; ++i) {
            if (keccak256(bytes(f[i])) == keccak256(bytes(r))) return true;
        }
        return false;
    }

    function test_F39_scriptedDeployPassesItsCheck() public {
        LemniscatePaymaster pm = _deploy();
        assertEq(h.failures(pm, p, c, d, true).length, 0);
        assertEq(pm.pendingOwner(), safe);
        assertEq(pm.maxCostPerOp(), 0.002 ether);
        assertEq(pm.globalDailyCap(), 0.25 ether);
        // Before the Safe accepts, the final check names the owner.
        assertTrue(_has(h.failures(pm, p, c, d, false), "PM_OWNER"));
        vm.prank(safe);
        pm.acceptOwnership();
        assertEq(h.failures(pm, p, c, d, false).length, 0);
    }

    function test_F39_checkNamesEachMisconfiguration() public {
        LemniscatePaymaster pm = _deploy();
        vm.startPrank(safe);
        pm.acceptOwnership();
        pm.setSigner(c.roles.keeper);
        pm.setLimits(0.001 ether, 0.01 ether, 0.25 ether);
        pm.setPaused(true);
        pm.withdrawTo(payable(safe), 0.2 ether);
        vm.stopPrank();
        DeployPaymaster.Deployed memory other = d;
        other.agentRouter = address(0);
        string[] memory f = h.failures(pm, p, c, other, false);
        assertTrue(_has(f, "PM_SIGNER"));
        assertTrue(_has(f, "PM_SIGNER_IS_BOT"));
        assertTrue(_has(f, "PM_CAPS"));
        assertTrue(_has(f, "PM_PAUSED"));
        assertTrue(_has(f, "PM_DEPOSIT_LOW"));
        assertTrue(_has(f, "PM_AGENT_ROUTER"));
        vm.prank(safe);
        pm.unlockStake();
        assertTrue(_has(h.failures(pm, p, c, d, false), "PM_NOT_STAKED"));
    }
}
