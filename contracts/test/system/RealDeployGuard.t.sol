// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {SystemConfig} from "../../script/lib/SystemConfig.sol";

contract GuardHarness is SystemConfig {
    function armedFor(uint256 chainId, bool broadcasting, string memory flag, string memory file) external view {
        requireArmedFor(chainId, broadcasting, flag, file, "Guard");
    }

    function armed() external view {
        requireRealDeployArmed("Guard");
    }
}

/// @notice Gap audit 19: every script that broadcasts refuses a real chain (4663, 46630) unless
/// LEMNISCATE_ALLOW_REAL_DEPLOY=1 AND the file named by LEMNISCATE_ALLOW_FILE exists. Simulation, forks and anvil chain
/// ids stay free. The environment values are passed as arguments: the process environment is shared by parallel tests.
contract RealDeployGuardTest is Test {
    GuardHarness internal h;
    string internal constant NO_FLAG = "Guard: refusing to broadcast to a real chain: set LEMNISCATE_ALLOW_REAL_DEPLOY=1 (owner's deploy command only)";
    string internal constant NO_FILE_VAR = "Guard: refusing to broadcast to a real chain: set LEMNISCATE_ALLOW_FILE to the arming file";
    string internal constant NO_FILE = "Guard: refusing to broadcast to a real chain: the LEMNISCATE_ALLOW_FILE file does not exist";

    function setUp() public {
        h = new GuardHarness();
    }

    function _file(string memory name) internal returns (string memory path) {
        path = string.concat("out/real-deploy-armed-", name);
        vm.writeFile(path, "armed");
    }

    function test_mainnetBroadcastRefusedWhenNothingIsSet() public {
        vm.expectRevert(bytes(NO_FLAG));
        h.armedFor(4663, true, "", "");
    }

    function test_testnetBroadcastRefusedWhenNothingIsSet() public {
        vm.expectRevert(bytes(NO_FLAG));
        h.armedFor(46630, true, "", "");
    }

    function test_flagWithoutFileIsRefused() public {
        vm.expectRevert(bytes(NO_FILE_VAR));
        h.armedFor(4663, true, "1", "");
    }

    function test_flagWithMissingFileIsRefused() public {
        vm.expectRevert(bytes(NO_FILE));
        h.armedFor(46630, true, "1", "out/real-deploy-armed-does-not-exist");
    }

    function test_fileWithoutFlagIsRefused() public {
        string memory f = _file("no-flag");
        vm.expectRevert(bytes(NO_FLAG));
        h.armedFor(4663, true, "", f);
        vm.removeFile(f);
    }

    function test_flagOtherThanOneIsRefused() public {
        string memory f = _file("wrong-flag");
        vm.expectRevert(bytes(NO_FLAG));
        h.armedFor(4663, true, "true", f);
        vm.expectRevert(bytes(NO_FLAG));
        h.armedFor(4663, true, "0", f);
        vm.removeFile(f);
    }

    function test_flagAndFileArmBothRealChains() public {
        string memory f = _file("armed");
        h.armedFor(4663, true, "1", f);
        h.armedFor(46630, true, "1", f);
        vm.removeFile(f);
    }

    function test_simulationForksAndAnvilStayFree() public view {
        h.armedFor(4663, false, "", ""); // simulation of a real chain (no --broadcast)
        h.armedFor(46630, false, "", "");
        h.armedFor(31337, true, "", ""); // anvil / fork chain id
        h.armedFor(1, true, "", "");
    }

    function test_testContextIsNeverTreatedAsBroadcast() public {
        vm.chainId(4663);
        h.armed(); // forge test is not a ScriptBroadcast context
    }

    /// @dev Every script that reaches vm.startBroadcast or vm.broadcast must call the guard, and the guard call must come
    /// before the first broadcast. A new broadcasting script without it fails here.
    function test_everyBroadcastingScriptCallsTheGuardFirst() public view {
        VmSafe.DirEntry[] memory entries = vm.readDir("script", 3);
        uint256 scripts;
        for (uint256 i; i < entries.length; ++i) {
            string memory path = entries[i].path;
            if (entries[i].isDir || !_endsWith(path, ".s.sol")) continue;
            ++scripts;
            string memory src = vm.readFile(path);
            int256 broadcast = _find(src, "vm.startBroadcast(");
            int256 single = _find(src, "vm.broadcast(");
            if (broadcast < 0 || (single >= 0 && single < broadcast)) broadcast = single;
            int256 guard = _find(src, "requireRealDeployArmed(\"");
            if (broadcast < 0) continue; // read-only script
            assertGe(guard, 0, string.concat(path, " broadcasts without the armed-flag guard"));
            assertLt(guard, broadcast, string.concat(path, ": the guard must precede the first broadcast"));
        }
        assertGe(scripts, 5, "scanned the script directory");
    }

    function _endsWith(string memory s, string memory suffix) internal pure returns (bool) {
        bytes memory a = bytes(s);
        bytes memory b = bytes(suffix);
        if (a.length < b.length) return false;
        for (uint256 i; i < b.length; ++i) {
            if (a[a.length - b.length + i] != b[i]) return false;
        }
        return true;
    }

    function _find(string memory hay, string memory needle) internal pure returns (int256) {
        bytes memory h_ = bytes(hay);
        bytes memory n = bytes(needle);
        if (n.length == 0 || h_.length < n.length) return -1;
        for (uint256 i; i <= h_.length - n.length; ++i) {
            bool ok = true;
            for (uint256 j; j < n.length; ++j) {
                if (h_[i + j] != n[j]) {
                    ok = false;
                    break;
                }
            }
            if (ok) return int256(i);
        }
        return -1;
    }
}
