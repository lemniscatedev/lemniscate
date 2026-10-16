// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {PackedUserOperation} from "@openzeppelin/contracts/interfaces/draft-IERC4337.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";
import {LemniscatePaymaster} from "../src/LemniscatePaymaster.sol";
import {MockUSDG} from "./mocks/MockUSDG.sol";
import {
    MockPaymasterEntryPoint,
    MockKernelAccount,
    MockPaymasterEngine,
    MockPaymasterOther
} from "./mocks/PaymasterMocks.sol";

interface IRealEntryPoint {
    function getNonce(address sender, uint192 key) external view returns (uint256);
    function balanceOf(address account) external view returns (uint256);
    function getDepositInfo(address account)
        external
        view
        returns (uint256 deposit, bool staked, uint112 stake, uint32 unstakeDelaySec, uint48 withdrawTime);
    function getUserOpHash(PackedUserOperation calldata userOp) external view returns (bytes32);
}

contract PaymasterTest is Test {
    uint256 internal constant T0 = 1_792_200_000; // 2026-10-17 ~00:00 UTC + a little, a fixed day for the caps
    uint256 internal constant MAX_COST = 0.002 ether;
    uint256 internal constant PER_OP = 0.01 ether;
    uint256 internal constant ACCOUNT_CAP = 0.01 ether;
    uint256 internal constant GLOBAL_CAP = 0.03 ether;

    address internal owner = makeAddr("owner");
    address internal stranger = makeAddr("stranger");
    address internal router = makeAddr("agentRouter");
    uint256 internal signerKey = 0xA11CE; // test-key
    address internal signer;

    MockPaymasterEntryPoint internal ep;
    LemniscatePaymaster internal pm;
    MockUSDG internal usdg;
    MockPaymasterEngine internal engine;
    MockKernelAccount internal acct;
    MockKernelAccount internal acct2;
    MockPaymasterOther internal other;

    function setUp() public {
        vm.warp(T0);
        signer = vm.addr(signerKey);
        ep = new MockPaymasterEntryPoint();
        usdg = new MockUSDG();
        engine = new MockPaymasterEngine(usdg);
        other = new MockPaymasterOther();
        acct = new MockKernelAccount();
        acct2 = new MockKernelAccount();
        pm = new LemniscatePaymaster(
            address(ep), owner, signer, address(engine), address(usdg), router, PER_OP, ACCOUNT_CAP, GLOBAL_CAP
        );
        vm.deal(address(this), 100 ether);
        pm.deposit{value: 1 ether}();
        usdg.mint(address(acct), 1_000_000e6);
        usdg.mint(address(acct2), 1_000_000e6);
    }

    // ------------------------------------------------------------------------------------------------ helpers

    function _single(address target, uint256 value, bytes memory data) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(
            bytes4(0xe9ae5c53), bytes32(0), abi.encodePacked(target, value, data)
        );
    }

    function _batch(address[] memory targets, bytes[] memory datas) internal pure returns (bytes memory) {
        MockKernelAccount.Execution[] memory calls = new MockKernelAccount.Execution[](targets.length);
        for (uint256 i; i < targets.length; ++i) {
            calls[i] = MockKernelAccount.Execution(targets[i], 0, datas[i]);
        }
        return abi.encodeWithSelector(bytes4(0xe9ae5c53), bytes32(bytes1(0x01)), abi.encode(calls));
    }

    function _approveBuy(uint256 amount) internal view returns (bytes memory) {
        address[] memory t = new address[](2);
        bytes[] memory d = new bytes[](2);
        t[0] = address(usdg);
        d[0] = abi.encodeCall(usdg.approve, (address(engine), amount));
        t[1] = address(engine);
        d[1] = abi.encodeCall(engine.buy, (bytes32(uint256(1)), amount, address(0xBEEF)));
        return _batch(t, d);
    }

    function _op(address sender, uint256 nonce, bytes memory callData) internal view returns (PackedUserOperation memory op) {
        op.sender = sender;
        op.nonce = nonce;
        op.callData = callData;
        op.accountGasLimits = bytes32(abi.encodePacked(uint128(500_000), uint128(800_000)));
        op.preVerificationGas = 100_000;
        op.gasFees = bytes32(abi.encodePacked(uint128(1 gwei), uint128(2 gwei)));
        op.paymasterAndData = abi.encodePacked(address(pm), uint128(150_000), uint128(60_000), new bytes(77));
        op.signature = hex"";
    }

    function _sign(PackedUserOperation memory op, uint48 validUntil, uint48 validAfter, uint256 key)
        internal
        view
        returns (PackedUserOperation memory)
    {
        bytes32 digest = MessageHashUtils.toEthSignedMessageHash(pm.getHash(op, validUntil, validAfter));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        op.paymasterAndData = abi.encodePacked(address(pm), uint128(150_000), uint128(60_000), validUntil, validAfter, r, s, v);
        return op;
    }

    function _signed(address sender, uint256 nonce, bytes memory callData) internal view returns (PackedUserOperation memory) {
        return _sign(_op(sender, nonce, callData), uint48(block.timestamp + 300), uint48(block.timestamp - 10), signerKey);
    }

    // ------------------------------------------------------------------------------------------------ R3 sponsors our calls

    function test_paymasterSponsorsApproveAndBuyBatch() public {
        PackedUserOperation memory op = _signed(address(acct), 0, _approveBuy(250e6));
        uint256 before = ep.balanceOf(address(pm));
        assertTrue(ep.handleOp(address(pm), op, MAX_COST, 0.0005 ether));
        assertEq(engine.bought(address(0xBEEF)), 250e6);
        assertEq(ep.balanceOf(address(pm)), before - 0.0005 ether);
    }

    function test_paymasterSponsorsSingleEngineCall() public {
        PackedUserOperation memory op =
            _signed(address(acct), 0, _single(address(engine), 0, abi.encodeCall(engine.shield, (5e6))));
        // The account needs an allowance for shield's pull; set it directly (policy is about the sponsored calls).
        vm.prank(address(acct));
        usdg.approve(address(engine), 5e6);
        assertTrue(ep.handleOp(address(pm), op, MAX_COST, 0.0004 ether));
        assertEq(engine.shields(), 1);
    }

    function test_paymasterSponsorsAgentRouterTarget() public {
        vm.etch(router, hex"00");
        PackedUserOperation memory op = _signed(address(acct), 0, _single(router, 0, hex"11223344"));
        (, uint256 vd) = ep.validateOnly(address(pm), op, MAX_COST);
        assertEq(vd & 1, 0);
    }

    function test_paymasterSponsorsApproveToAgentRouter() public {
        PackedUserOperation memory op =
            _signed(address(acct), 0, _single(address(usdg), 0, abi.encodeCall(usdg.approve, (router, 1e6))));
        (, uint256 vd) = ep.validateOnly(address(pm), op, MAX_COST);
        assertEq(vd & 1, 0);
    }

    function test_paymasterRejectsOtherTarget() public {
        PackedUserOperation memory op = _signed(address(acct), 0, _single(address(other), 0, abi.encodeCall(other.poke, ())));
        vm.expectRevert(abi.encodeWithSelector(LemniscatePaymaster.TargetNotAllowed.selector, address(other)));
        ep.validateOnly(address(pm), op, MAX_COST);
    }

    function test_paymasterRejectsBatchWithOneBadCall() public {
        address[] memory t = new address[](2);
        bytes[] memory d = new bytes[](2);
        t[0] = address(engine);
        d[0] = abi.encodeCall(engine.shield, (1e6));
        t[1] = address(other);
        d[1] = abi.encodeCall(other.poke, ());
        PackedUserOperation memory op = _signed(address(acct), 0, _batch(t, d));
        vm.expectRevert(abi.encodeWithSelector(LemniscatePaymaster.TargetNotAllowed.selector, address(other)));
        ep.validateOnly(address(pm), op, MAX_COST);
    }

    function test_paymasterRejectsUsdgApproveToStranger() public {
        PackedUserOperation memory op =
            _signed(address(acct), 0, _single(address(usdg), 0, abi.encodeCall(usdg.approve, (stranger, 1e6))));
        vm.expectRevert(abi.encodeWithSelector(LemniscatePaymaster.ApproveNotAllowed.selector, stranger));
        ep.validateOnly(address(pm), op, MAX_COST);
    }

    function test_paymasterRejectsUsdgTransfer() public {
        PackedUserOperation memory op =
            _signed(address(acct), 0, _single(address(usdg), 0, abi.encodeCall(usdg.transfer, (stranger, 1e6))));
        vm.expectRevert(abi.encodeWithSelector(LemniscatePaymaster.TargetNotAllowed.selector, address(usdg)));
        ep.validateOnly(address(pm), op, MAX_COST);
    }

    function test_paymasterRejectsUsdgApproveWithTrailingBytes() public {
        bytes memory data = abi.encodePacked(abi.encodeCall(usdg.approve, (address(engine), 1e6)), hex"00");
        PackedUserOperation memory op = _signed(address(acct), 0, _single(address(usdg), 0, data));
        vm.expectRevert(LemniscatePaymaster.UnsupportedCallData.selector);
        ep.validateOnly(address(pm), op, MAX_COST);
    }

    function test_paymasterRejectsValue() public {
        PackedUserOperation memory op =
            _signed(address(acct), 0, _single(address(engine), 1, abi.encodeCall(engine.shield, (1e6))));
        vm.expectRevert(LemniscatePaymaster.ValueNotAllowed.selector);
        ep.validateOnly(address(pm), op, MAX_COST);
    }

    function test_paymasterRejectsDelegatecallMode() public {
        bytes memory cd = abi.encodeWithSelector(
            bytes4(0xe9ae5c53), bytes32(bytes1(0xff)), abi.encodePacked(address(engine), uint256(0), hex"11223344")
        );
        PackedUserOperation memory op = _signed(address(acct), 0, cd);
        vm.expectRevert(LemniscatePaymaster.UnsupportedCallData.selector);
        ep.validateOnly(address(pm), op, MAX_COST);
    }

    function test_paymasterRejectsOtherSelectorAndTooManyCalls() public {
        PackedUserOperation memory op = _signed(address(acct), 0, abi.encodeWithSelector(bytes4(0x12345678), bytes32(0), hex"00"));
        vm.expectRevert(LemniscatePaymaster.UnsupportedCallData.selector);
        ep.validateOnly(address(pm), op, MAX_COST);

        address[] memory t = new address[](5);
        bytes[] memory d = new bytes[](5);
        for (uint256 i; i < 5; ++i) {
            t[i] = address(engine);
            d[i] = abi.encodeCall(engine.shield, (1));
        }
        op = _signed(address(acct), 0, _batch(t, d));
        vm.expectRevert(LemniscatePaymaster.TooManyCalls.selector);
        ep.validateOnly(address(pm), op, MAX_COST);
    }

    function test_paymasterRejectsEmptyBatch() public {
        PackedUserOperation memory op = _signed(address(acct), 0, _batch(new address[](0), new bytes[](0)));
        vm.expectRevert(LemniscatePaymaster.TooManyCalls.selector);
        ep.validateOnly(address(pm), op, MAX_COST);
    }

    function test_paymasterWithoutRouterOnlyAllowsEngine() public {
        LemniscatePaymaster p2 = new LemniscatePaymaster(
            address(ep), owner, signer, address(engine), address(usdg), address(0), PER_OP, ACCOUNT_CAP, GLOBAL_CAP
        );
        PackedUserOperation memory op = _op(address(acct), 0, _single(address(0), 0, hex"11223344"));
        op.paymasterAndData = abi.encodePacked(address(p2), uint128(150_000), uint128(60_000), new bytes(77));
        bytes32 digest = MessageHashUtils.toEthSignedMessageHash(p2.getHash(op, uint48(T0 + 300), uint48(T0 - 10)));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerKey, digest);
        op.paymasterAndData =
            abi.encodePacked(address(p2), uint128(150_000), uint128(60_000), uint48(T0 + 300), uint48(T0 - 10), r, s, v);
        vm.expectRevert(abi.encodeWithSelector(LemniscatePaymaster.TargetNotAllowed.selector, address(0)));
        ep.validateOnly(address(p2), op, MAX_COST);
    }

    // ------------------------------------------------------------------------------------------------ signature binding

    function test_paymasterRejectsWrongSigner() public {
        PackedUserOperation memory op = _sign(_op(address(acct), 0, _approveBuy(1e6)), uint48(T0 + 300), uint48(T0 - 10), 0xBAD);
        vm.expectRevert(abi.encodeWithSelector(MockPaymasterEntryPoint.ValidationFailed.selector, uint256(1) | (uint256(T0 + 300) << 160) | (uint256(T0 - 10) << 208)));
        ep.handleOp(address(pm), op, MAX_COST, 0);
    }

    function test_paymasterSignatureCoversEveryField() public {
        PackedUserOperation memory good = _signed(address(acct), 3, _approveBuy(1e6));
        (, uint256 vd) = ep.validateOnly(address(pm), good, MAX_COST);
        assertEq(vd & 1, 0, "baseline valid");

        PackedUserOperation memory t = _signed(address(acct), 3, _approveBuy(1e6));
        t.sender = address(acct2);
        _assertSigFails(t);
        t = _signed(address(acct), 3, _approveBuy(1e6));
        t.nonce = 4;
        _assertSigFails(t);
        t = _signed(address(acct), 3, _approveBuy(1e6));
        t.callData = _approveBuy(2e6);
        _assertSigFails(t);
        t = _signed(address(acct), 3, _approveBuy(1e6));
        t.initCode = hex"11";
        _assertSigFails(t);
        t = _signed(address(acct), 3, _approveBuy(1e6));
        t.accountGasLimits = bytes32(uint256(1));
        _assertSigFails(t);
        t = _signed(address(acct), 3, _approveBuy(1e6));
        t.preVerificationGas += 1;
        _assertSigFails(t);
        t = _signed(address(acct), 3, _approveBuy(1e6));
        t.gasFees = bytes32(uint256(7));
        _assertSigFails(t);
        t = _signed(address(acct), 3, _approveBuy(1e6));
        // change paymaster gas limits (bytes 20..52)
        bytes memory pd = t.paymasterAndData;
        pd[40] = 0x01;
        t.paymasterAndData = pd;
        _assertSigFails(t);
        t = _signed(address(acct), 3, _approveBuy(1e6));
        // change validUntil (bytes 52..58): signature no longer matches
        pd = t.paymasterAndData;
        pd[57] = bytes1(uint8(pd[57]) ^ 0x01);
        t.paymasterAndData = pd;
        _assertSigFails(t);
        t = _signed(address(acct), 3, _approveBuy(1e6));
        // account signature is NOT covered: the user signs after the sponsor
        t.signature = hex"deadbeef";
        (, vd) = ep.validateOnly(address(pm), t, MAX_COST);
        assertEq(vd & 1, 0, "account signature free");
    }

    function _assertSigFails(PackedUserOperation memory op) internal {
        (, uint256 vd) = ep.validateOnly(address(pm), op, MAX_COST);
        assertEq(vd & 1, 1, "tamper not detected");
    }

    function test_paymasterSignatureBoundToChainAndPaymaster() public {
        PackedUserOperation memory op = _op(address(acct), 0, _approveBuy(1e6));
        bytes32 h1 = pm.getHash(op, uint48(T0 + 300), uint48(T0));
        vm.chainId(999);
        bytes32 h2 = pm.getHash(op, uint48(T0 + 300), uint48(T0));
        assertTrue(h1 != h2, "chain id not in hash");
        vm.chainId(31337);
        LemniscatePaymaster p2 = new LemniscatePaymaster(
            address(ep), owner, signer, address(engine), address(usdg), router, PER_OP, ACCOUNT_CAP, GLOBAL_CAP
        );
        assertTrue(p2.getHash(op, uint48(T0 + 300), uint48(T0)) != pm.getHash(op, uint48(T0 + 300), uint48(T0)), "paymaster not in hash");
    }

    function test_paymasterReplayBlockedByNonce() public {
        PackedUserOperation memory op = _signed(address(acct), 0, _approveBuy(1e6));
        ep.handleOp(address(pm), op, MAX_COST, 0.0001 ether);
        vm.expectRevert(MockPaymasterEntryPoint.BadNonce.selector);
        ep.handleOp(address(pm), op, MAX_COST, 0.0001 ether);
    }

    function test_paymasterEnforcesValidityWindow() public {
        PackedUserOperation memory op = _signed(address(acct), 0, _approveBuy(1e6));
        vm.warp(T0 + 301);
        vm.expectRevert(MockPaymasterEntryPoint.OutsideWindow.selector);
        ep.handleOp(address(pm), op, MAX_COST, 0);
    }

    function test_paymasterRejectsUnboundedOrBadWindows() public {
        PackedUserOperation memory op = _sign(_op(address(acct), 0, _approveBuy(1e6)), 0, 0, signerKey);
        vm.expectRevert(LemniscatePaymaster.BadValidityWindow.selector);
        ep.validateOnly(address(pm), op, MAX_COST);
        op = _sign(_op(address(acct), 0, _approveBuy(1e6)), uint48(T0 + 2 hours), uint48(T0), signerKey);
        vm.expectRevert(LemniscatePaymaster.BadValidityWindow.selector);
        ep.validateOnly(address(pm), op, MAX_COST);
        op = _sign(_op(address(acct), 0, _approveBuy(1e6)), uint48(T0), uint48(T0 + 5), signerKey);
        vm.expectRevert(LemniscatePaymaster.BadValidityWindow.selector);
        ep.validateOnly(address(pm), op, MAX_COST);
    }

    function test_paymasterRejectsBadPaymasterDataLength() public {
        PackedUserOperation memory op = _signed(address(acct), 0, _approveBuy(1e6));
        op.paymasterAndData = abi.encodePacked(op.paymasterAndData, hex"00");
        vm.expectRevert(LemniscatePaymaster.BadPaymasterData.selector);
        ep.validateOnly(address(pm), op, MAX_COST);
    }

    function test_paymasterRejectsMalformedSignature() public {
        PackedUserOperation memory op = _signed(address(acct), 0, _approveBuy(1e6));
        for (uint256 i = 64; i < 129; ++i) {
            op.paymasterAndData[i] = 0x00;
        }
        (, uint256 vd) = ep.validateOnly(address(pm), op, MAX_COST);
        assertEq(vd & 1, 1);
    }

    function test_paymasterOnlyEntryPointCanCallHooks() public {
        PackedUserOperation memory op = _signed(address(acct), 0, _approveBuy(1e6));
        vm.expectRevert(LemniscatePaymaster.NotEntryPoint.selector);
        pm.validatePaymasterUserOp(op, bytes32(0), MAX_COST);
        vm.expectRevert(LemniscatePaymaster.NotEntryPoint.selector);
        pm.postOp(LemniscatePaymaster.PostOpMode.opSucceeded, abi.encode(address(acct), uint64(1), uint256(1)), 0, 0);
    }

    // ------------------------------------------------------------------------------------------------ caps

    function test_paymasterEnforcesMaxCostPerOp() public {
        PackedUserOperation memory op = _signed(address(acct), 0, _approveBuy(1e6));
        vm.expectRevert(abi.encodeWithSelector(LemniscatePaymaster.MaxCostPerOpExceeded.selector, PER_OP + 1, PER_OP));
        ep.validateOnly(address(pm), op, PER_OP + 1);
    }

    function test_paymasterEnforcesPerAccountDailyCap() public {
        // 0.01 ether per account per day: five 0.002 ether reservations fit (no refund because actual == reserved).
        for (uint256 i; i < 5; ++i) {
            ep.handleOp(address(pm), _signed(address(acct), i, _approveBuy(1e6)), MAX_COST, MAX_COST);
        }
        PackedUserOperation memory op = _signed(address(acct), 5, _approveBuy(1e6));
        vm.expectRevert(
            abi.encodeWithSelector(LemniscatePaymaster.AccountDailyCapExceeded.selector, address(acct), 6 * MAX_COST, ACCOUNT_CAP)
        );
        ep.handleOp(address(pm), op, MAX_COST, 0);
        // Another account is unaffected.
        assertTrue(ep.handleOp(address(pm), _signed(address(acct2), 0, _approveBuy(1e6)), MAX_COST, MAX_COST));
    }

    function test_paymasterDailyCapResetsNextDay() public {
        for (uint256 i; i < 5; ++i) {
            ep.handleOp(address(pm), _signed(address(acct), i, _approveBuy(1e6)), MAX_COST, MAX_COST);
        }
        vm.warp(T0 + 1 days);
        assertTrue(ep.handleOp(address(pm), _signed(address(acct), 5, _approveBuy(1e6)), MAX_COST, MAX_COST));
        (uint64 day, uint192 spent) = pm.accountUsage(address(acct));
        assertEq(day, (T0 + 1 days + 300) / 1 days);
        assertEq(spent, MAX_COST);
    }

    function test_paymasterEnforcesGlobalDailyCap() public {
        // global 0.03: 15 reservations of 0.002 across 3 accounts of cap 0.01 each; use fresh accounts.
        uint256 n;
        for (uint256 a; a < 3; ++a) {
            MockKernelAccount x = new MockKernelAccount();
            for (uint256 i; i < 5; ++i) {
                ep.handleOp(address(pm), _signed(address(x), i, _single(address(engine), 0, hex"11223344")), MAX_COST, MAX_COST);
                ++n;
            }
        }
        assertEq(n, 15);
        MockKernelAccount y = new MockKernelAccount();
        PackedUserOperation memory op = _signed(address(y), 0, _single(address(engine), 0, hex"11223344"));
        vm.expectRevert(abi.encodeWithSelector(LemniscatePaymaster.GlobalDailyCapExceeded.selector, 16 * MAX_COST, GLOBAL_CAP));
        ep.validateOnly(address(pm), op, MAX_COST);
    }

    function test_paymasterPostOpRefundsUnusedReservation() public {
        ep.handleOp(address(pm), _signed(address(acct), 0, _approveBuy(1e6)), MAX_COST, 0.0005 ether);
        (, uint192 spent) = pm.accountUsage(address(acct));
        (, uint192 gspent) = pm.globalUsage();
        assertEq(spent, 0.0005 ether);
        assertEq(gspent, 0.0005 ether);
        // The refund lets many small operations through where reserving the maximum each time would not.
        for (uint256 i = 1; i < 9; ++i) {
            ep.handleOp(address(pm), _signed(address(acct), i, _approveBuy(1e6)), MAX_COST, 0.0005 ether);
        }
        (, spent) = pm.accountUsage(address(acct));
        assertEq(spent, 9 * 0.0005 ether);
    }

    function testFuzz_paymasterCapsNeverExceeded(uint256[8] memory costs, uint256[8] memory actuals) public {
        for (uint256 i; i < 8; ++i) {
            uint256 c = bound(costs[i], 1, PER_OP);
            uint256 act = bound(actuals[i], 0, c);
            PackedUserOperation memory op = _signed(address(acct), i, _approveBuy(1e6));
            try ep.handleOp(address(pm), op, c, act) {} catch {}
            (, uint192 s) = pm.accountUsage(address(acct));
            (, uint192 g) = pm.globalUsage();
            assertLe(s, ACCOUNT_CAP);
            assertLe(g, GLOBAL_CAP);
        }
    }

    function testFuzz_paymasterRandomCallDataNeverSponsored(bytes memory junk) public {
        PackedUserOperation memory op = _signed(address(acct), 0, junk);
        try ep.validateOnly(address(pm), op, MAX_COST) returns (bytes memory, uint256) {
            revert("sponsored junk");
        } catch {}
    }

    function testFuzz_paymasterNoOtherTargetSponsored(address target, bytes memory data) public {
        vm.assume(target != address(engine) && target != address(usdg) && target != router);
        PackedUserOperation memory op = _signed(address(acct), 0, _single(target, 0, data));
        vm.expectRevert();
        ep.validateOnly(address(pm), op, MAX_COST);
    }

    // ------------------------------------------------------------------------------------------------ admin and funding

    function test_paymasterPausedBlocksSponsorship() public {
        vm.prank(owner);
        pm.setPaused(true);
        PackedUserOperation memory op = _signed(address(acct), 0, _approveBuy(1e6));
        vm.expectRevert(LemniscatePaymaster.PausedError.selector);
        ep.validateOnly(address(pm), op, MAX_COST);
    }

    function test_paymasterAdminOnlyOwner() public {
        vm.startPrank(stranger);
        vm.expectRevert();
        pm.setSigner(stranger);
        vm.expectRevert();
        pm.setLimits(1, 1, 1);
        vm.expectRevert();
        pm.setPaused(true);
        vm.expectRevert();
        pm.withdrawTo(payable(stranger), 1);
        vm.expectRevert();
        pm.addStake(1);
        vm.expectRevert();
        pm.unlockStake();
        vm.expectRevert();
        pm.withdrawStake(payable(stranger));
        vm.stopPrank();
    }

    function test_paymasterSignerRotation() public {
        PackedUserOperation memory op = _signed(address(acct), 0, _approveBuy(1e6));
        vm.prank(owner);
        pm.setSigner(makeAddr("newSigner"));
        (, uint256 vd) = ep.validateOnly(address(pm), op, MAX_COST);
        assertEq(vd & 1, 1, "old signer must stop working");
    }

    function test_paymasterDepositWithdrawAndStake() public {
        uint256 dep = pm.depositBalance();
        pm.deposit{value: 2 ether}();
        (bool ok,) = address(pm).call{value: 1 ether}("");
        assertTrue(ok);
        assertEq(pm.depositBalance(), dep + 3 ether);

        address payable to = payable(makeAddr("treasury"));
        vm.prank(owner);
        pm.withdrawTo(to, 1 ether);
        assertEq(to.balance, 1 ether);
        assertEq(pm.depositBalance(), dep + 2 ether);

        vm.deal(owner, 1 ether);
        vm.startPrank(owner);
        pm.addStake{value: 0.5 ether}(1 days);
        pm.unlockStake();
        pm.withdrawStake(to);
        vm.stopPrank();
        assertEq(to.balance, 1.5 ether);
    }

    function test_paymasterTwoStepOwnership() public {
        vm.prank(owner);
        pm.transferOwnership(stranger);
        assertEq(pm.owner(), owner);
        vm.prank(stranger);
        pm.acceptOwnership();
        assertEq(pm.owner(), stranger);
    }

    function test_paymasterConstructorRejectsZero() public {
        vm.expectRevert(LemniscatePaymaster.ZeroAddress.selector);
        new LemniscatePaymaster(address(0), owner, signer, address(engine), address(usdg), router, 1, 1, 1);
        vm.expectRevert(LemniscatePaymaster.ZeroAddress.selector);
        new LemniscatePaymaster(address(ep), owner, address(0), address(engine), address(usdg), router, 1, 1, 1);
        vm.expectRevert(LemniscatePaymaster.ZeroAddress.selector);
        new LemniscatePaymaster(address(ep), owner, signer, address(0), address(usdg), router, 1, 1, 1);
        vm.expectRevert(LemniscatePaymaster.ZeroAddress.selector);
        new LemniscatePaymaster(address(ep), owner, signer, address(engine), address(0), router, 1, 1, 1);
    }

    // ------------------------------------------------------------------------------------------------ cross-language vector

    /// @dev The same inputs are hashed by app/src/aa/paymaster.test.ts; both must give VECTOR_HASH.
    function test_paymasterHashMatchesTypescriptVector() public {
        vm.chainId(4663);
        address pmAddr = 0x2222222222222222222222222222222222222222;
        deployCodeTo(
            "LemniscatePaymaster.sol:LemniscatePaymaster",
            abi.encode(
                address(ep), owner, signer, address(engine), address(usdg), address(0), PER_OP, ACCOUNT_CAP, GLOBAL_CAP
            ),
            pmAddr
        );
        PackedUserOperation memory op;
        op.sender = address(0x1111111111111111111111111111111111111111);
        op.nonce = 7;
        op.callData = hex"e9ae5c53";
        op.accountGasLimits = bytes32(abi.encodePacked(uint128(500_000), uint128(800_000)));
        op.preVerificationGas = 100_000;
        op.gasFees = bytes32(abi.encodePacked(uint128(1 gwei), uint128(2 gwei)));
        op.paymasterAndData = abi.encodePacked(pmAddr, uint128(150_000), uint128(60_000), new bytes(77));
        bytes32 h = LemniscatePaymaster(payable(pmAddr)).getHash(op, uint48(1_792_200_300), uint48(1_792_200_000));
        assertEq(h, VECTOR_HASH);
    }

    bytes32 internal constant VECTOR_HASH = 0x4382ba3bdadbf1cf33cc5db4dbf465b897fb8311ae09f899c24ea3f7381e598e; // not-a-key
}

