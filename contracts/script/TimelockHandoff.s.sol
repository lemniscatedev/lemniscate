// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {console2} from "forge-std/console2.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {LemniscateScript} from "./lib/LemniscateScript.sol";

/// @title TimelockHandoff
/// @notice Moves DEFAULT_ADMIN_ROLE on LemniscateEngine, WriterPool and MarketHours from the admin EOA to an OpenZeppelin
/// TimelockController whose only proposer, executor and canceller is a Safe.
///
/// Step 1 (always): deploy the timelock (or reuse TIMELOCK) and grant it DEFAULT_ADMIN_ROLE on the three proxies.
/// Step 2 (REVOKE_EOA_ADMIN=1 only): the EOA renounces its DEFAULT_ADMIN_ROLE everywhere, and its vault KEEPER_ROLE
/// when a separate KEEPER already holds that role. Refused unless the timelock already holds the role on every proxy,
/// the timelock is wired to the Safe exactly as expected, and the Safe has code.
///
/// Roles deliberately left alone: KEEPER_ROLE (the keeper bot) and GUARDIAN_ROLE on the engine. AccessControl keeps
/// these independent of DEFAULT_ADMIN_ROLE, so the guardian can stay with a fast EOA or Safe outside the timelock:
/// a guardian can only pause buys (`setBuysPaused` / `setGlobalBuysPaused`), and pausing buys never blocks sells, so
/// an instant guardian cannot trap user funds. Granting or revoking those roles later goes through the timelock.
/// @dev Run it twice: first without REVOKE_EOA_ADMIN to deploy and grant, verify with PostDeployCheck (TIMELOCK and
/// ALLOW_EOA_ADMIN=1), then again with TIMELOCK=<deployed> REVOKE_EOA_ADMIN=1. One combined run also works.
contract TimelockHandoff is LemniscateScript {
    uint256 private constant DEFAULT_MIN_DELAY = 172_800; // 48 hours

    function run() external {
        Deployment memory d = loadDeployment();
        require(d.marketHours != address(0), "TimelockHandoff: MARKET_HOURS unknown");
        address safe = vm.envAddress("SAFE");
        require(safe.code.length != 0, "TimelockHandoff: SAFE has no code");
        uint256 minDelay = vm.envOr("TIMELOCK_MIN_DELAY", DEFAULT_MIN_DELAY);
        bool revoke = vm.envOr("REVOKE_EOA_ADMIN", false);
        bool guardianToSafe = vm.envOr("GRANT_GUARDIAN_TO_SAFE", false);
        address eoa = msg.sender;
        if (d.admin != address(0)) require(eoa == d.admin, "TimelockHandoff: sender is not ADMIN");

        address[3] memory targets = [d.engine, d.vault, d.marketHours];
        string[3] memory names = ["engine", "vault", "marketHours"];
        for (uint256 i; i < 3; ++i) {
            require(
                IAccessControl(targets[i]).hasRole(DEFAULT_ADMIN_ROLE, eoa),
                string.concat("TimelockHandoff: sender lacks DEFAULT_ADMIN_ROLE on ", names[i])
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
        for (uint256 i; i < 3; ++i) {
            if (!IAccessControl(targets[i]).hasRole(DEFAULT_ADMIN_ROLE, timelock)) {
                IAccessControl(targets[i]).grantRole(DEFAULT_ADMIN_ROLE, timelock);
            }
        }
        if (guardianToSafe && !IAccessControl(d.engine).hasRole(GUARDIAN_ROLE, safe)) {
            IAccessControl(d.engine).grantRole(GUARDIAN_ROLE, safe);
        }
        vm.stopBroadcast();

        console2.log("  timelock", timelock);
        _verifyTimelock(TimelockController(payable(timelock)), safe, eoa, minDelay);
        for (uint256 i; i < 3; ++i) {
            require(
                IAccessControl(targets[i]).hasRole(DEFAULT_ADMIN_ROLE, timelock),
                string.concat("TimelockHandoff: timelock lacks DEFAULT_ADMIN_ROLE on ", names[i])
            );
        }
        console2.log("  [PASS] timelock holds DEFAULT_ADMIN_ROLE on engine, vault, marketHours");

        if (!revoke) {
            console2.log("  REVOKE_EOA_ADMIN not set: the EOA keeps its admin role (run again with it to finish)");
            _logRoles(targets, names, eoa, timelock, safe, d.keeper);
            return;
        }

        // Guards before the irreversible part.
        require(safe.code.length != 0, "TimelockHandoff: refusing to revoke, SAFE has no code");
        require(timelock != eoa && timelock.code.length != 0, "TimelockHandoff: refusing to revoke, bad timelock");

        vm.startBroadcast();
        if (
            d.keeper != address(0) && d.keeper != eoa && IAccessControl(d.vault).hasRole(KEEPER_ROLE, d.keeper)
                && IAccessControl(d.vault).hasRole(KEEPER_ROLE, eoa)
        ) {
            IAccessControl(d.vault).renounceRole(KEEPER_ROLE, eoa);
        }
        for (uint256 i; i < 3; ++i) {
            IAccessControl(targets[i]).renounceRole(DEFAULT_ADMIN_ROLE, eoa);
        }
        vm.stopBroadcast();

        for (uint256 i; i < 3; ++i) {
            require(
                !IAccessControl(targets[i]).hasRole(DEFAULT_ADMIN_ROLE, eoa),
                string.concat("TimelockHandoff: EOA still admin on ", names[i])
            );
            require(
                IAccessControl(targets[i]).hasRole(DEFAULT_ADMIN_ROLE, timelock),
                string.concat("TimelockHandoff: timelock lost admin on ", names[i])
            );
        }
        console2.log("  [PASS] EOA renounced DEFAULT_ADMIN_ROLE; the timelock is the only known admin");
        _logRoles(targets, names, eoa, timelock, safe, d.keeper);
    }

    function _verifyTimelock(TimelockController tl, address safe, address eoa, uint256 minDelay) private view {
        require(tl.getMinDelay() >= minDelay, "TimelockHandoff: timelock delay below TIMELOCK_MIN_DELAY");
        require(tl.hasRole(tl.PROPOSER_ROLE(), safe), "TimelockHandoff: SAFE is not proposer");
        require(tl.hasRole(tl.EXECUTOR_ROLE(), safe), "TimelockHandoff: SAFE is not executor");
        require(tl.hasRole(tl.CANCELLER_ROLE(), safe), "TimelockHandoff: SAFE is not canceller");
        require(tl.hasRole(DEFAULT_ADMIN_ROLE, address(tl)), "TimelockHandoff: timelock does not administer itself");
        require(!tl.hasRole(DEFAULT_ADMIN_ROLE, eoa), "TimelockHandoff: EOA administers the timelock");
        require(!tl.hasRole(DEFAULT_ADMIN_ROLE, safe), "TimelockHandoff: SAFE bypasses the timelock delay");
        require(!tl.hasRole(tl.PROPOSER_ROLE(), eoa), "TimelockHandoff: EOA can propose");
        require(!tl.hasRole(tl.EXECUTOR_ROLE(), address(0)), "TimelockHandoff: execution is open to anyone");
        console2.log("  [PASS] timelock delay", tl.getMinDelay(), "s; SAFE proposer/executor/canceller; self-administered");
    }

    function _logRoles(
        address[3] memory targets,
        string[3] memory names,
        address eoa,
        address timelock,
        address safe,
        address keeper
    ) private view {
        for (uint256 i; i < 3; ++i) {
            IAccessControl t = IAccessControl(targets[i]);
            console2.log(string.concat("  ", names[i], " roles (admin eoa / timelock / safe / keeper):"));
            console2.log(
                string.concat(
                    "    DEFAULT_ADMIN ",
                    _b(t.hasRole(DEFAULT_ADMIN_ROLE, eoa)),
                    " ",
                    _b(t.hasRole(DEFAULT_ADMIN_ROLE, timelock)),
                    " ",
                    _b(t.hasRole(DEFAULT_ADMIN_ROLE, safe)),
                    " ",
                    _b(keeper != address(0) && t.hasRole(DEFAULT_ADMIN_ROLE, keeper))
                )
            );
            console2.log(
                string.concat(
                    "    KEEPER        ",
                    _b(t.hasRole(KEEPER_ROLE, eoa)),
                    " ",
                    _b(t.hasRole(KEEPER_ROLE, timelock)),
                    " ",
                    _b(t.hasRole(KEEPER_ROLE, safe)),
                    " ",
                    _b(keeper != address(0) && t.hasRole(KEEPER_ROLE, keeper))
                )
            );
            if (i == 0) {
                console2.log(
                    string.concat(
                        "    GUARDIAN      ",
                        _b(t.hasRole(GUARDIAN_ROLE, eoa)),
                        " ",
                        _b(t.hasRole(GUARDIAN_ROLE, timelock)),
                        " ",
                        _b(t.hasRole(GUARDIAN_ROLE, safe)),
                        " ",
                        _b(keeper != address(0) && t.hasRole(GUARDIAN_ROLE, keeper))
                    )
                );
            }
        }
    }

    function _b(bool v) private pure returns (string memory) {
        return v ? "yes" : "no ";
    }
}
