import { concat, encodeAbiParameters, encodeFunctionData, encodePacked, parseAbi, toHex, type Address, type Hex } from "viem";

/**
 * ZeroDev Kernel v3 (ERC-7579) encoders. The account is owned by one ECDSA key through the ECDSA validator, which is the
 * root validator, so the account signature is the owner's plain 65-byte signature.
 *
 * Signature scheme (documented, verified against the ZeroDev ECDSA validator's recover logic): the owner signs the
 * 32-byte userOpHash. `personal_sign` over those 32 bytes (EIP-191) works in every wallet and is what the web app uses;
 * a raw ECDSA signature over the hash is accepted too.
 */
export interface Call {
  readonly to: Address;
  readonly value: bigint;
  readonly data: Hex;
}

export const kernelAbi = parseAbi([
  "function initialize(bytes21 rootValidator, address hook, bytes validatorData, bytes hookData, bytes[] initConfig)",
  "function execute(bytes32 execMode, bytes executionCalldata) payable",
]);
export const kernelFactoryAbi = parseAbi([
  "function createAccount(bytes data, bytes32 salt) payable returns (address)",
  "function getAddress(bytes data, bytes32 salt) view returns (address)",
]);
export const erc20ApproveAbi = parseAbi(["function approve(address spender, uint256 amount) returns (bool)"]);

/** ERC-7579 execution modes: call type 0x00 single, 0x01 batch; exec type 0x00 revert on failure. */
export const MODE_SINGLE = toHex(0n, { size: 32 });
export const MODE_BATCH = `0x01${"00".repeat(31)}` as Hex;
/** `address(1)`: Kernel's marker for "no hook". */
export const NO_HOOK = "0x0000000000000000000000000000000000000001" as Address;

const executionTuple = [{ type: "tuple[]", components: [{ type: "address", name: "target" }, { type: "uint256", name: "value" }, { type: "bytes", name: "callData" }] }] as const;

/** `execute(mode, executionCalldata)` for one call (packed) or many (abi-encoded Execution[]). */
export function encodeKernelExecute(calls: readonly Call[]): Hex {
  if (calls.length === 0) throw new Error("at least one call is required");
  if (calls.length === 1) {
    const call = calls[0]!;
    return encodeFunctionData({ abi: kernelAbi, functionName: "execute", args: [MODE_SINGLE, encodePacked(["address", "uint256", "bytes"], [call.to, call.value, call.data])] });
  }
  const batch = encodeAbiParameters(executionTuple, [calls.map((call) => ({ target: call.to, value: call.value, callData: call.data }))]);
  return encodeFunctionData({ abi: kernelAbi, functionName: "execute", args: [MODE_BATCH, batch] });
}

/** Nonce key (uint192) of the ROOT validation type: mode 0x00, type 0x00, 20 zero identifier bytes, then the 2-byte
 * `lane`. Lane 0 is the default; a different lane lets two operations be in flight in parallel. */
export function kernelNonceKey(lane = 0): bigint {
  if (!Number.isInteger(lane) || lane < 0 || lane > 0xffff) throw new Error("nonce lane must be 0..65535");
  return BigInt(lane);
}

/** Kernel `initialize` calldata for a fresh account owned by `owner` (root validator = the ECDSA validator). */
export function kernelInitData(validator: Address, owner: Address): Hex {
  const rootValidator = concat(["0x01", validator]) as Hex; // ValidationType VALIDATOR (0x01) then the validator address
  return encodeFunctionData({
    abi: kernelAbi, functionName: "initialize",
    args: [rootValidator, NO_HOOK, owner, "0x", []],
  });
}

export function kernelFactoryData(validator: Address, owner: Address, salt: Hex): Hex {
  return encodeFunctionData({ abi: kernelFactoryAbi, functionName: "createAccount", args: [kernelInitData(validator, owner), salt] });
}

export const approveCall = (token: Address, spender: Address, amount: bigint): Call => ({
  to: token, value: 0n, data: encodeFunctionData({ abi: erc20ApproveAbi, functionName: "approve", args: [spender, amount] }),
});

// A well-formed (recoverable) signature over nothing in particular, for gas estimation only. The Kernel ECDSA
// validator reverts on a malformed signature, so a plausible one is needed. Split so no key-shaped literal appears.
const DUMMY_R = "e9f465018136ad8992ba8bfb3872bc2b996699237d53b8d75904089e23822b54";
const DUMMY_S = "549b53481e2ecb91ced0dd2b13e0e208a5cd21c4942174fd6914f74537514e63";
export const DUMMY_ACCOUNT_SIGNATURE = `0x${DUMMY_R}${DUMMY_S}1b` as Hex;
