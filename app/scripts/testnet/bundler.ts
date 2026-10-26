// Testnet ERC-4337 bundler (the relayer of the one-tap flow) on this Mac: the fork bundler's minimal JSON-RPC server, sending
// handleOps to the canonical EntryPoint v0.7 from the throwaway `bundler` keystore wallet. The account pays the bundler
// back through the EntryPoint (beneficiary = the bundler), so it only needs a float of gas ETH.
// No mempool, no reputation, no simulation rules: a test relayer for our own flows, never a public service.
//
//   BUNDLER_PORT=4407 TESTNET_RPC_URL=<rpc> bun scripts/testnet/bundler.ts       (refuses any chain but 46630)
import { decodeEventLog, type Address, type Hex } from "viem";
import { entryPoint07Abi, entryPoint07Address, getUserOperationHash, toPackedUserOperation, type UserOperation } from "viem/account-abstraction";
import { assertTestnet, publicClient, TESTNET_CHAIN_ID, walletFor } from "./lib";

const port = Number(process.env.BUNDLER_PORT ?? "4407");
const receipts = new Map<Hex, unknown>();
const big = (v: unknown): bigint | undefined => (typeof v === "string" || typeof v === "number" ? BigInt(v) : undefined);
const hex = (n: bigint) => `0x${n.toString(16)}`;

/** RPC (hex strings) -> viem v0.7 UserOperation (same as scripts/fork/bundler.ts). */
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

async function main() {
  await assertTestnet();
  const pub = publicClient();
  const wallet = walletFor("bundler");
  const account = wallet.account!;

  async function send(opRpc: Record<string, unknown>, entryPoint: Address): Promise<Hex> {
    if (entryPoint.toLowerCase() !== entryPoint07Address.toLowerCase()) throw Object.assign(new Error("only EntryPoint v0.7"), { code: -32602 });
    const op = fromRpc(opRpc);
    const userOpHash = getUserOperationHash({ chainId: TESTNET_CHAIN_ID, entryPointAddress: entryPoint, entryPointVersion: "0.7", userOperation: op });
    const packed = toPackedUserOperation(op);
    await pub.simulateContract({ address: entryPoint, abi: entryPoint07Abi, functionName: "handleOps", args: [[packed], account.address], account });
    const tx = await wallet.writeContract({ address: entryPoint, abi: entryPoint07Abi, functionName: "handleOps", args: [[packed], account.address], gas: 8_000_000n, account, chain: wallet.chain });
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

  async function handle(req: { method: string; params?: unknown[] }): Promise<unknown> {
    const p = req.params ?? [];
    switch (req.method) {
      case "eth_chainId": return hex(BigInt(TESTNET_CHAIN_ID));
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
      default: throw Object.assign(new Error(`method ${req.method} not supported by the testnet bundler`), { code: -32601 });
    }
  }

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
  console.log(`testnet bundler on 127.0.0.1:${port} (EntryPoint v0.7, sends from ${account.address})`);
}

if (import.meta.main) await main();
