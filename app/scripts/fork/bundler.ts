// Fork-only ERC-4337 bundler (the "mock bundler" of the one-tap flow): a minimal JSON-RPC server that really executes
// each user operation through the canonical EntryPoint v0.7 on the anvil fork, from one of anvil's dev accounts.
// No mempool, no reputation, no simulation rules: it exists so the one-tap path (API -> userop -> EntryPoint -> Kernel ->
// engine) runs end to end on the fork. Never point it at a real network (it refuses any chain but 31337).
//
//   BUNDLER_PORT=4337 ANVIL_URL=http://127.0.0.1:8545 FORK_DIR=app/.fork bun scripts/fork/bundler.ts
import {
  createPublicClient, createWalletClient, decodeEventLog, http, type Address, type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { entryPoint07Abi, entryPoint07Address, getUserOperationHash, toPackedUserOperation, type UserOperation } from "viem/account-abstraction";
import { anvilAccounts, forkChain, ROLE_INDEX } from "./lib";

const port = Number(process.env.BUNDLER_PORT ?? "4337");
const rpc = process.env.ANVIL_URL ?? "http://127.0.0.1:8545";
const pub = createPublicClient({ chain: forkChain, transport: http(rpc) });
const key = anvilAccounts().private_keys[ROLE_INDEX.bundler]!;
const wallet = createWalletClient({ chain: forkChain, transport: http(rpc), account: privateKeyToAccount(key) });
const receipts = new Map<Hex, unknown>();

const big = (v: unknown): bigint | undefined => (typeof v === "string" || typeof v === "number" ? BigInt(v) : undefined);

/** RPC (hex strings) -> viem v0.7 UserOperation. */
export function fromRpc(op: Record<string, unknown>): UserOperation<"0.7"> {
  const out: Record<string, unknown> = {
    sender: op.sender, nonce: big(op.nonce)!, callData: op.callData, callGasLimit: big(op.callGasLimit)!,
    verificationGasLimit: big(op.verificationGasLimit)!, preVerificationGas: big(op.preVerificationGas)!,
    maxFeePerGas: big(op.maxFeePerGas)!, maxPriorityFeePerGas: big(op.maxPriorityFeePerGas)!, signature: op.signature,
  };
  if (op.factory) { out.factory = op.factory; out.factoryData = op.factoryData ?? "0x"; }
  if (op.paymaster) {
    out.paymaster = op.paymaster; out.paymasterData = op.paymasterData ?? "0x";
    out.paymasterVerificationGasLimit = big(op.paymasterVerificationGasLimit) ?? 0n;
    out.paymasterPostOpGasLimit = big(op.paymasterPostOpGasLimit) ?? 0n;
  }
  return out as unknown as UserOperation<"0.7">;
}

const hex = (n: bigint) => `0x${n.toString(16)}`;

async function send(opRpc: Record<string, unknown>, entryPoint: Address): Promise<Hex> {
  if (entryPoint.toLowerCase() !== entryPoint07Address.toLowerCase()) throw Object.assign(new Error("only EntryPoint v0.7"), { code: -32602 });
  const op = fromRpc(opRpc);
  const userOpHash = getUserOperationHash({ chainId: forkChain.id, entryPointAddress: entryPoint, entryPointVersion: "0.7", userOperation: op });
  const packed = toPackedUserOperation(op);
  // Simulate first so a doomed op returns the EntryPoint's revert reason instead of a mined failure.
  await pub.simulateContract({ address: entryPoint, abi: entryPoint07Abi, functionName: "handleOps", args: [[packed], wallet.account.address], account: wallet.account });
  const tx = await wallet.writeContract({ address: entryPoint, abi: entryPoint07Abi, functionName: "handleOps", args: [[packed], wallet.account.address], gas: 8_000_000n });
  const receipt = await pub.waitForTransactionReceipt({ hash: tx });
  let success = false;
  let actualGasUsed = 0n;
  let actualGasCost = 0n;
  for (const log of receipt.logs) {
    try {
      const ev = decodeEventLog({ abi: entryPoint07Abi, data: log.data, topics: log.topics });
      if (ev.eventName === "UserOperationEvent" && ev.args.userOpHash === userOpHash) {
        success = ev.args.success; actualGasUsed = ev.args.actualGasUsed; actualGasCost = ev.args.actualGasCost;
      }
    } catch { /* not an EntryPoint event */ }
  }
  receipts.set(userOpHash, {
    userOpHash, entryPoint, sender: op.sender, nonce: hex(op.nonce), success, actualGasUsed: hex(actualGasUsed), actualGasCost: hex(actualGasCost),
    logs: [], receipt: { transactionHash: receipt.transactionHash, blockNumber: hex(receipt.blockNumber), gasUsed: hex(receipt.gasUsed), status: receipt.status === "success" ? "0x1" : "0x0" },
  });
  return userOpHash;
}

async function handle(req: { id?: unknown; method: string; params?: unknown[] }): Promise<unknown> {
  const p = req.params ?? [];
  switch (req.method) {
    case "eth_chainId": return hex(BigInt(forkChain.id));
    case "eth_supportedEntryPoints": return [entryPoint07Address];
    case "eth_estimateUserOperationGas": {
      const op = (p[0] ?? {}) as Record<string, unknown>;
      return {
        preVerificationGas: hex(120_000n), verificationGasLimit: hex(op.factory ? 1_500_000n : 600_000n), callGasLimit: hex(3_000_000n),
        paymasterVerificationGasLimit: hex(250_000n), paymasterPostOpGasLimit: hex(120_000n),
      };
    }
    case "eth_sendUserOperation": return send(p[0] as Record<string, unknown>, p[1] as Address);
    case "eth_getUserOperationReceipt": return receipts.get(p[0] as Hex) ?? null;
    default: throw Object.assign(new Error(`method ${req.method} not supported by the fork bundler`), { code: -32601 });
  }
}

if (import.meta.main) {
  if ((await pub.getChainId()) !== 31337) throw new Error("fork bundler: the RPC is not the anvil fork (31337); refusing");
  Bun.serve({
    hostname: "127.0.0.1", port,
    async fetch(request) {
      if (request.method === "GET" && new URL(request.url).pathname === "/health") return Response.json({ ok: true, sent: receipts.size });
      const body = (await request.json()) as { id?: unknown; method: string; params?: unknown[] };
      try {
        return Response.json({ jsonrpc: "2.0", id: body.id ?? null, result: await handle(body) });
      } catch (error) {
        const e = error as { code?: number; shortMessage?: string; message?: string };
        return Response.json({ jsonrpc: "2.0", id: body.id ?? null, error: { code: e.code ?? -32500, message: e.shortMessage ?? e.message ?? "error" } });
      }
    },
  });
  console.log(`fork bundler on 127.0.0.1:${port} (EntryPoint v0.7, executes from ${wallet.account.address})`);
}
