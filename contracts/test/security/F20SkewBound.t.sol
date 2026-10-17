// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {VolOracle} from "../../src/VolOracle.sol";
import {IVolOracle} from "../../src/interfaces/IVolOracle.sol";
import {Speed} from "../../src/libs/OptionTypes.sol";

/// @notice Review finding F20 (MEDIUM): VolOracle.post stored skewK unchecked, so one validly signed post with the same
/// sigma and skewK = max priced every strike other than S at 300% vol (a compromised signer drains the pool in one
/// block, past the sigma step and rate limits).
contract F20SkewBoundTest is Test {
    uint256 internal constant T0 = 1_790_000_000;
    // Well-known anvil dev account 0 (public, never funded on a real network).
    uint256 internal constant SIGNER_PK = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80; // test-key
    /// @dev Decision 17 default: k_put 1.2, k_call 0.4.
    uint64 internal constant SKEW_DEFAULT = (uint64(12_000) << 32) | 4_000;

    address internal admin = makeAddr("admin");
    address internal stock = makeAddr("stock");
    VolOracle internal oracle;
    uint64 internal nonce;

    function setUp() public {
        vm.warp(T0);
        oracle = new VolOracle(admin, vm.addr(SIGNER_PK), 2 hours, 5 minutes);
    }

    function _post(uint64 sigma, uint64 skewK) internal returns (IVolOracle.Post memory p, bytes memory sig) {
        p = IVolOracle.Post({
            stock: stock,
            speed: Speed.WEEKLY,
            sigmaBps: sigma,
            skewK: skewK,
            eventBumpBps: 0,
            buyBlockFrom: 0,
            buyBlockTo: 0,
            validUntil: uint64(block.timestamp + 1 hours),
            nonce: ++nonce
        });
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(SIGNER_PK, oracle.hashPost(p));
        sig = abi.encodePacked(r, s, v);
    }

    function test_F20_maxSkewPostReverts() public {
        (IVolOracle.Post memory p, bytes memory sig) = _post(4000, SKEW_DEFAULT);
        oracle.post(p, sig);
        skip(5 minutes);
        (p, sig) = _post(4000, type(uint64).max); // same sigma, every strike off S priced at the 300% clamp
        vm.expectRevert();
        oracle.post(p, sig);
        assertEq(oracle.read(stock, Speed.WEEKLY).skewK, SKEW_DEFAULT, "skew unchanged");
    }

    function test_F20_firstPostSkewIsBounded() public {
        (IVolOracle.Post memory p, bytes memory sig) = _post(4000, (uint64(400_000) << 32) | 400_000);
        vm.expectRevert();
        oracle.post(p, sig);
    }

    function test_F20_skewStepIsBounded() public {
        (IVolOracle.Post memory p, bytes memory sig) = _post(4000, SKEW_DEFAULT);
        oracle.post(p, sig);
        skip(5 minutes);
        // k_put 1.2 -> 3.0 in one post: inside the absolute cap, far beyond one step.
        (p, sig) = _post(4000, (uint64(30_000) << 32) | 4_000);
        vm.expectRevert();
        oracle.post(p, sig);
    }
}

/// @notice F20 fix: the bounds do not get in the way of the vol engine's real posts, and the guardian's revoke works.
contract F20SkewBoundFixTest is F20SkewBoundTest {
    address internal guardian = makeAddr("guardian");

    function test_F20_defaultSkewAndSmallStepsPost() public {
        (IVolOracle.Post memory p, bytes memory sig) = _post(4000, SKEW_DEFAULT);
        oracle.post(p, sig);
        skip(5 minutes);
        (p, sig) = _post(4000, (uint64(14_000) << 32) | 6_000); // +0.2 on each: one full step
        oracle.post(p, sig);
        assertEq(oracle.read(stock, Speed.WEEKLY).skewK, (uint64(14_000) << 32) | 6_000);
        skip(5 minutes);
        (p, sig) = _post(4000, (uint64(30_000) << 32) | 10_001); // k_call above its cap
        vm.expectRevert(abi.encodeWithSelector(VolOracle.SkewOutOfRange.selector, p.skewK));
        oracle.post(p, sig);
    }

    function test_F20_guardianRevokesSignerAtOnce() public {
        vm.startPrank(admin);
        oracle.grantRole(oracle.GUARDIAN_ROLE(), guardian);
        vm.stopPrank();
        vm.expectRevert(); // a stranger cannot
        oracle.revokeSigner();
        vm.prank(guardian);
        oracle.revokeSigner();
        assertEq(oracle.signer(), address(0));
        (IVolOracle.Post memory p, bytes memory sig) = _post(4000, SKEW_DEFAULT);
        vm.expectRevert(IVolOracle.BadSignature.selector);
        oracle.post(p, sig);
        // Only the admin (timelock) restores posting.
        vm.prank(admin);
        oracle.setSigner(vm.addr(SIGNER_PK));
        (p, sig) = _post(4000, SKEW_DEFAULT);
        oracle.post(p, sig);
    }
}
