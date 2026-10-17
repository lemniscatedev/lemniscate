import { pad, toHex, type Address, type Hex } from "viem";
import { getUserOperationHash } from "viem/account-abstraction";
import type { AaConfig } from "./config";
import type { Bundler, GasEstimate } from "./bundler";
import { toRpcUserOp } from "./bundler";
import { RpcBudgetError, type AaChain } from "./chain";
import { DEFAULT_MAX_COST_PER_OP_WEI } from "./config";
import { DUMMY_ACCOUNT_SIGNATURE, encodeKernelExecute, kernelFactoryData, kernelInitData, kernelNonceKey, approveCall, type Call } from "./kernel";
import { callsAreSponsorable, type Op, type Sponsor, type SponsorPolicy } from "./paymaster";

export class AaError extends Error {
  constructor(readonly status: 400 | 409 | 422 | 502 | 503, readonly apiError: string, message: string) {
    super(message);
    this.name = "AaError";
  }
}

export interface IntentLike {
  readonly kind: "buy" | "sell" | "shield";
  readonly to: string;
  readonly data: string;
  readonly approvals: readonly { token: string; spender: string; amount: string }[];
}

/** [approve USDG to the engine, ...] then the engine call itself: the one-tap batch for an intent. */
export function callsForIntent(intent: IntentLike): Call[] {
  return [
    ...intent.approvals.map((a) => approveCall(a.token as Address, a.spender as Address, BigInt(a.amount))),
    { to: intent.to as Address, value: 0n, data: intent.data as Hex },
  ];
}

export interface AaServices {
  readonly config: AaConfig;
  readonly chain: AaChain;
  readonly bundler: Bundler;
  readonly sponsor: Sponsor | null;
  readonly policy: SponsorPolicy;
  readonly now: () => number;
}

export interface BuildInput {
  readonly account: Address;
  /** The ECDSA owner of the Kernel account. Required only while the account is not yet deployed. */
  readonly owner?: Address | undefined;
  readonly calls: readonly Call[];
  readonly sponsor: boolean;
  /** Nonce lane (0..65535). Operations in different lanes can be in flight at once. */
  readonly nonceLane?: number | undefined;
  /** CREATE2 salt index for a new account (default 0). */
  readonly accountIndex?: number | undefined;
}

export interface BuiltUserOp {
  readonly userOp: Op;
  readonly userOpHash: Hex;
  readonly entryPoint: Address;
  readonly chainId: number;
  readonly sponsored: boolean;
  readonly deploysAccount: boolean;
  /** Upper bound on the gas the operation may cost, in wei (what the paymaster reserves). */
  readonly maxCostWei: bigint;
  readonly validUntil: number | null;
  readonly estimated: boolean;
}

const buffer = (value: bigint, percent: bigint) => (value * percent + 99n) / 100n;
const maxOp = (a: bigint, b: bigint) => (a > b ? a : b);
export const kernelSalt = (index: number): Hex => pad(toHex(index), { size: 32 });

export function maxCostOf(op: Op): bigint {
  const gas = op.preVerificationGas + op.verificationGasLimit + op.callGasLimit
    + (op.paymasterVerificationGasLimit ?? 0n) + (op.paymasterPostOpGasLimit ?? 0n);
  return gas * op.maxFeePerGas;
}

export function hashOf(op: Op, services: Pick<AaServices, "config">): Hex {
  return getUserOperationHash({
    chainId: services.config.chainId, entryPointAddress: services.config.entryPoint, entryPointVersion: "0.7", userOperation: op,
  });
}

