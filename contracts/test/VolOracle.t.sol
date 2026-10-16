// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {VolOracle} from "../src/VolOracle.sol";
import {IVolOracle} from "../src/interfaces/IVolOracle.sol";
import {Speed, VolReading} from "../src/libs/OptionTypes.sol";

contract VolOracleTest is Test {
    uint256 internal constant T0 = 1_790_000_000; // 2026-09-21
    // Well-known anvil dev accounts 0 and 1 (public, never funded on a real network).
    uint256 internal constant SIGNER_PK = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80; // test-key
    uint256 internal constant OTHER_PK = 0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d; // test-key
    uint256 internal constant SECP256K1_N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141; // not-a-key: curve order

    address internal admin = makeAddr("admin");
    address internal stranger = makeAddr("stranger");
    address internal stock = makeAddr("stock");
    address internal signerAddr;

    VolOracle internal oracle;

    function setUp() public {
        vm.warp(T0);
        signerAddr = vm.addr(SIGNER_PK);
        oracle = new VolOracle(admin, signerAddr);
    }

    // ------------------------------------------------------------------ helpers

    function _post(uint64 sigma, uint64 nonce) internal view returns (IVolOracle.Post memory) {
        return IVolOracle.Post({
            stock: stock,
            speed: Speed.DAILY,
            sigmaBps: sigma,
            skewK: 1200,
            eventBumpBps: 0,
            buyBlockFrom: 0,
            buyBlockTo: 0,
            validUntil: uint64(block.timestamp + 1 hours),
            nonce: nonce
        });
    }

    function _sign(uint256 pk, IVolOracle.Post memory p) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, oracle.hashPost(p));
        return abi.encodePacked(r, s, v);
    }

    function _submit(IVolOracle.Post memory p) internal {
        oracle.post(p, _sign(SIGNER_PK, p));
    }

    // ------------------------------------------------------------------ R1 valid signature

    function test_R1_validSignatureAccepted() public {
        IVolOracle.Post memory p = _post(5000, 1);
        p.eventBumpBps = 400;
        p.buyBlockFrom = uint64(T0 + 1 days);
        p.buyBlockTo = uint64(T0 + 2 days);
        bytes memory sig = _sign(SIGNER_PK, p);

        vm.expectEmit(address(oracle));
        emit IVolOracle.VolPosted(stock, Speed.DAILY, 5000, 1200, 400, p.validUntil, 1);
        vm.prank(stranger); // anyone may submit
        oracle.post(p, sig);

        VolReading memory r = oracle.read(stock, Speed.DAILY);
        assertEq(r.sigmaBps, 5000);
        assertEq(r.skewK, 1200);
        assertEq(r.eventBumpBps, 400);
        assertEq(r.validUntil, p.validUntil);
        assertFalse(r.stale);
        assertEq(oracle.lastNonce(stock, Speed.DAILY), 1);
        // The other speed is independent and untouched.
        assertEq(oracle.read(stock, Speed.WEEKLY).sigmaBps, 0);
        assertTrue(oracle.read(stock, Speed.WEEKLY).stale);
    }

    function test_R1_speedsAreIndependent() public {
        _submit(_post(5000, 1));
        IVolOracle.Post memory w = _post(9000, 1); // different speed: no step from DAILY, nonce space separate
        w.speed = Speed.WEEKLY;
        _submit(w);
        assertEq(oracle.read(stock, Speed.DAILY).sigmaBps, 5000);
        assertEq(oracle.read(stock, Speed.WEEKLY).sigmaBps, 9000);
    }

    // ------------------------------------------------------------------ R2 wrong signer

    function test_R2_wrongSignerRejected() public {
        IVolOracle.Post memory p = _post(5000, 1);
        bytes memory sig = _sign(OTHER_PK, p);
        vm.expectRevert(IVolOracle.BadSignature.selector);
        oracle.post(p, sig);
    }

    function test_R2_malformedSignatureRejected() public {
        IVolOracle.Post memory p = _post(5000, 1);
        bytes memory sig = _sign(SIGNER_PK, p);

        bytes memory short = new bytes(64);
        for (uint256 i; i < 64; ++i) {
            short[i] = sig[i];
        }
        vm.expectRevert(IVolOracle.BadSignature.selector);
        oracle.post(p, short);

        vm.expectRevert(IVolOracle.BadSignature.selector);
        oracle.post(p, "");

        // Malleated twin (s -> n - s, v flipped) recovers the same signer but is rejected as high-s.
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(SIGNER_PK, oracle.hashPost(p));
        bytes memory twin = abi.encodePacked(r, bytes32(SECP256K1_N - uint256(s)), v == 27 ? uint8(28) : uint8(27));
        vm.expectRevert(IVolOracle.BadSignature.selector);
        oracle.post(p, twin);

        oracle.post(p, sig); // the original still works
    }

    // ------------------------------------------------------------------ R3 tampering

    function _expectTamperRejected(IVolOracle.Post memory signed_, IVolOracle.Post memory sent) internal {
        bytes memory sig = _sign(SIGNER_PK, signed_);
        vm.expectRevert(IVolOracle.BadSignature.selector);
        oracle.post(sent, sig);
    }

    function test_R3_tamperedFieldRejected() public {
        IVolOracle.Post memory p = _post(5000, 1);
        p.eventBumpBps = 100;
        p.buyBlockFrom = uint64(T0 + 1 days);
        p.buyBlockTo = uint64(T0 + 2 days);

        IVolOracle.Post memory t;
        t = _copy(p);
        t.stock = makeAddr("otherStock");
        _expectTamperRejected(p, t);
        t = _copy(p);
        t.speed = Speed.WEEKLY;
        _expectTamperRejected(p, t);
        t = _copy(p);
        t.sigmaBps = 5001;
        _expectTamperRejected(p, t);
        t = _copy(p);
        t.skewK = 1201;
        _expectTamperRejected(p, t);
        t = _copy(p);
        t.eventBumpBps = 101;
        _expectTamperRejected(p, t);
        t = _copy(p);
        t.buyBlockFrom = p.buyBlockFrom + 1;
        _expectTamperRejected(p, t);
        t = _copy(p);
        t.buyBlockTo = p.buyBlockTo - 1;
        _expectTamperRejected(p, t);
        t = _copy(p);
        t.validUntil = p.validUntil - 1;
        _expectTamperRejected(p, t);
        t = _copy(p);
        t.nonce = 2;
        _expectTamperRejected(p, t);

        oracle.post(p, _sign(SIGNER_PK, p)); // untampered passes
    }

    function test_R3_otherDomainRejected() public {
        IVolOracle.Post memory p = _post(5000, 1);
        // Signed for a twin deployment (different verifyingContract).
        VolOracle twin = new VolOracle(admin, signerAddr);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(SIGNER_PK, twin.hashPost(p));
        vm.expectRevert(IVolOracle.BadSignature.selector);
        oracle.post(p, abi.encodePacked(r, s, v));

        // Signed on another chain id.
        // (restore a literal: under via_ir, block.chainid read into a local can be re-evaluated after vm.chainId)
        vm.chainId(46630);
        bytes memory sigOther = _sign(SIGNER_PK, p);
        vm.chainId(31337);
        vm.expectRevert(IVolOracle.BadSignature.selector);
        oracle.post(p, sigOther);
    }

    function _copy(IVolOracle.Post memory p) internal pure returns (IVolOracle.Post memory c) {
        c = IVolOracle.Post(
            p.stock, p.speed, p.sigmaBps, p.skewK, p.eventBumpBps, p.buyBlockFrom, p.buyBlockTo, p.validUntil, p.nonce
        );
    }

    // ------------------------------------------------------------------ R4 step limit

    function test_R4_stepLimit() public {
        _submit(_post(4000, 1));
        IVolOracle.Post memory up = _post(5001, 2); // +25.025%
        bytes memory sig = _sign(SIGNER_PK, up);
        vm.expectRevert(abi.encodeWithSelector(IVolOracle.StepTooLarge.selector, uint64(4000), uint64(5001)));
        oracle.post(up, sig);
        _submit(_post(5000, 2)); // exactly +25%
        IVolOracle.Post memory down = _post(3749, 3); // -25.02% from 5000
        sig = _sign(SIGNER_PK, down);
        vm.expectRevert(abi.encodeWithSelector(IVolOracle.StepTooLarge.selector, uint64(5000), uint64(3749)));
        oracle.post(down, sig);
        _submit(_post(3750, 3)); // exactly -25%
    }

    function test_R4_firstPostExemptButFloored() public {
        _submit(_post(60_000, 1)); // no prior: any level above the floor
        assertEq(oracle.read(stock, Speed.DAILY).sigmaBps, 60_000);
    }

    /// @dev Boundary fuzz: exactly +-25% passes, one bp beyond reverts (integer rounding of 25% of the prior).
    function testFuzz_R4_stepLimitBoundary(uint64 prior) public {
        prior = uint64(bound(prior, 3000, 1_000_000));
        _submit(_post(prior, 1));

        uint64 hi = prior + prior / 4; // floor(1.25 prior): largest allowed
        uint64 lo = prior - prior / 4; // smallest allowed is ceil(0.75 prior) = prior - floor(prior/4)

        IVolOracle.Post memory p = _post(hi + 1, 2);
        bytes memory sig = _sign(SIGNER_PK, p);
        vm.expectRevert(abi.encodeWithSelector(IVolOracle.StepTooLarge.selector, prior, hi + 1));
        oracle.post(p, sig);

        if (lo - 1 >= 3000) {
            p = _post(lo - 1, 2);
            sig = _sign(SIGNER_PK, p);
            vm.expectRevert(abi.encodeWithSelector(IVolOracle.StepTooLarge.selector, prior, lo - 1));
            oracle.post(p, sig);
        }

        if (lo >= 3000) {
            _submit(_post(lo, 2));
            assertEq(oracle.read(stock, Speed.DAILY).sigmaBps, lo);
        }

        // The upper edge on the other speed (same prior).
        IVolOracle.Post memory w = _post(prior, 1);
        w.speed = Speed.WEEKLY;
        _submit(w);
        w = _post(hi, 2);
        w.speed = Speed.WEEKLY;
        _submit(w);
        assertEq(oracle.read(stock, Speed.WEEKLY).sigmaBps, hi);
    }

    function testFuzz_R4_anyAcceptedPostWithinStep(uint64 prior, uint64 next) public {
        prior = uint64(bound(prior, 3000, 1_000_000));
        next = uint64(bound(next, 3000, 2_000_000));
        _submit(_post(prior, 1));
        IVolOracle.Post memory p = _post(next, 2);
        bytes memory sig = _sign(SIGNER_PK, p);
        uint256 diff = next > prior ? next - prior : prior - next;
        bool ok = diff * 4 <= prior;
        if (!ok) vm.expectRevert(abi.encodeWithSelector(IVolOracle.StepTooLarge.selector, prior, next));
        oracle.post(p, sig);
        assertEq(oracle.read(stock, Speed.DAILY).sigmaBps, ok ? next : prior);
    }

    /// @dev A floor raised above 125% of the prior must not freeze the name: the step is then measured from the floor.
    function test_R4_floorRaiseAboveStepDoesNotFreeze() public {
        _submit(_post(3000, 1));
        vm.prank(admin);
        oracle.setFloor(stock, 6000);
        _submit(_post(6000, 2)); // +100% vs prior, allowed because the floor is the reference
        IVolOracle.Post memory p = _post(7501, 3);
        bytes memory sig = _sign(SIGNER_PK, p);
        vm.expectRevert(abi.encodeWithSelector(IVolOracle.StepTooLarge.selector, uint64(6000), uint64(7501)));
        oracle.post(p, sig);
    }

    // ------------------------------------------------------------------ R5 floor

    function test_R5_floorEnforced() public {
        assertEq(oracle.floorOf(stock), 3000); // default (mega-cap)
        IVolOracle.Post memory p = _post(2999, 1);
        bytes memory sig = _sign(SIGNER_PK, p);
        vm.expectRevert(abi.encodeWithSelector(IVolOracle.BelowFloor.selector, uint64(2999), uint64(3000)));
        oracle.post(p, sig);
        _submit(_post(3000, 1));

        // Per-stock floor set by admin, below and above the default.
        address index = makeAddr("index");
        vm.prank(admin);
        oracle.setFloor(index, 1200);
        assertEq(oracle.floorOf(index), 1200);
        IVolOracle.Post memory q = _post(1200, 1);
        q.stock = index;
        _submit(q);

        vm.prank(admin);
        oracle.setFloor(stock, 3500);
        p = _post(3400, 2);
        sig = _sign(SIGNER_PK, p);
        vm.expectRevert(abi.encodeWithSelector(IVolOracle.BelowFloor.selector, uint64(3400), uint64(3500)));
        oracle.post(p, sig);
    }

    function test_R5_floorAdminOnlyAndBounded() public {
        bytes32 adminRole = oracle.DEFAULT_ADMIN_ROLE();
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, adminRole)
        );
        oracle.setFloor(stock, 1000);

        vm.startPrank(admin);
        vm.expectRevert(abi.encodeWithSelector(VolOracle.InvalidFloor.selector, uint64(0)));
        oracle.setFloor(stock, 0);
        vm.expectRevert(abi.encodeWithSelector(VolOracle.InvalidFloor.selector, uint64(100_001)));
        oracle.setFloor(stock, 100_001);
        vm.expectEmit(address(oracle));
        emit VolOracle.FloorSet(stock, 100_000);
        oracle.setFloor(stock, 100_000);
        vm.stopPrank();
    }

    // ------------------------------------------------------------------ R6 expiry

    function test_R6_expiryRules() public {
        IVolOracle.Post memory p = _post(5000, 1);
        p.validUntil = uint64(block.timestamp); // not in the future
        bytes memory sig = _sign(SIGNER_PK, p);
        vm.expectRevert(IVolOracle.Expired.selector);
        oracle.post(p, sig);

        p.validUntil = uint64(block.timestamp + 2 hours + 1); // too far ahead
        sig = _sign(SIGNER_PK, p);
        vm.expectRevert(IVolOracle.Expired.selector);
        oracle.post(p, sig);

        p.validUntil = uint64(block.timestamp + 2 hours); // exactly 2h: ok
        _submit(p);

        VolReading memory r = oracle.read(stock, Speed.DAILY);
        assertFalse(r.stale);
        vm.warp(p.validUntil);
        assertFalse(oracle.read(stock, Speed.DAILY).stale); // valid through validUntil
        vm.warp(p.validUntil + 1);
        r = oracle.read(stock, Speed.DAILY);
        assertTrue(r.stale);
        assertEq(r.sigmaBps, 5000); // stale values stay readable
        assertEq(r.skewK, 1200);
    }

    function test_R6_signedPostExpiresInFlight() public {
        IVolOracle.Post memory p = _post(5000, 1);
        bytes memory sig = _sign(SIGNER_PK, p);
        vm.warp(p.validUntil); // landed too late
        vm.expectRevert(IVolOracle.Expired.selector);
        oracle.post(p, sig);
    }

    // ------------------------------------------------------------------ R7 nonce

    function test_R7_nonceReplay() public {
        IVolOracle.Post memory p = _post(5000, 1);
        bytes memory sig = _sign(SIGNER_PK, p);
        oracle.post(p, sig);
        vm.expectRevert(abi.encodeWithSelector(IVolOracle.NonceUsed.selector, uint64(1)));
        oracle.post(p, sig);

        _submit(_post(5100, 5));
        // A lower nonce (an older, delayed post) is rejected even if otherwise valid.
        IVolOracle.Post memory old = _post(5050, 4);
        sig = _sign(SIGNER_PK, old);
        vm.expectRevert(abi.encodeWithSelector(IVolOracle.NonceUsed.selector, uint64(4)));
        oracle.post(old, sig);

        // Nonce 0 is never accepted (nonces start at 1).
        address fresh = makeAddr("fresh");
        IVolOracle.Post memory z = _post(5000, 0);
        z.stock = fresh;
        sig = _sign(SIGNER_PK, z);
        vm.expectRevert(abi.encodeWithSelector(IVolOracle.NonceUsed.selector, uint64(0)));
        oracle.post(z, sig);
    }

    function testFuzz_R7_nonceStrictlyIncreasing(uint64 a, uint64 b) public {
        a = uint64(bound(a, 1, type(uint64).max));
        _submit(_post(5000, a));
        IVolOracle.Post memory p = _post(5000, b);
        bytes memory sig = _sign(SIGNER_PK, p);
        if (b <= a) vm.expectRevert(abi.encodeWithSelector(IVolOracle.NonceUsed.selector, b));
        oracle.post(p, sig);
        assertEq(oracle.lastNonce(stock, Speed.DAILY), b > a ? b : a);
    }

    // ------------------------------------------------------------------ R8 signer rotation

    function test_R8_signerRotationAdminOnly() public {
        address next = vm.addr(OTHER_PK);
        bytes32 adminRole = oracle.DEFAULT_ADMIN_ROLE();
        vm.prank(stranger);
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, adminRole)
        );
        oracle.setSigner(next);

        // A post signed by the old key before the rotation, submitted after it.
        IVolOracle.Post memory p = _post(5000, 1);
        bytes memory oldSig = _sign(SIGNER_PK, p);

        vm.expectEmit(address(oracle));
        emit IVolOracle.SignerSet(next);
        vm.prank(admin);
        oracle.setSigner(next);
        assertEq(oracle.signer(), next);

        vm.expectRevert(IVolOracle.BadSignature.selector);
        oracle.post(p, oldSig);

        oracle.post(p, _sign(OTHER_PK, p)); // the new key works

        vm.prank(admin);
        vm.expectRevert(VolOracle.InvalidSigner.selector);
        oracle.setSigner(address(0));
    }

    function test_R8_constructorChecks() public {
        vm.expectRevert(VolOracle.InvalidAdmin.selector);
        new VolOracle(address(0), signerAddr);
        vm.expectRevert(VolOracle.InvalidSigner.selector);
        new VolOracle(admin, address(0));
    }

    // ------------------------------------------------------------------ R9 buy-block window

    function test_R9_buyBlockWindow() public {
        IVolOracle.Post memory p = _post(5000, 1);
        p.buyBlockFrom = uint64(T0 + 1 days);
        p.buyBlockTo = uint64(T0 + 4 days); // exactly 3 days
        _submit(p);
        VolReading memory r = oracle.read(stock, Speed.DAILY);
        assertEq(r.buyBlockFrom, T0 + 1 days);
        assertEq(r.buyBlockTo, T0 + 4 days);

        IVolOracle.Post memory tooLong = _post(5000, 2);
        tooLong.buyBlockFrom = uint64(T0 + 1 days);
        tooLong.buyBlockTo = uint64(T0 + 4 days + 1);
        bytes memory sig = _sign(SIGNER_PK, tooLong);
        vm.expectRevert(
            abi.encodeWithSelector(VolOracle.BadBuyBlockWindow.selector, tooLong.buyBlockFrom, tooLong.buyBlockTo)
        );
        oracle.post(tooLong, sig);

        IVolOracle.Post memory inverted = _post(5000, 2);
        inverted.buyBlockFrom = uint64(T0 + 2 days);
        inverted.buyBlockTo = uint64(T0 + 1 days);
        sig = _sign(SIGNER_PK, inverted);
        vm.expectRevert(
            abi.encodeWithSelector(VolOracle.BadBuyBlockWindow.selector, inverted.buyBlockFrom, inverted.buyBlockTo)
        );
        oracle.post(inverted, sig);

        // A later post with no window clears it.
        _submit(_post(5000, 2));
        r = oracle.read(stock, Speed.DAILY);
        assertEq(r.buyBlockFrom, 0);
        assertEq(r.buyBlockTo, 0);
    }

    function testFuzz_R9_buyBlockWindow(uint64 from, uint64 to) public {
        IVolOracle.Post memory p = _post(5000, 1);
        p.buyBlockFrom = from;
        p.buyBlockTo = to;
        bytes memory sig = _sign(SIGNER_PK, p);
        bool ok = to >= from && to - from <= 3 days;
        if (!ok) vm.expectRevert(abi.encodeWithSelector(VolOracle.BadBuyBlockWindow.selector, from, to));
        oracle.post(p, sig);
        if (ok) assertEq(oracle.read(stock, Speed.DAILY).buyBlockTo, to);
    }

    // ------------------------------------------------------------------ R10 vector file

    /// @dev test/vectors/volpost-eip712.json is the cross-language fixture for the vol-engine signer. The signer is the
    /// first well-known anvil dev account (SIGNER_PK above); the key itself is not in the JSON.
    function test_R10_vectorFile() public {
        string memory json = vm.readFile("test/vectors/volpost-eip712.json");
        address at = vm.parseJsonAddress(json, ".typedData.domain.verifyingContract");
        vm.chainId(vm.parseJsonUint(json, ".typedData.domain.chainId"));
        vm.warp(vm.parseJsonUint(json, ".blockTimestamp"));

        address expectedSigner = vm.parseJsonAddress(json, ".signer");
        assertEq(expectedSigner, signerAddr, "vector signer is anvil account 0");
        assertEq(vm.parseJsonString(json, ".typedData.domain.name"), "LemniscateVolOracle");
        assertEq(vm.parseJsonString(json, ".typedData.domain.version"), "1");
        deployCodeTo("VolOracle.sol:VolOracle", abi.encode(admin, expectedSigner), at);
        VolOracle o = VolOracle(at);

        IVolOracle.Post memory p = IVolOracle.Post({
            stock: vm.parseJsonAddress(json, ".typedData.message.stock"),
            speed: Speed(uint8(vm.parseJsonUint(json, ".typedData.message.speed"))),
            sigmaBps: uint64(vm.parseJsonUint(json, ".typedData.message.sigmaBps")),
            skewK: uint64(vm.parseJsonUint(json, ".typedData.message.skewK")),
            eventBumpBps: uint64(vm.parseJsonUint(json, ".typedData.message.eventBumpBps")),
            buyBlockFrom: uint64(vm.parseJsonUint(json, ".typedData.message.buyBlockFrom")),
            buyBlockTo: uint64(vm.parseJsonUint(json, ".typedData.message.buyBlockTo")),
            validUntil: uint64(vm.parseJsonUint(json, ".typedData.message.validUntil")),
            nonce: uint64(vm.parseJsonUint(json, ".typedData.message.nonce"))
        });

        assertEq(o.POST_TYPEHASH(), vm.parseJsonBytes32(json, ".typeHash"), "typeHash");
        assertEq(o.domainSeparator(), vm.parseJsonBytes32(json, ".domainSeparator"), "domainSeparator");
        assertEq(o.structHash(p), vm.parseJsonBytes32(json, ".structHash"), "structHash");
        bytes32 digest = o.hashPost(p);
        assertEq(digest, vm.parseJsonBytes32(json, ".digest"), "digest");

        // The stored signature is exactly what the dev key produces (RFC 6979 is deterministic).
        bytes memory sig = vm.parseJsonBytes(json, ".signature");
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(SIGNER_PK, digest);
        assertEq(sig, abi.encodePacked(r, s, v), "signature");

        o.post(p, sig);
        VolReading memory reading = o.read(p.stock, p.speed);
        assertEq(reading.sigmaBps, p.sigmaBps);
        assertEq(reading.buyBlockTo, p.buyBlockTo);
        assertEq(o.lastNonce(p.stock, p.speed), p.nonce);
    }
}