/// @notice Optional: runs against the REAL EntryPoint v0.7 on a fork (read-only RPC; nothing is broadcast).
/// Skipped when FORK_RPC_URL is unset. Example: FORK_RPC_URL=https://rpc.mainnet.chain.robinhood.com forge test --match-contract PaymasterForkTest
contract PaymasterForkTest is Test {
    address internal constant ENTRY_POINT = 0x0000000071727De22E5E9d8BAf0edAc6f37da032;

    function test_forkPaymasterAgainstRealEntryPoint() public {
        string memory url = vm.envOr("FORK_RPC_URL", string(""));
        if (bytes(url).length == 0) {
            vm.skip(true);
            return;
        }
        vm.createSelectFork(url);
        require(ENTRY_POINT.code.length > 0, "no EntryPoint on this chain");

        address owner = makeAddr("owner");
        uint256 signerKey = 0xA11CE; // test-key
        address engine = makeAddr("engine");
        address usdg = makeAddr("usdg");
        LemniscatePaymaster pm = new LemniscatePaymaster(
            ENTRY_POINT, owner, vm.addr(signerKey), engine, usdg, address(0), 0.01 ether, 0.01 ether, 0.05 ether
        );

        // Funding and staking go through the real EntryPoint's accounting.
        vm.deal(address(this), 10 ether);
        pm.deposit{value: 1 ether}();
        assertEq(IRealEntryPoint(ENTRY_POINT).balanceOf(address(pm)), 1 ether);
        assertEq(pm.depositBalance(), 1 ether);
        vm.deal(owner, 1 ether);
        vm.prank(owner);
        pm.addStake{value: 0.1 ether}(1 days);
        (uint256 dep, bool staked, uint112 stake, uint32 delay,) = IRealEntryPoint(ENTRY_POINT).getDepositInfo(address(pm));
        assertEq(dep, 1 ether);
        assertTrue(staked);
        assertEq(stake, 0.1 ether);
        assertEq(delay, 1 days);

        // A sponsor-signed operation validates when the real EntryPoint calls the hook.
        PackedUserOperation memory op;
        op.sender = makeAddr("kernel");
        op.nonce = IRealEntryPoint(ENTRY_POINT).getNonce(op.sender, 0);
        op.callData = abi.encodeWithSelector(
            bytes4(0xe9ae5c53), bytes32(0), abi.encodePacked(engine, uint256(0), hex"11223344")
        );
        op.accountGasLimits = bytes32(abi.encodePacked(uint128(500_000), uint128(800_000)));
        op.preVerificationGas = 100_000;
        op.gasFees = bytes32(abi.encodePacked(uint128(1 gwei), uint128(2 gwei)));
        uint48 validUntil = uint48(block.timestamp + 300);
        uint48 validAfter = uint48(block.timestamp - 10);
        op.paymasterAndData = abi.encodePacked(address(pm), uint128(150_000), uint128(60_000), new bytes(77));
        bytes32 digest = MessageHashUtils.toEthSignedMessageHash(pm.getHash(op, validUntil, validAfter));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerKey, digest);
        op.paymasterAndData =
            abi.encodePacked(address(pm), uint128(150_000), uint128(60_000), validUntil, validAfter, r, s, v);
        // The real EntryPoint's userOpHash is computable for our packed operation (smoke check of struct layout).
        assertTrue(IRealEntryPoint(ENTRY_POINT).getUserOpHash(op) != bytes32(0));
        vm.prank(ENTRY_POINT);
        (, uint256 vd) = pm.validatePaymasterUserOp(op, bytes32(0), 0.002 ether);
        assertEq(vd & 1, 0, "sponsor signature must verify");

        vm.prank(owner);
        pm.withdrawTo(payable(owner), 1 ether);
        assertEq(owner.balance, 1 ether + 0.9 ether);
    }
}
