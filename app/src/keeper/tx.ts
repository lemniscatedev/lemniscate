import { keccak256, type Address, type Hex, type TransactionReceipt } from "viem";
import type { Logger } from "pino";
import type { ServiceClients } from "../chain/clients";
import { robinhoodChain } from "../chain/chain";
import { safeErrorSummary } from "../log";

export interface KeeperTransaction {
  to: Address;
  data: Hex;
  label: string;
  value?: bigint;
}

export interface TransactionResult {
  simulated: boolean;
  hash?: Hex;
  receipt?: TransactionReceipt;
}

export interface TransactionQueueOptions {
  dryRun: boolean;
  logger: Logger;
  onHash?: (transaction: KeeperTransaction, hash: Hex) => Promise<void>;
  receiptTimeoutMs?: number;
}

/** Snapshot of the queue's nonce state, surfaced in the keeper heartbeat. */
export interface TransactionQueueStatus {
  heldNonce: number | null;
  heldSince: string | null;
  heldHashes: number;
}

export type BroadcastOutcome = "accepted" | "rejected" | "unknown";

function errorText(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current && typeof current === "object"; depth++) {
    const record = current as Record<string, unknown>;
    for (const key of ["shortMessage", "details", "message"]) {
      if (typeof record[key] === "string") parts.push(record[key] as string);
    }
    current = record.cause;
  }
  if (parts.length === 0) parts.push(String(error));
  return parts.join(" ").toLowerCase();
}

/** Classify a failed eth_sendRawTransaction. "rejected" means the node refused
 * the transaction outright, so it is in no mempool and does not occupy its
 * nonce. "accepted" covers duplicate-submission errors (the transaction is
 * pending). Anything else (timeouts, lost responses) is "unknown" and treated
 * as possibly broadcast.
 */
export function classifyBroadcastError(error: unknown): BroadcastOutcome {
  const text = errorText(error);
  if (/already known|known transaction|already imported|already in (the )?(mem)?pool/.test(text)) return "accepted";
  // Another transaction already occupies this nonce in the mempool.
  if (/replacement transaction underpriced|replacement fee too low/.test(text)) return "unknown";
  if (/nonce too low|nonce too high|insufficient funds|base fee|fee cap less than|max fee per gas less than|fee too low|underpriced|intrinsic gas|gas too low|exceeds block gas limit|invalid sender|invalid signature|invalid chain id|type not supported|oversized data/.test(text)) {
    return "rejected";
  }
  return "unknown";
}

/** One signer, one in-flight nonce. Signing locally makes a hash available even
 * when the RPC accepts a broadcast but loses its response. A possibly-broadcast
 * transaction holds its nonce until a receipt is found, the chain shows the
 * nonce consumed, or the chain shows nothing of ours in flight (latest ==
 * pending). Broadcasts the node definitively rejected release the nonce at once.
 */
