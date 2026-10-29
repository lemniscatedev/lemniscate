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

    function checkDeposit(PaymasterCfg memory p) external pure {
        validateDeposit(p);
    }

    function validate(Config memory c, PaymasterCfg memory p) external view {
        validatePaymasterCfg(c, p);
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
        // A funded-at-deploy config (depositWei = minDepositWei). The exact mainnet section is in _mainnetJson().
        string memory json = string.concat(
            '{"paymaster":{"entryPoint":"', vm.toString(address(ep)), '","kernelFactory":"',
            vm.toString(makeAddr("kernelFactory")), '","signer":"', vm.toString(makeAddr("pmSigner")),
            '","maxCostPerOpWei":2000000000000000,"accountDailyCapWei":10000000000000000,',
            '"globalDailyCapWei":250000000000000000,"unstakeDelaySec":86400,"stakeWei":100000000000000000,',
            '"depositWei":500000000000000000,"minDepositWei":500000000000000000}}'
        );
        p = h.parse(json, c, d);
    }

    /// @dev The `.paymaster` section of deploy-config.mainnet.json (2026-10-25) value for value; only the addresses are
    /// swapped for test ones (the mainnet signer is a zero placeholder until the wallet pack exists).
    function _mainnetJson() internal returns (string memory) {
        return string.concat(
            '{"paymaster":{"entryPoint":"', vm.toString(address(ep)), '","kernelFactory":"',
            vm.toString(makeAddr("kernelFactory")), '","signer":"', vm.toString(makeAddr("pmSigner")),
            '","maxCostPerOpWei":2000000000000000,"accountDailyCapWei":10000000000000000,',
            '"globalDailyCapWei":250000000000000000,"unstakeDelaySec":86400,"stakeWei":100000000000000000,',
            '"depositWei":0,"minDepositWei":500000000000000000}}'
        );
    }

    /// @dev Review R18 (regression): with the mainnet values (deposit 0 = the owner funds it later, minimum 0.5 ETH)
    /// the scripted deploy's own check failed PM_DEPOSIT_LOW and run() reverted before broadcast. It now passes; the
    /// final check names exactly the documented pending items (owner acceptance, deposit) until they are done.
    function test_R18_mainnetConfigDeploysAndCheckNamesOnlyThePendingItems() public {
        DeployPaymaster.PaymasterCfg memory m = h.parse(_mainnetJson(), c, d);
        h.checkDeposit(m);
        LemniscatePaymaster pm = h.deploy(m, d, deployer);
        assertEq(h.failures(pm, m, c, d, true).length, 0, "run()'s check passes");
        string[] memory f = h.failures(pm, m, c, d, false);
        assertEq(f.length, 2);
        assertTrue(_has(f, "PM_OWNER") && _has(f, "PM_DEPOSIT_LOW"));
        vm.prank(safe);
        pm.acceptOwnership();
        pm.deposit{value: 0.5 ether}();
        assertEq(h.failures(pm, m, c, d, false).length, 0, "check passes once funded and accepted");
    }

    /// @dev PROPERTY: for any deposit setting, either the config is refused before any transaction, or the scripted
    /// deploy passes its own check and the final check fails only on the documented pending items.
    function testFuzz_R18_depositSettingNeverBreaksTheScriptedDeploy(uint256 depositWei, uint256 minDepositWei) public {
        DeployPaymaster.PaymasterCfg memory m = h.parse(_mainnetJson(), c, d);
        m.depositWei = bound(depositWei, 0, 2 ether);
        m.minDepositWei = bound(minDepositWei, 0, 2 ether);
        try h.checkDeposit(m) {}
        catch {
            assertTrue(m.minDepositWei == 0 || (m.depositWei != 0 && m.depositWei < m.minDepositWei));
            return;
        }
        LemniscatePaymaster pm = h.deploy(m, d, deployer);
        assertEq(h.failures(pm, m, c, d, true).length, 0, "run()'s check passes");
        string[] memory f = h.failures(pm, m, c, d, false);
        for (uint256 i; i < f.length; ++i) {
            assertTrue(_has(_pending(), f[i]), f[i]);
        }
    }

    function _pending() internal pure returns (string[] memory s) {
        s = new string[](2);
        s[0] = "PM_OWNER";
        s[1] = "PM_DEPOSIT_LOW";
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

    // ------------------------------------------------------------- EOA owner (skeptic L1, decision 2026-10-28)

    /// @dev Mainnet profile with the owner EOA as `d.safe` (the timelock owner), as the mainnet deploy will have it.
    function _mainnetEoa(bool allowEoa) internal returns (DeployPaymaster.Config memory m) {
        vm.chainId(4663);
        vm.etch(p.kernelFactory, hex"00");
        m = c;
        m.profileName = "mainnet";
        m.profile = 2; // PROFILE_MAINNET
        m.allowEoaOwner = allowEoa;
    }

    /// @dev The paymaster is owned directly by the owner EOA (only sponsored-gas ETH at risk, instant pause): accepted
    /// with ALLOW_EOA_OWNER=1, deployed, accepted, and its check passes; the owner pauses at once.
    function test_L1_eoaOwnerDeploysAndPasses() public {
        DeployPaymaster.Config memory m = _mainnetEoa(true);
        assertEq(safe.code.length, 0, "the owner is a plain EOA");
        h.validate(m, p);
        LemniscatePaymaster pm = h.deploy(p, d, deployer);
        assertEq(h.failures(pm, p, m, d, true).length, 0);
        vm.prank(safe);
        pm.acceptOwnership();
        assertEq(pm.owner(), safe);
        assertEq(h.failures(pm, p, m, d, false).length, 0);
        vm.prank(safe);
        pm.setPaused(true); // instant, no timelock
        assertTrue(pm.paused());
    }

    function test_L1_eoaOwnerRefusedWithoutTheFlag() public {
        DeployPaymaster.Config memory m = _mainnetEoa(false);
        vm.expectRevert(
            bytes("DeployPaymaster: owner refused: OWNER_IS_EOA (deploy the owner Safe first, or ALLOW_EOA_OWNER=1)")
        );
        h.validate(m, p);
    }

    function test_L1_delegatedOwnerRefusedAndFlagged() public {
        DeployPaymaster.Config memory m = _mainnetEoa(true);
        LemniscatePaymaster pm = h.deploy(p, d, deployer);
        vm.prank(safe);
        pm.acceptOwnership();
        vm.etch(safe, abi.encodePacked(hex"ef0100", makeAddr("sweeper")));
        vm.expectRevert(bytes("DeployPaymaster: owner refused: OWNER_IS_DELEGATED_EOA"));
        h.validate(m, p);
        assertTrue(_has(h.failures(pm, p, m, d, false), "PM_OWNER_DELEGATED"));
        // Testnet refuses a delegated owner too.
        m.profile = 1;
        vm.chainId(46_630);
        vm.expectRevert(bytes("DeployPaymaster: owner refused: OWNER_IS_DELEGATED_EOA"));
        h.validate(m, p);
    }
}
