import { getUserOperationHash } from "viem/account-abstraction";
import type { Hex } from "viem";
import { BundlerError, toRpcUserOp, type Bundler, type GasEstimate, type Op } from "./bundler";

export interface MockBundlerOptions {
  readonly chainId?: number;
  readonly estimate?: GasEstimate;
  /** Make estimation fail (to test the fallback path). */
  readonly failEstimate?: boolean;
  readonly failSend?: string;
}

const DEFAULT_ESTIMATE: GasEstimate = {
  preVerificationGas: 60_000n, verificationGasLimit: 250_000n, callGasLimit: 400_000n,
  paymasterVerificationGasLimit: 90_000n, paymasterPostOpGasLimit: 30_000n,
};

/** In-memory bundler for tests. It never touches the network. It records every call. */
export function createMockBundler(options: MockBundlerOptions = {}) {
  const sent: { op: Op; entryPoint: Hex; hash: Hex }[] = [];
  const estimated: { op: Op; entryPoint: Hex }[] = [];
  const receipts = new Map<Hex, unknown>();
  const bundler: Bundler = {
    async estimateUserOperationGas(op, entryPoint) {
      estimated.push({ op, entryPoint });
      if (options.failEstimate) throw new BundlerError("simulation failed", -32500);
      return options.estimate ?? DEFAULT_ESTIMATE;
    },
    async sendUserOperation(op, entryPoint) {
      if (options.failSend) throw new BundlerError(options.failSend, -32500);
      const hash = getUserOperationHash({ chainId: options.chainId ?? 4663, entryPointAddress: entryPoint, entryPointVersion: "0.7", userOperation: op });
      sent.push({ op, entryPoint, hash });
      receipts.set(hash, { userOpHash: hash, success: true, receipt: { transactionHash: `0x${"ab".repeat(32)}`, blockNumber: "0x10" } });
      return hash;
    },
    async getUserOperationReceipt(hash) {
      return receipts.get(hash) ?? null;
    },
  };
  return { bundler, sent, estimated, receipts };
}

/**
 * A Rundler-compatible JSON-RPC stub as a fetch function: answers eth_supportedEntryPoints, eth_chainId,
 * eth_estimateUserOperationGas, eth_sendUserOperation and eth_getUserOperationReceipt over the wire format, so the HTTP
 * bundler client is tested end to end without a network. Use `createHttpBundler({ url, fetch: stub.fetch })`.
 */
export function createRundlerStub(entryPoint: Hex, chainId = 4663) {
  const requests: { method: string; params: unknown[] }[] = [];
  const pool = new Map<string, unknown>();
  const stub = {
    requests,
    fetch: async (_url: string, init: { body: string }) => {
      const { id, method, params } = JSON.parse(init.body) as { id: number; method: string; params: unknown[] };
      requests.push({ method, params });
      const reply = (result: unknown) => new Response(JSON.stringify({ jsonrpc: "2.0", id, result }));
      const fail = (code: number, message: string) => new Response(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }));
      switch (method) {
        case "eth_chainId": return reply(`0x${chainId.toString(16)}`);
        case "eth_supportedEntryPoints": return reply([entryPoint]);
        case "eth_estimateUserOperationGas":
          return reply({
            preVerificationGas: "0xea60", verificationGasLimit: "0x3d090", callGasLimit: "0x61a80",
            paymasterVerificationGasLimit: "0x15f90", paymasterPostOpGasLimit: "0x7530",
          });
        case "eth_sendUserOperation": {
          const [op, ep] = params as [Record<string, string>, string];
          if (ep.toLowerCase() !== entryPoint.toLowerCase()) return fail(-32602, "unsupported entry point");
          if (typeof op.sender !== "string" || typeof op.signature !== "string" || op.signature === "0x") return fail(-32602, "missing signature");
          const hash = `0x${(pool.size + 1).toString(16).padStart(64, "0")}`;
          pool.set(hash, op);
          return reply(hash);
        }
        case "eth_getUserOperationReceipt": return reply(pool.has(String(params[0])) ? { userOpHash: params[0], success: true } : null);
        default: return fail(-32601, `method ${method} not found`);
      }
    },
  };
  return stub;
}

export { toRpcUserOp };