export function createTransactionQueue(clients: ServiceClients, options: TransactionQueueOptions) {
  const wallet = clients.walletClient;
  const account = wallet?.account;
  let tail: Promise<unknown> = Promise.resolve();
  let nextNonce: number | undefined;
  let unresolved: { nonce: number; hashes: Hex[]; since: number } | undefined;
  const timeout = options.receiptTimeoutMs ?? 60_000;

  async function receipt(hashes: Hex[]): Promise<TransactionReceipt | undefined> {
    for (const hash of hashes) {
      try { return await clients.txClient.getTransactionReceipt({ hash }); }
      catch { /* Not found or temporarily unavailable: retry within the bounded wait. */ }
    }
    return undefined;
  }

  async function wait(hashes: Hex[]): Promise<TransactionReceipt | undefined> {
    const end = Date.now() + timeout;
    let delay = 500;
    while (true) {
      const found = await receipt(hashes);
      if (found) return found;
      if (Date.now() >= end) return undefined;
      await Bun.sleep(Math.min(delay, Math.max(1, end - Date.now())));
      delay = Math.min(delay * 2, 4000);
    }
  }

  /** A fresh legacy gas price for every attempt: eth_gasPrice, floored at twice
   * the latest base fee so a base-fee rise between blocks does not get the
   * transaction rejected. The RPC pool never caches fee reads on the tx route.
   */
  async function gasPrice(): Promise<bigint> {
    const [quoted, baseFee] = await Promise.all([
      clients.txClient.getGasPrice(),
      clients.txClient.getBlock({ blockTag: "latest" })
        .then((block) => block.baseFeePerGas ?? 0n)
        .catch(() => 0n),
    ]);
    const floor = baseFee * 2n;
    return quoted > floor ? quoted : floor;
  }

  async function chainNonces(address: Address): Promise<{ latest: number; pending: number }> {
    const [latest, pending] = await Promise.all([
      clients.txClient.getTransactionCount({ address, blockTag: "latest" }),
      clients.txClient.getTransactionCount({ address, blockTag: "pending" }),
    ]);
    return { latest, pending };
  }

  /** Resolve a held nonce, or throw while it is still legitimately in flight. */
  async function reconcile(address: Address): Promise<void> {
    if (!unresolved) return;
    const held = unresolved;
    const found = await receipt(held.hashes);
    if (found) {
      nextNonce = held.nonce + 1;
      unresolved = undefined;
      return;
    }
    const { latest, pending } = await chainNonces(address);
    if (latest > held.nonce) {
      // The nonce was consumed on chain by a hash we cannot see. Re-read the
      // next nonce from the chain before signing anything else.
      options.logger.warn({ nonce: held.nonce, latest, pending }, "Keeper held nonce was consumed on chain; releasing it");
      nextNonce = undefined;
      unresolved = undefined;
      return;
    }
    if (latest === pending) {
      // Nothing from this signer is in flight: the broadcasts were dropped.
      options.logger.warn({ nonce: held.nonce, latest }, "Keeper held nonce is not pending on chain; releasing it");
      nextNonce = latest;
      unresolved = undefined;
      return;
    }
    throw new Error(`Keeper nonce ${held.nonce} is unresolved; later transactions are held`);
  }

  async function run(transaction: KeeperTransaction): Promise<TransactionResult> {
    if (!wallet || !account || account.type !== "local") throw new Error("Keeper local signer is not configured");
    await reconcile(account.address);

    // estimateGas is the simulation: do not precede it with a redundant eth_call.
    const estimate = await clients.txClient.estimateGas({
      account: account.address, to: transaction.to, data: transaction.data,
      value: transaction.value ?? 0n,
    });
    if (options.dryRun) {
      options.logger.info({ label: transaction.label, gas: estimate.toString() }, "Keeper dry-run simulated");
      return { simulated: true };
    }

    if (nextNonce === undefined) {
      const { latest, pending } = await chainNonces(account.address);
      if (latest !== pending) throw new Error("Keeper has an existing pending transaction; waiting before taking a new nonce");
      nextNonce = latest;
    }
    const nonce = nextNonce;
    const hashes: Hex[] = [];
    let previous = 0n;
    let maybeBroadcast = false;
    let lastRejection = "";
    for (let attempt = 0; attempt < 2; attempt++) {
      const fresh = await gasPrice();
      // One replacement, same nonce and payload, at least 20% above the previous attempt.
      const bumped = attempt === 0 ? 0n : (previous * 120n + 99n) / 100n + 1n;
      const price = fresh > bumped ? fresh : bumped;
      previous = price;
      const serializedTransaction = await account.signTransaction({
        chainId: robinhoodChain.id, type: "legacy", nonce,
        to: transaction.to, data: transaction.data, value: transaction.value ?? 0n,
        gas: (estimate * 120n + 99n) / 100n, gasPrice: price,
      });
      const hash = keccak256(serializedTransaction);
      let outcome: BroadcastOutcome = "accepted";
      try { await clients.txClient.sendRawTransaction({ serializedTransaction }); }
      catch (error) {
        outcome = classifyBroadcastError(error);
        const err = safeErrorSummary(error);
        if (outcome === "rejected") {
          lastRejection = err.message;
          options.logger.warn({ label: transaction.label, hash, nonce, gasPrice: price.toString(), err },
            "Keeper broadcast was rejected by the node");
        } else {
          options.logger.warn({ label: transaction.label, hash, err },
            "Keeper broadcast response failed; checking the locally known transaction hash");
        }
      }
      // A rejected broadcast is in no mempool: nothing to persist or wait for.
      if (outcome === "rejected") continue;
      maybeBroadcast = true;
      hashes.push(hash);
      unresolved ??= { nonce, hashes, since: Date.now() };
      options.logger.info({ label: transaction.label, hash, nonce, replacement: attempt === 1 }, "Keeper transaction submitted");
      try { await options.onHash?.(transaction, hash); }
      catch (error) { options.logger.warn({ err: safeErrorSummary(error) }, "Could not persist keeper transaction hash"); }

      const found = await wait(hashes);
      if (found) {
        nextNonce = nonce + 1;
        unresolved = undefined;
        if (found.status !== "success") throw new Error(`Keeper transaction reverted: ${found.transactionHash}`);
        return { simulated: false, hash: found.transactionHash, receipt: found };
      }
    }
    if (!maybeBroadcast) {
      // Every attempt was refused outright, so nothing occupies the nonce.
      // Re-read it from the chain on the next job (this also covers "nonce too low").
      nextNonce = undefined;
      throw new Error(`Keeper transaction rejected by the node; nonce ${nonce} released: ${lastRejection}`);
    }
    throw new Error(`Keeper transaction receipt timed out; nonce ${nonce} remains held`);
  }

  return {
    submit(transaction: KeeperTransaction): Promise<TransactionResult> {
      const result = tail.then(() => run(transaction));
      tail = result.catch(() => undefined);
      return result;
    },
    status(): TransactionQueueStatus {
      return {
        heldNonce: unresolved?.nonce ?? null,
        heldSince: unresolved ? new Date(unresolved.since).toISOString() : null,
        heldHashes: unresolved?.hashes.length ?? 0,
      };
    },
    async drain(): Promise<void> { await tail; },
  };
}
