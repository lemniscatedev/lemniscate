// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {PackedUserOperation} from "@openzeppelin/contracts/interfaces/draft-IERC4337.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

/// @dev The slice of the ERC-4337 v0.7 EntryPoint the paymaster uses.
interface IPaymasterEntryPoint {
    function depositTo(address account) external payable;
    function withdrawTo(address payable withdrawAddress, uint256 amount) external;
    function addStake(uint32 unstakeDelaySec) external payable;
    function unlockStake() external;
    function withdrawStake(address payable withdrawAddress) external;
    function balanceOf(address account) external view returns (uint256);
}

/// @title LemniscatePaymaster
/// @notice Verifying paymaster for ERC-4337 EntryPoint v0.7. It pays gas only for user operations that
/// (1) carry a signature from the sponsoring signer, (2) call nothing but the option engine, the agent router,
/// or a USDG `approve` whose spender is one of those two, with zero value, and (3) stay inside per-operation,
/// per-account-per-day and global-per-day gas caps.
/// @dev Validation obeys the ERC-7562 storage and opcode rules: no `block.timestamp` (the day bucket comes from the
/// signed `validUntil`), per-account state is one struct in a mapping keyed by the sender, and the engine, USDG and
/// router addresses are immutable. The global cap lives in plain storage, so the paymaster must be staked in the
/// EntryPoint (`addStake`) for public bundlers to accept it. Callers cannot choose the day: it is covered by the signature.
///
/// paymasterAndData = paymaster (20) | verificationGasLimit (16) | postOpGasLimit (16) | validUntil (6) | validAfter (6) | signature (65).
/// The signature is an EIP-191 personal signature by `signer` over `getHash(userOp, validUntil, validAfter)`.
contract LemniscatePaymaster is Ownable2Step {
    enum PostOpMode {
        opSucceeded,
        opReverted,
        postOpReverted
    }

    struct Execution {
        address target;
        uint256 value;
        bytes callData;
    }

    struct Usage {
        uint64 day;
        uint192 spent;
    }

    uint256 public constant PAYMASTER_DATA_OFFSET = 52;
    uint256 public constant PAYMASTER_DATA_LENGTH = 77; // validUntil 6 + validAfter 6 + signature 65
    uint256 public constant MAX_VALIDITY_WINDOW = 1 hours;
    uint256 public constant MAX_CALLS = 4;
    /// @dev Kernel / ERC-7579 `execute(bytes32,bytes)`.
    bytes4 private constant EXECUTE = 0xe9ae5c53;
    bytes4 private constant APPROVE = 0x095ea7b3;

    IPaymasterEntryPoint public immutable ENTRY_POINT;
    address public immutable ENGINE;
    address public immutable USDG;
    /// @dev Zero when no router is deployed yet; then only the engine is a valid target.
    address public immutable AGENT_ROUTER;

    address public signer;
    bool public paused;
    /// @dev All caps are in wei of the chain's gas token and are checked against the EntryPoint's `maxCost`.
    uint256 public maxCostPerOp;
    uint256 public accountDailyCap;
    uint256 public globalDailyCap;

    Usage public globalUsage;
    mapping(address account => Usage) public accountUsage;

    event SignerChanged(address indexed signer);
    event LimitsChanged(uint256 maxCostPerOp, uint256 accountDailyCap, uint256 globalDailyCap);
    event PausedChanged(bool paused);
    event Sponsored(address indexed account, uint256 indexed day, uint256 reservedCost);
    event Refunded(address indexed account, uint256 indexed day, uint256 amount);

    error NotEntryPoint();
    error PausedError();
    error ZeroAddress();
    error BadPaymasterData();
    error BadValidityWindow();
    error UnsupportedCallData();
    error TooManyCalls();
    error ValueNotAllowed();
    error TargetNotAllowed(address target);
    error ApproveNotAllowed(address spender);
    error MaxCostPerOpExceeded(uint256 maxCost, uint256 cap);
    error AccountDailyCapExceeded(address account, uint256 wouldSpend, uint256 cap);
    error GlobalDailyCapExceeded(uint256 wouldSpend, uint256 cap);

    constructor(
        address entryPoint,
        address owner_,
        address signer_,
        address engine,
        address usdg,
        address agentRouter,
        uint256 maxCostPerOp_,
        uint256 accountDailyCap_,
        uint256 globalDailyCap_
    ) Ownable(owner_) {
        if (entryPoint == address(0) || signer_ == address(0) || engine == address(0) || usdg == address(0)) {
            revert ZeroAddress();
        }
        ENTRY_POINT = IPaymasterEntryPoint(entryPoint);
        ENGINE = engine;
        USDG = usdg;
        AGENT_ROUTER = agentRouter;
        signer = signer_;
        maxCostPerOp = maxCostPerOp_;
        accountDailyCap = accountDailyCap_;
        globalDailyCap = globalDailyCap_;
        emit SignerChanged(signer_);
        emit LimitsChanged(maxCostPerOp_, accountDailyCap_, globalDailyCap_);
    }

    // -----------------------------------------------------------------------------------------------------------
    // EntryPoint hooks
    // -----------------------------------------------------------------------------------------------------------

    /// @notice ERC-4337 v0.7 paymaster validation. Returns validationData with the signature-failed flag (1) when the
    /// sponsor signature does not verify; reverts when the call policy or a cap is violated.
    function validatePaymasterUserOp(PackedUserOperation calldata userOp, bytes32, uint256 maxCost)
        external
        returns (bytes memory context, uint256 validationData)
    {
        if (msg.sender != address(ENTRY_POINT)) revert NotEntryPoint();
        if (paused) revert PausedError();
        bytes calldata pd = userOp.paymasterAndData;
        if (pd.length != PAYMASTER_DATA_OFFSET + PAYMASTER_DATA_LENGTH) revert BadPaymasterData();

        uint48 validUntil = uint48(bytes6(pd[52:58]));
        uint48 validAfter = uint48(bytes6(pd[58:64]));
        if (validUntil == 0 || validUntil <= validAfter || validUntil - validAfter > MAX_VALIDITY_WINDOW) {
            revert BadValidityWindow();
        }
        validationData = (uint256(validUntil) << 160) | (uint256(validAfter) << 208);

        bytes32 digest = MessageHashUtils.toEthSignedMessageHash(getHash(userOp, validUntil, validAfter));
        (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecover(digest, pd[64:129]);
        if (err != ECDSA.RecoverError.NoError || recovered != signer) {
            return ("", validationData | 1);
        }

        _checkCalls(userOp.callData);

        if (maxCost > maxCostPerOp) revert MaxCostPerOpExceeded(maxCost, maxCostPerOp);
        uint64 day = uint64(validUntil / 1 days);

        Usage memory a = accountUsage[userOp.sender];
        uint256 aSpent = a.day == day ? a.spent : 0;
        if (aSpent + maxCost > accountDailyCap) revert AccountDailyCapExceeded(userOp.sender, aSpent + maxCost, accountDailyCap);
        Usage memory g = globalUsage;
        uint256 gSpent = g.day == day ? g.spent : 0;
        if (gSpent + maxCost > globalDailyCap) revert GlobalDailyCapExceeded(gSpent + maxCost, globalDailyCap);

        accountUsage[userOp.sender] = Usage(day, uint192(aSpent + maxCost));
        globalUsage = Usage(day, uint192(gSpent + maxCost));
        emit Sponsored(userOp.sender, day, maxCost);
        context = abi.encode(userOp.sender, day, maxCost);
    }

    /// @notice Returns the unused part of the reserved cost to the caps once the real cost is known.
    function postOp(PostOpMode, bytes calldata context, uint256 actualGasCost, uint256) external {
        if (msg.sender != address(ENTRY_POINT)) revert NotEntryPoint();
        (address account, uint64 day, uint256 reserved) = abi.decode(context, (address, uint64, uint256));
        uint256 refund = actualGasCost >= reserved ? 0 : reserved - actualGasCost;
        if (refund == 0) return;
        Usage memory a = accountUsage[account];
        if (a.day == day) accountUsage[account].spent = uint192(a.spent > refund ? a.spent - refund : 0);
        Usage memory g = globalUsage;
        if (g.day == day) globalUsage.spent = uint192(g.spent > refund ? g.spent - refund : 0);
        emit Refunded(account, day, refund);
    }

    /// @notice The hash the sponsoring signer signs (as an EIP-191 personal message). Covers every operation field the
    /// account signature covers except the account signature itself and the sponsor signature, plus chain and paymaster.
    function getHash(PackedUserOperation calldata userOp, uint48 validUntil, uint48 validAfter)
        public
        view
        returns (bytes32)
    {
        return keccak256(
            abi.encode(
                userOp.sender,
                userOp.nonce,
                keccak256(userOp.initCode),
                keccak256(userOp.callData),
                userOp.accountGasLimits,
                bytes32(userOp.paymasterAndData[20:52]),
                userOp.preVerificationGas,
                userOp.gasFees,
                block.chainid,
                address(this),
                validUntil,
                validAfter
            )
        );
    }

    // -----------------------------------------------------------------------------------------------------------
    // Call policy
    // -----------------------------------------------------------------------------------------------------------

    function _checkCalls(bytes calldata callData) internal view {
        if (callData.length < 100 || bytes4(callData[0:4]) != EXECUTE) revert UnsupportedCallData();
        (bytes32 mode, bytes memory exec) = abi.decode(callData[4:], (bytes32, bytes));
        bytes1 callType = bytes1(mode);
        if (callType == 0x00) {
            if (exec.length < 52) revert UnsupportedCallData();
            address target;
            uint256 value;
            assembly {
                target := shr(96, mload(add(exec, 32)))
                value := mload(add(exec, 52))
            }
            bytes memory data = new bytes(exec.length - 52);
            for (uint256 i; i < data.length; ++i) {
                data[i] = exec[i + 52];
            }
            _checkOne(target, value, data);
        } else if (callType == 0x01) {
            Execution[] memory calls = abi.decode(exec, (Execution[]));
            if (calls.length == 0 || calls.length > MAX_CALLS) revert TooManyCalls();
            for (uint256 i; i < calls.length; ++i) {
                _checkOne(calls[i].target, calls[i].value, calls[i].callData);
            }
        } else {
            revert UnsupportedCallData(); // delegatecall (0xff) and anything unknown
        }
    }

    function _isProtocol(address target) internal view returns (bool) {
        return target == ENGINE || (AGENT_ROUTER != address(0) && target == AGENT_ROUTER);
    }

    function _checkOne(address target, uint256 value, bytes memory data) internal view {
        if (value != 0) revert ValueNotAllowed();
        if (_isProtocol(target)) {
            if (data.length < 4) revert UnsupportedCallData();
            return;
        }
        if (target == USDG) {
            if (data.length != 68) revert UnsupportedCallData();
            bytes4 sel;
            address spender;
            assembly {
                sel := mload(add(data, 32))
                spender := mload(add(data, 36))
            }
            if (sel != APPROVE) revert TargetNotAllowed(target);
            if (!_isProtocol(spender)) revert ApproveNotAllowed(spender);
            return;
        }
        revert TargetNotAllowed(target);
    }

    // -----------------------------------------------------------------------------------------------------------
    // Funding and administration
    // -----------------------------------------------------------------------------------------------------------

    /// @notice Anyone may top up the gas deposit held in the EntryPoint.
    function deposit() external payable {
        ENTRY_POINT.depositTo{value: msg.value}(address(this));
    }

    receive() external payable {
        ENTRY_POINT.depositTo{value: msg.value}(address(this));
    }

    function depositBalance() external view returns (uint256) {
        return ENTRY_POINT.balanceOf(address(this));
    }

    function withdrawTo(address payable to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        ENTRY_POINT.withdrawTo(to, amount);
    }

    function addStake(uint32 unstakeDelaySec) external payable onlyOwner {
        ENTRY_POINT.addStake{value: msg.value}(unstakeDelaySec);
    }

    function unlockStake() external onlyOwner {
        ENTRY_POINT.unlockStake();
    }

    function withdrawStake(address payable to) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        ENTRY_POINT.withdrawStake(to);
    }

    function setSigner(address newSigner) external onlyOwner {
        if (newSigner == address(0)) revert ZeroAddress();
        signer = newSigner;
        emit SignerChanged(newSigner);
    }

    function setLimits(uint256 maxCostPerOp_, uint256 accountDailyCap_, uint256 globalDailyCap_) external onlyOwner {
        maxCostPerOp = maxCostPerOp_;
        accountDailyCap = accountDailyCap_;
        globalDailyCap = globalDailyCap_;
        emit LimitsChanged(maxCostPerOp_, accountDailyCap_, globalDailyCap_);
    }

    function setPaused(bool paused_) external onlyOwner {
        paused = paused_;
        emit PausedChanged(paused_);
    }
}
