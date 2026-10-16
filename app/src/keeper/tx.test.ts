import { describe, expect, test } from "bun:test";
import { parseTransaction, keccak256, type Hex, type TransactionReceipt } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { classifyBroadcastError, createTransactionQueue } from "./tx";
import type { ServiceClients } from "../chain/clients";
import { createLogger } from "../log";

// Ephemeral test signer, generated in memory and never funded or persisted.
const account = privateKeyToAccount(generatePrivateKey());
const transaction = { to: account.address, data: "0x" as Hex, label: "test" };

function harness(mode: "confirmed" | "missing" | "estimate-fails" = "confirmed") {
  const sent: Hex[] = [];
  const receipts = new Map<Hex, TransactionReceipt>();
  let estimates = 0;
  // A "missing" broadcast sits in the mempool: pending moves ahead of latest.
  const nonces = { latest: 7, pending: 7 };
  const client = {
    txClient: {
      estimateGas: async () => { estimates++; if (mode === "estimate-fails") throw new Error("simulation reverted"); return 21000n; },
      getTransactionCount: async ({ blockTag }: { blockTag: "latest" | "pending" }) => nonces[blockTag],
      getGasPrice: async () => 10n,
      getBlock: async () => ({ baseFeePerGas: 1n }),
      sendRawTransaction: async ({ serializedTransaction }: { serializedTransaction: Hex }) => {
        sent.push(serializedTransaction);
        const hash = keccak256(serializedTransaction);
        if (mode === "confirmed") receipts.set(hash, { transactionHash: hash, status: "success" } as TransactionReceipt);
        else nonces.pending = Math.max(nonces.pending, parseTransaction(serializedTransaction).nonce! + 1);
        return hash;
      },
      getTransactionReceipt: async ({ hash }: { hash: Hex }) => {
        const value = receipts.get(hash);
        if (!value) throw new Error("not found");
        return value;
      },
    },
    walletClient: { account, signTransaction: (request: Parameters<typeof account.signTransaction>[0]) => account.signTransaction(request) },
  } as unknown as ServiceClients;
  return { client, sent, receipts, nonces, estimates: () => estimates };
}