export async function buildUserOp(services: AaServices, input: BuildInput): Promise<BuiltUserOp> {
  const { config, chain, bundler, sponsor } = services;
  const lane = input.nonceLane ?? 0;
  let nonceKey: bigint;
  try { nonceKey = kernelNonceKey(lane); } catch { throw new AaError(422, "BAD_REQUEST", "nonceLane must be an integer from 0 to 65535."); }

  const deployed = await chain.isDeployed(input.account).catch(() => { throw new AaError(503, "CHAIN_UNAVAILABLE", "The chain could not be read right now."); });
  let factory: Address | undefined;
  let factoryData: Hex | undefined;
  if (!deployed) {
    if (!input.owner) throw new AaError(422, "OWNER_REQUIRED", "This account is not deployed yet; send the owner address so it can be created in the same operation.");
    const salt = kernelSalt(input.accountIndex ?? 0);
    const initData = kernelInitData(config.kernelValidator, input.owner);
    const predicted = await chain.predictKernelAddress(config.kernelFactory, initData, salt)
      .catch(() => { throw new AaError(503, "CHAIN_UNAVAILABLE", "The chain could not be read right now."); });
    if (predicted.toLowerCase() !== input.account.toLowerCase()) {
      throw new AaError(422, "ACCOUNT_MISMATCH", "The account address is not the Kernel account for this owner and index.");
    }
    factory = config.kernelFactory;
    factoryData = kernelFactoryData(config.kernelValidator, input.owner, salt);
  }

  const nonce = await chain.entryPointNonce(config.entryPoint, input.account, nonceKey)
    .catch(() => { throw new AaError(503, "CHAIN_UNAVAILABLE", "The chain could not be read right now."); });
  const callData = encodeKernelExecute(input.calls);
  const fees = await chain.feesPerGas().catch((error: unknown) => {
    if (error instanceof RpcBudgetError) throw new AaError(503, "CHAIN_UNAVAILABLE", "The chain could not be read right now.");
    return null;
  });
  const fb = config.fallback;
  const maxFeePerGas = fees ? maxOp(buffer(fees.maxFeePerGas, 125n), 1n) : fb.maxFeePerGas;
  const maxPriorityFeePerGas = fees ? fees.maxPriorityFeePerGas : fb.priorityFeePerGas;

  const sponsorable = sponsor !== null && input.sponsor && callsAreSponsorable(input.calls, services.policy);
  if (input.sponsor && sponsor !== null && !sponsorable) {
    throw new AaError(409, "NOT_SPONSORABLE", "These calls are outside the gas sponsorship policy.");
  }
  const useSponsor = sponsorable ? sponsor : null;
  const now = Math.floor(services.now() / 1000);

  let op: Op = {
    sender: input.account, nonce,
    ...(factory ? { factory, factoryData: factoryData! } : {}),
    callData,
    callGasLimit: fb.callGas,
    verificationGasLimit: deployed ? fb.verificationGas : fb.deployVerificationGas,
    preVerificationGas: fb.preVerificationGas,
    maxFeePerGas, maxPriorityFeePerGas,
    signature: DUMMY_ACCOUNT_SIGNATURE,
  };
  if (useSponsor) op = await withSponsor(op, useSponsor, fb.paymasterVerificationGas, fb.paymasterPostOpGas, now);

  // Estimate with a fully valid sponsor signature so the paymaster's whole validation path is measured.
  let estimated = false;
  try {
    const estimate: GasEstimate = await bundler.estimateUserOperationGas(op, config.entryPoint);
    estimated = true;
    op = {
      ...op,
      preVerificationGas: buffer(estimate.preVerificationGas, 110n),
      verificationGasLimit: buffer(estimate.verificationGasLimit, 120n),
      callGasLimit: buffer(estimate.callGasLimit, 120n),
    };
    if (useSponsor) {
      op = await withSponsor(
        op, useSponsor,
        buffer(maxOp(estimate.paymasterVerificationGasLimit ?? 0n, fb.paymasterVerificationGas / 2n), 130n),
        buffer(maxOp(estimate.paymasterPostOpGasLimit ?? 0n, fb.paymasterPostOpGas / 2n), 130n),
        now,
      );
    }
  } catch {
    // F25: never keep a sponsor signature for an operation that could not be simulated. A bundler fails the estimate when
    // execution reverts, so signing over the fallback limits would pay for a call known to fail. The caller can retry
    // unsponsored (the user pays gas) or use the plain transaction.
    if (useSponsor) throw new AaError(409, "SPONSOR_SIMULATION_FAILED", "This operation could not be simulated, so it will not be sponsored. Retry without sponsorship or use the plain transaction.");
    // Unsponsored: keep the conservative fallbacks. The bundler re-checks everything when the signed operation is sent.
  }

  // Decision 45: the paymaster reverts MaxCostPerOpExceeded above maxCostPerOp, so a sponsored operation is priced under
  // it: the fee is lowered to what the cap allows (and the operation re-signed), unless that is below the network's own
  // fee, in which case nothing is signed.
  if (useSponsor) {
    const cap = config.paymaster?.maxCostPerOpWei ?? DEFAULT_MAX_COST_PER_OP_WEI;
    if (maxCostOf(op) > cap) {
      const gas = maxCostOf({ ...op, maxFeePerGas: 1n });
      const allowed = cap / gas;
      if (allowed === 0n || (fees && allowed < fees.maxFeePerGas)) {
        throw new AaError(409, "SPONSOR_COST_CAP", "Network fees are above what a sponsored operation may cost right now. Retry without sponsorship or use the plain transaction.");
      }
      op = await withSponsor(
        { ...op, maxFeePerGas: allowed, maxPriorityFeePerGas: op.maxPriorityFeePerGas > allowed ? allowed : op.maxPriorityFeePerGas },
        useSponsor, op.paymasterVerificationGasLimit ?? 0n, op.paymasterPostOpGasLimit ?? 0n, now,
      );
    }
  }

  const maxCostWei = maxCostOf(op);
  return {
    userOp: { ...op, signature: "0x" },
    userOpHash: hashOf({ ...op, signature: "0x" }, services),
    entryPoint: config.entryPoint, chainId: config.chainId,
    sponsored: useSponsor !== null, deploysAccount: !deployed, maxCostWei, estimated,
    validUntil: useSponsor ? now + useSponsor.validitySeconds : null,
  };
}

async function withSponsor(op: Op, sponsor: Sponsor, verificationGas: bigint, postOpGas: bigint, now: number): Promise<Op> {
  const withLimits: Op = { ...op, paymaster: sponsor.address, paymasterVerificationGasLimit: verificationGas, paymasterPostOpGasLimit: postOpGas, paymasterData: "0x" };
  const { paymasterData } = await sponsor.sign(withLimits, now);
  return { ...withLimits, paymasterData };
}

export { toRpcUserOp };
