import { concat, encodeAbiParameters, keccak256, pad, toHex, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { UserOperation } from "viem/account-abstraction";
import { approveCall, type Call } from "./kernel";

export type Op = UserOperation<"0.7">;

export const PAYMASTER_DATA_LENGTH = 6 + 6 + 65;
const u128 = (value: bigint): Hex => pad(toHex(value), { size: 16 });

export const packAccountGasLimits = (op: Op): Hex => concat([u128(op.verificationGasLimit), u128(op.callGasLimit)]);
export const packGasFees = (op: Op): Hex => concat([u128(op.maxPriorityFeePerGas), u128(op.maxFeePerGas)]);
export const packPaymasterGasLimits = (op: Op): Hex =>
  concat([u128(op.paymasterVerificationGasLimit ?? 0n), u128(op.paymasterPostOpGasLimit ?? 0n)]);
export const packInitCode = (op: Op): Hex => (op.factory ? concat([op.factory, op.factoryData ?? "0x"]) : "0x");

/** The hash LemniscatePaymaster.getHash computes on chain. Keep both in step (a shared test vector pins them). */
export function paymasterHash(op: Op, chainId: number, paymaster: Address, validUntil: number, validAfter: number): Hex {
  return keccak256(encodeAbiParameters(
    [
      { type: "address" }, { type: "uint256" }, { type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" }, { type: "bytes32" },
      { type: "uint256" }, { type: "bytes32" }, { type: "uint256" }, { type: "address" }, { type: "uint48" }, { type: "uint48" },
    ],
    [
      op.sender, op.nonce, keccak256(packInitCode(op)), keccak256(op.callData), packAccountGasLimits(op), packPaymasterGasLimits(op),
      op.preVerificationGas, packGasFees(op), BigInt(chainId), paymaster, validUntil, validAfter,
    ],
  ));
}

export interface SponsorWindow { readonly validUntil: number; readonly validAfter: number }

/** The only code that holds a private key in this service: the sponsoring signer. */
export interface Sponsor {
  readonly address: Address;
  readonly signer: Address;
  readonly validitySeconds: number;
  /** The paymaster `paymasterData` (validUntil, validAfter, signature) for a fully populated operation. */
  sign(op: Op, nowSeconds: number): Promise<{ paymasterData: Hex; window: SponsorWindow }>;
}

export function createSponsor(options: { address: Address; signerKey: Hex; chainId: number; validitySeconds: number }): Sponsor {
  const account = privateKeyToAccount(options.signerKey);
  return {
    address: options.address,
    signer: account.address,
    validitySeconds: options.validitySeconds,
    async sign(op, nowSeconds) {
      const validAfter = nowSeconds - 10;
      const validUntil = nowSeconds + options.validitySeconds;
      const hash = paymasterHash(op, options.chainId, options.address, validUntil, validAfter);
      const signature = await account.signMessage({ message: { raw: hash } });
      const paymasterData = concat([pad(toHex(validUntil), { size: 6 }), pad(toHex(validAfter), { size: 6 }), signature]);
      return { paymasterData, window: { validUntil, validAfter } };
    },
  };
}

export interface SponsorPolicy {
  readonly engine: Address;
  readonly usdg: Address;
  readonly agentRouter?: Address | undefined;
}

const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Mirror of the on-chain policy: only the engine, the AgentRouter, or USDG approve to one of them. Checked before the
 * signer signs, so the signer never signs for calls the contract would refuse. */
export function callsAreSponsorable(calls: readonly Call[], policy: SponsorPolicy): boolean {
  if (calls.length === 0 || calls.length > 4) return false;
  const isProtocol = (target: string) => eq(target, policy.engine) || (policy.agentRouter !== undefined && eq(target, policy.agentRouter));
  return calls.every((call) => {
    if (call.value !== 0n) return false;
    if (isProtocol(call.to)) return call.data.length >= 10;
    if (eq(call.to, policy.usdg)) {
      // approve(address,uint256): 4 + 32 + 32 bytes, spender must be a protocol contract.
      if (call.data.length !== 2 + 2 * 68 || !call.data.toLowerCase().startsWith("0x095ea7b3")) return false;
      return isProtocol(`0x${call.data.slice(2 + 8 + 24, 2 + 8 + 64)}`);
    }
    return false;
  });
}

export { approveCall };
