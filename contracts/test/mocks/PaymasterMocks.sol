// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {PackedUserOperation} from "@openzeppelin/contracts/interfaces/draft-IERC4337.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IPaymasterUnderTest {
    function validatePaymasterUserOp(PackedUserOperation calldata userOp, bytes32 userOpHash, uint256 maxCost)
        external
        returns (bytes memory context, uint256 validationData);
    function postOp(uint8 mode, bytes calldata context, uint256 actualGasCost, uint256 actualUserOpFeePerGas) external;
}

/// @dev A small stand-in for the ERC-4337 v0.7 EntryPoint: deposits, stake, a nonce check, the validation window,
/// paymaster validation, execution on the account and postOp. It is NOT a bundler simulation: it does not enforce
/// ERC-7562 opcode or storage rules (the runbook covers that with the public bundler).
contract MockPaymasterEntryPoint {
    mapping(address => uint256) public balanceOf;
    mapping(address => uint256) public stakeOf;
    mapping(address => uint256) public nonces;
    uint32 public unstakeDelay;
    bool public unlocked;

    error ValidationFailed(uint256 validationData);
    error OutsideWindow();
    error DepositTooLow();
    error BadNonce();

    event Executed(address indexed sender, bool success);

    function depositTo(address account) external payable {
        balanceOf[account] += msg.value;
    }

    function withdrawTo(address payable to, uint256 amount) external {
        balanceOf[msg.sender] -= amount;
        to.transfer(amount);
    }

    function addStake(uint32 delay) external payable {
        stakeOf[msg.sender] += msg.value;
        unstakeDelay = delay;
    }

    function unlockStake() external {
        unlocked = true;
    }

    function withdrawStake(address payable to) external {
        require(unlocked, "not unlocked");
        uint256 s = stakeOf[msg.sender];
        stakeOf[msg.sender] = 0;
        to.transfer(s);
    }

    /// @dev Runs one operation the way handleOps does for a paymaster-sponsored operation.
    function handleOp(address paymaster, PackedUserOperation calldata op, uint256 maxCost, uint256 actualGasCost)
        external
        returns (bool success)
    {
        if (op.nonce != nonces[op.sender]++) revert BadNonce();
        (bytes memory context, uint256 vd) =
            IPaymasterUnderTest(paymaster).validatePaymasterUserOp(op, bytes32(0), maxCost);
        if (vd & ((1 << 160) - 1) != 0) revert ValidationFailed(vd);
        uint48 validUntil = uint48(vd >> 160);
        uint48 validAfter = uint48(vd >> 208);
        if ((validUntil != 0 && block.timestamp > validUntil) || block.timestamp < validAfter) revert OutsideWindow();
        (success,) = op.sender.call(op.callData);
        emit Executed(op.sender, success);
        if (balanceOf[paymaster] < actualGasCost) revert DepositTooLow();
        balanceOf[paymaster] -= actualGasCost;
        IPaymasterUnderTest(paymaster).postOp(success ? 0 : 1, context, actualGasCost, 0);
    }

    /// @dev Validation only, as the bundler's simulation sees it (caller is the EntryPoint).
    function validateOnly(address paymaster, PackedUserOperation calldata op, uint256 maxCost)
        external
        returns (bytes memory context, uint256 validationData)
    {
        return IPaymasterUnderTest(paymaster).validatePaymasterUserOp(op, bytes32(0), maxCost);
    }

    receive() external payable {}
}

/// @dev Kernel-compatible account stub: ERC-7579 `execute(bytes32,bytes)` with single (0x00) and batch (0x01) call types.
contract MockKernelAccount {
    struct Execution {
        address target;
        uint256 value;
        bytes callData;
    }

    function execute(bytes32 mode, bytes calldata execCalldata) external payable {
        bytes1 callType = bytes1(mode);
        if (callType == 0x00) {
            address target = address(bytes20(execCalldata[0:20]));
            uint256 value = uint256(bytes32(execCalldata[20:52]));
            (bool ok, bytes memory ret) = target.call{value: value}(execCalldata[52:]);
            if (!ok) assembly { revert(add(ret, 32), mload(ret)) }
        } else if (callType == 0x01) {
            Execution[] memory calls = abi.decode(execCalldata, (Execution[]));
            for (uint256 i; i < calls.length; ++i) {
                (bool ok, bytes memory ret) = calls[i].target.call{value: calls[i].value}(calls[i].callData);
                if (!ok) assembly { revert(add(ret, 32), mload(ret)) }
            }
        } else {
            revert("unsupported call type");
        }
    }
}

/// @dev Stand-in for the option engine: pulls USDG on buy, takes stock via shield bookkeeping only.
contract MockPaymasterEngine {
    IERC20 public immutable usdg;
    mapping(address => uint256) public bought;
    uint256 public shields;

    constructor(IERC20 usdg_) {
        usdg = usdg_;
    }

    function buy(bytes32, uint256 usdgIn, address recipient) external {
        usdg.transferFrom(msg.sender, address(this), usdgIn);
        bought[recipient] += usdgIn;
    }

    function shield(uint256 usdgIn) external {
        usdg.transferFrom(msg.sender, address(this), usdgIn);
        ++shields;
    }
}

/// @dev A contract the paymaster must refuse to sponsor.
contract MockPaymasterOther {
    uint256 public hits;

    function poke() external {
        ++hits;
    }
}
