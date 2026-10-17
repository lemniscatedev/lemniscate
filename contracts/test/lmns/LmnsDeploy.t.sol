// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {LmnsStaking} from "../../src/LmnsStaking.sol";
import {LmnsBuyBurn} from "../../src/LmnsBuyBurn.sol";
import {ILmnsStaking} from "../../src/interfaces/ILmnsStaking.sol";
import {DeployLmns} from "../../script/DeployLmns.s.sol";
import {MockUSDG} from "../mocks/MockUSDG.sol";
import {MockLmns} from "../mocks/MockLmns.sol";

contract DeployLmnsHarness is DeployLmns {
    function deploy(LmnsParams memory p) external returns (LmnsStaking, LmnsBuyBurn) {
        return _deployLmns(p);
    }
}

/// @notice Todo 20 timers (todo 10 R8 style): the 14-day unstake is a deploy-time timer with a hard minimum; fork and
/// mainnet deploy the full values and refuse overrides; testnet runs in minutes.
contract LmnsDeployTest is Test {
    DeployLmnsHarness internal h;
    MockUSDG internal usdg;
    MockLmns internal lmns;
    address internal admin = makeAddr("timelock");
    address internal pool = makeAddr("pool");

    function setUp() public {
        h = new DeployLmnsHarness();
        usdg = new MockUSDG();
        lmns = new MockLmns();
    }

    function _p(uint8 profile, uint256 u, uint256 r, uint256 c) internal view returns (DeployLmns.LmnsParams memory) {
        return DeployLmns.LmnsParams(profile, admin, address(lmns), address(usdg), pool, u, r, c);
    }

    function test_R2_mainnetAndForkUseFull14dUnstake() public {
        for (uint8 profile; profile < 3; profile += 2) {
            (LmnsStaking s, LmnsBuyBurn b) = h.deploy(_p(profile, 0, 0, 0)); // 0 fork, 2 mainnet
            assertEq(s.UNSTAKE_DELAY(), 14 days);
            assertEq(s.REWARD_DURATION(), 7 days);
            assertEq(s.MIN_CLAIM_AGE(), 1 days);
            assertEq(address(s.token()), address(lmns));
            assertEq(address(b.token()), address(lmns));
            assertTrue(s.hasRole(s.DEFAULT_ADMIN_ROLE(), admin));
            vm.expectRevert(bytes("DeployLmns: fork/mainnet use full timers; unset LMNS_* timer overrides"));
            h.deploy(_p(profile, 10 minutes, 0, 0));
        }
    }

    function test_R2_testnetShortTimersWithHardMinimum() public {
        (LmnsStaking s,) = h.deploy(_p(1, 10 minutes, 15 minutes, 2 minutes));
        assertEq(s.UNSTAKE_DELAY(), 10 minutes);
        vm.expectRevert(ILmnsStaking.InvalidParams.selector);
        h.deploy(_p(1, 4 minutes, 15 minutes, 2 minutes));
        vm.expectRevert(ILmnsStaking.InvalidParams.selector);
        h.deploy(_p(1, 10 minutes, 4 minutes, 2 minutes));
        vm.expectRevert(ILmnsStaking.InvalidParams.selector);
        h.deploy(_p(1, 10 minutes, 15 minutes, 30 seconds));
    }

    function test_R1_noTokenNoDeploy() public {
        DeployLmns.LmnsParams memory p = _p(2, 0, 0, 0);
        p.token = address(0);
        vm.expectRevert(bytes("DeployLmns: LMNS_TOKEN unset (the launchpad issues it)"));
        h.deploy(p);
    }
}
