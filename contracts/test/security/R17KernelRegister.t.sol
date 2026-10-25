// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {LemniscatePaymaster} from "../../src/LemniscatePaymaster.sol";
import {MockUSDG} from "../mocks/MockUSDG.sol";
import {MockPaymasterEntryPoint, MockPaymasterEngine} from "../mocks/PaymasterMocks.sol";

/// @dev A stand-in account deployed by the factory below.
contract StubKernel {
    bytes public init;

    constructor(bytes memory init_) {
        init = init_;
    }
}

/// @dev Kernel-factory stand-in: permissionless createAccount, CREATE2 over (initData, salt) like KernelFactory v3.3.
contract MockKernelFactory {
    function _salt(bytes calldata data, bytes32 salt) private pure returns (bytes32) {
        return keccak256(abi.encodePacked(data, salt));
    }

    function getAddress(bytes calldata data, bytes32 salt) external view returns (address) {
        bytes32 h = keccak256(abi.encodePacked(type(StubKernel).creationCode, abi.encode(data)));
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), _salt(data, salt), h)))));
    }

    function createAccount(bytes calldata data, bytes32 salt) external returns (address) {
        return address(new StubKernel{salt: _salt(data, salt)}(data));
    }
}

/// @notice Round-2 review R17 (LOW): only a sponsored deploy or the Safe could register a Kernel account, and
/// KernelFactory.createAccount is permissionless with public inputs, so a stranger could deploy any user's account
/// first and make it unsponsorable until a Safe transaction per account. registerKernelAccount now lets anyone prove a
/// deployed account is the factory's standard setup.
contract R17KernelRegisterTest is Test {
    MockKernelFactory internal factory;
    LemniscatePaymaster internal pm;
    address internal pmOwner = makeAddr("pmOwner");
    address internal mallory = makeAddr("mallory");

    function setUp() public {
        factory = new MockKernelFactory();
        MockUSDG usdg = new MockUSDG();
        pm = new LemniscatePaymaster(
            address(new MockPaymasterEntryPoint()),
            pmOwner,
            makeAddr("signer"),
            address(new MockPaymasterEngine(usdg)),
            address(usdg),
            address(0),
            address(factory),
            0.01 ether,
            0.01 ether,
            0.03 ether
        );
    }

    function _init(address validator, address hook, bytes memory vData, bytes memory hData, uint256 cfg)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encodeWithSignature(
            "initialize(bytes21,address,bytes,bytes,bytes[])",
            bytes21(abi.encodePacked(bytes1(0x01), validator)),
            hook,
            vData,
            hData,
            new bytes[](cfg)
        );
    }

    function _standard(address owner) internal view returns (bytes memory) {
        return _init(pm.ECDSA_VALIDATOR(), address(1), abi.encodePacked(owner), "", 0);
    }

    /// @dev Reviewer PoC: mallory deploys a user's counterfactual account through the public factory before the user's
    /// first sponsored op. Anyone can now register it, and it is sponsorable.
    function test_R17_strangerDeployedAccountCanBeRegistered() public {
        address user = makeAddr("user");
        bytes memory init = _standard(user);
        vm.prank(mallory);
        address acct = factory.createAccount(init, bytes32(0));
        assertFalse(pm.kernelAccount(acct));
        pm.registerKernelAccount(acct, init, bytes32(0));
        assertTrue(pm.kernelAccount(acct));
    }

    /// @dev Non-standard setups (another validator, a hook, hook data, init config, a bad owner field), a wrong salt
    /// and an undeployed address are refused.
    function test_R17_onlyTheStandardDeployedSetupRegisters() public {
        address user = makeAddr("user");
        bytes memory bad1 = _init(makeAddr("otherValidator"), address(1), abi.encodePacked(user), "", 0);
        bytes memory bad2 = _init(pm.ECDSA_VALIDATOR(), makeAddr("hook"), abi.encodePacked(user), "", 0);
        bytes memory bad3 = _init(pm.ECDSA_VALIDATOR(), address(1), abi.encodePacked(user), hex"01", 0);
        bytes memory bad4 = _init(pm.ECDSA_VALIDATOR(), address(1), abi.encodePacked(user), "", 1);
        bytes memory bad5 = _init(pm.ECDSA_VALIDATOR(), address(1), abi.encodePacked(user, uint8(1)), "", 0);
        bytes[5] memory bad = [bad1, bad2, bad3, bad4, bad5];
        for (uint256 i; i < bad.length; ++i) {
            address a = factory.createAccount(bad[i], bytes32(0));
            vm.expectRevert(LemniscatePaymaster.NotStandardAccount.selector);
            pm.registerKernelAccount(a, bad[i], bytes32(0));
        }
        bytes memory init = _standard(user);
        address predicted = factory.getAddress(init, bytes32(uint256(7)));
        vm.expectRevert(abi.encodeWithSelector(LemniscatePaymaster.UnknownAccount.selector, predicted));
        pm.registerKernelAccount(predicted, init, bytes32(uint256(7))); // not deployed yet
        address acct = factory.createAccount(init, bytes32(uint256(7)));
        vm.expectRevert(abi.encodeWithSelector(LemniscatePaymaster.UnknownAccount.selector, acct));
        pm.registerKernelAccount(acct, init, bytes32(0)); // wrong salt
    }

    /// @dev PROPERTY: whether a standard account is sponsorable depends only on its deployed code and init data, never
    /// on who deployed it: for any (owner, index, deployer), deploying through the factory and registering gives
    /// kernelAccount == true.
    function testFuzz_R17_sponsorableWhoeverDeployed(address owner, uint64 index, address deployer, address caller)
        public
    {
        vm.assume(deployer != address(0) && caller != address(0));
        bytes memory init = _standard(owner);
        vm.prank(deployer);
        address acct = factory.createAccount(init, bytes32(uint256(index)));
        vm.prank(caller);
        pm.registerKernelAccount(acct, init, bytes32(uint256(index)));
        assertTrue(pm.kernelAccount(acct));
    }
}
