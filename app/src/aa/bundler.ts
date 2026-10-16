import { formatUserOperationRequest, type UserOperation } from "viem/account-abstraction";
import type { Hex } from "viem";

export type Op = UserOperation<"0.7">;

export interface GasEstimate {
  readonly preVerificationGas: bigint;
  readonly verificationGasLimit: bigint;
  readonly callGasLimit: bigint;
  readonly paymasterVerificationGasLimit?: bigint | undefined;
  readonly paymasterPostOpGasLimit?: bigint | undefined;
}

/** The slice of the ERC-4337 bundler RPC the service uses. Any v0.7 bundler (Rundler, Alto, Pimlico, ...) fits. */
export interface Bundler {
  estimateUserOperationGas(op: Op, entryPoint: Hex): Promise<GasEstimate>;
  sendUserOperation(op: Op, entryPoint: Hex): Promise<Hex>;
  getUserOperationReceipt(hash: Hex): Promise<unknown | null>;
}

export class BundlerError extends Error {
  constructor(message: string, readonly code?: number) { super(message); this.name = "BundlerError"; }
}

type FetchLike = (input: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<Response>;

const toBigint = (value: unknown): bigint | undefined => {
  if (typeof value === "string" && /^0x[0-9a-fA-F]+$/.test(value)) return BigInt(value);
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  return undefined;
};

/** The wire form of an operation: hex quantities, optional fields omitted. */
export function toRpcUserOp(op: Op): Record<string, unknown> {
  return formatUserOperationRequest(op as never) as Record<string, unknown>;
}

export function createHttpBundler(options: { url: string; timeoutMs?: number; fetch?: FetchLike }): Bundler {
  const doFetch: FetchLike = options.fetch ?? ((input, init) => fetch(input, init));
  let id = 0;
  async function call(method: string, params: unknown[]): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 8_000);
    try {
      const response = await doFetch(options.url, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }), signal: controller.signal,
      });
      if (!response.ok) throw new BundlerError(`bundler HTTP ${response.status}`);
      const body = await response.json() as { result?: unknown; error?: { code?: number; message?: string } };
      if (body.error) throw new BundlerError(body.error.message ?? "bundler error", body.error.code);
      return body.result;
    } catch (error) {
      if (error instanceof BundlerError) throw error;
      throw new BundlerError(error instanceof Error && error.name === "AbortError" ? "bundler timed out" : "bundler unreachable");
    } finally {
      clearTimeout(timer);
    }
  }
  return {
    async estimateUserOperationGas(op, entryPoint) {
      const result = await call("eth_estimateUserOperationGas", [toRpcUserOp(op), entryPoint]) as Record<string, unknown> | null;
      const pre = toBigint(result?.preVerificationGas);
      const verification = toBigint(result?.verificationGasLimit);
      const callGas = toBigint(result?.callGasLimit);
      if (pre === undefined || verification === undefined || callGas === undefined) throw new BundlerError("bundler returned an unusable estimate");
      return {
        preVerificationGas: pre, verificationGasLimit: verification, callGasLimit: callGas,
        paymasterVerificationGasLimit: toBigint(result?.paymasterVerificationGasLimit),
        paymasterPostOpGasLimit: toBigint(result?.paymasterPostOpGasLimit),
      };
    },
    async sendUserOperation(op, entryPoint) {
      const result = await call("eth_sendUserOperation", [toRpcUserOp(op), entryPoint]);
      if (typeof result !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(result)) throw new BundlerError("bundler returned an invalid hash");
      return result as Hex;
    },
    async getUserOperationReceipt(hash) {
      return await call("eth_getUserOperationReceipt", [hash]) ?? null;
    },
  };
}