describe("keeper transaction queue", () => {
  test("concurrent jobs consume distinct sequential nonces and estimate once each", async () => {
    const h = harness();
    const queue = createTransactionQueue(h.client, { dryRun: false, logger: createLogger("silent"), receiptTimeoutMs: 0 });
    await Promise.all([queue.submit(transaction), queue.submit(transaction)]);
    expect(h.sent.map((raw) => parseTransaction(raw).nonce)).toEqual([7, 8]);
    expect(h.sent.map((raw) => parseTransaction(raw).gas)).toEqual([25200n, 25200n]);
    expect(h.estimates()).toBe(2);
  });

  test("one fee bump retains nonce; an unresolved transaction blocks later jobs", async () => {
    const h = harness("missing");
    const queue = createTransactionQueue(h.client, { dryRun: false, logger: createLogger("silent"), receiptTimeoutMs: 0 });
    await expect(queue.submit(transaction)).rejects.toThrow("remains held");
    expect(h.sent.map((raw) => parseTransaction(raw).nonce)).toEqual([7, 7]);
    expect(h.sent.map((raw) => parseTransaction(raw).gasPrice)).toEqual([10n, 13n]);
    await expect(queue.submit(transaction)).rejects.toThrow("unresolved");
    expect(h.sent.length).toBe(2);
  });

  test("dry run and reverted simulations never broadcast", async () => {
    const dry = harness();
    const queue = createTransactionQueue(dry.client, { dryRun: true, logger: createLogger("silent") });
    expect(await queue.submit(transaction)).toEqual({ simulated: true });
    expect(dry.sent).toEqual([]);
    const failed = harness("estimate-fails");
    const failing = createTransactionQueue(failed.client, { dryRun: false, logger: createLogger("silent") });
    await expect(failing.submit(transaction)).rejects.toThrow("simulation reverted");
    expect(failed.sent).toEqual([]);
  });

  test("a late receipt releases the held nonce without rebroadcasting it", async () => {
    const h = harness("missing");
    const queue = createTransactionQueue(h.client, { dryRun: false, logger: createLogger("silent"), receiptTimeoutMs: 0 });
    await expect(queue.submit(transaction)).rejects.toThrow("remains held");
    const hash = keccak256(h.sent[0]!);
    h.receipts.set(hash, { transactionHash: hash, status: "success" } as TransactionReceipt);
    await expect(queue.submit(transaction)).rejects.toThrow("nonce 8 remains held");
    expect(h.sent.map((raw) => parseTransaction(raw).nonce)).toEqual([7, 7, 8, 8]);
  });

  test("a lost broadcast response resolves the locally signed hash without duplicating the transaction", async () => {
    const h = harness();
    const send = h.client.txClient.sendRawTransaction;
    h.client.txClient.sendRawTransaction = async (request) => {
      await send(request);
      throw new Error("RPC accepted the transaction but lost its response");
    };
    const queue = createTransactionQueue(h.client, { dryRun: false, logger: createLogger("silent"), receiptTimeoutMs: 0 });
    const first = await queue.submit(transaction);
    const second = await queue.submit(transaction);
    expect(first.receipt?.status).toBe("success");
    expect(second.receipt?.status).toBe("success");
    expect(h.sent.map((raw) => parseTransaction(raw).nonce)).toEqual([7, 8]);
    expect(first.hash).toBe(keccak256(h.sent[0]!));
  });

  test("a broadcast rejected on every attempt releases its nonce and the queue recovers once fees normalise", async () => {
    // Regression for the stuck-nonce report: the node rejects both attempts
    // (fee below base fee); later jobs must not be held behind that nonce.
    let baseFee = 100n;
    let gasPriceCalls = 0;
    const h = harness();
    const send = h.client.txClient.sendRawTransaction;
    Object.assign(h.client.txClient, {
      getGasPrice: async () => { gasPriceCalls++; return 10n; },
      getBlock: async () => { throw new Error("block unavailable"); },
      sendRawTransaction: async (request: { serializedTransaction: Hex }) => {
        const gasPrice = parseTransaction(request.serializedTransaction).gasPrice ?? 0n;
        if (gasPrice < baseFee) throw Object.assign(new Error("max fee per gas less than block base fee"), { code: -32000 });
        return send(request);
      },
    });
    const queue = createTransactionQueue(h.client, { dryRun: false, logger: createLogger("silent"), receiptTimeoutMs: 0 });
    await expect(queue.submit({ ...transaction, label: "hedge:0" })).rejects.toThrow("nonce 7 released");
    expect(queue.status().heldNonce).toBeNull();
    expect(gasPriceCalls).toBe(2); // a fresh fee read per attempt
    baseFee = 1n;
    const result = await queue.submit({ ...transaction, label: "risk" });
    expect(result.receipt?.status).toBe("success");
    expect(h.sent.map((raw) => parseTransaction(raw).nonce)).toEqual([7]);
  });

  test("the legacy gas price is floored at twice the latest base fee and bumped 20% on replacement", async () => {
    const h = harness("missing");
    h.client.txClient.getBlock = (async () => ({ baseFeePerGas: 50n })) as never;
    const queue = createTransactionQueue(h.client, { dryRun: false, logger: createLogger("silent"), receiptTimeoutMs: 0 });
    await expect(queue.submit(transaction)).rejects.toThrow("remains held");
    expect(h.sent.map((raw) => parseTransaction(raw).gasPrice)).toEqual([100n, 121n]);
    expect(queue.status().heldNonce).toBe(7);
  });

  test("a held nonce is released when the chain shows nothing in flight (latest == pending)", async () => {
    const h = harness("missing");
    const queue = createTransactionQueue(h.client, { dryRun: false, logger: createLogger("silent"), receiptTimeoutMs: 0 });
    await expect(queue.submit(transaction)).rejects.toThrow("remains held");
    await expect(queue.submit(transaction)).rejects.toThrow("unresolved");
    expect(queue.status()).toMatchObject({ heldNonce: 7, heldHashes: 2 });
    // The mempool dropped both broadcasts: latest == pending == held nonce.
    h.nonces.pending = 7;
    await expect(queue.submit(transaction)).rejects.toThrow("nonce 7 remains held");
    expect(h.sent.map((raw) => parseTransaction(raw).nonce)).toEqual([7, 7, 7, 7]);
  });

  test("a held nonce consumed on chain by an unseen hash is skipped and the next nonce re-read", async () => {
    const h = harness("missing");
    const queue = createTransactionQueue(h.client, { dryRun: false, logger: createLogger("silent"), receiptTimeoutMs: 0 });
    await expect(queue.submit(transaction)).rejects.toThrow("remains held");
    h.nonces.latest = 8;
    h.nonces.pending = 8;
    await expect(queue.submit(transaction)).rejects.toThrow("nonce 8 remains held");
    expect(h.sent.map((raw) => parseTransaction(raw).nonce)).toEqual([7, 7, 8, 8]);
  });

  test("broadcast errors are classified conservatively", () => {
    expect(classifyBroadcastError(new Error("already known"))).toBe("accepted");
    expect(classifyBroadcastError(new Error("replacement transaction underpriced"))).toBe("unknown");
    expect(classifyBroadcastError(new Error("request timed out"))).toBe("unknown");
    expect(classifyBroadcastError(new Error("insufficient funds for gas * price + value"))).toBe("rejected");
    expect(classifyBroadcastError(new Error("nonce too low"))).toBe("rejected");
    expect(classifyBroadcastError(Object.assign(new Error("RPC error"), { cause: { message: "intrinsic gas too low" } }))).toBe("rejected");
  });
});
