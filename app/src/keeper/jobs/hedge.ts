import type { IndexerMetadata, KeeperContext } from "../context";
import { loadBook, netDeltaFromBook } from "../../hedger/netdelta";

// The hedge target comes from indexer snapshots. Snapshots run on every trade
// or oracle update and at least every ten minutes, so anything older means the
// indexer is stuck and the target cannot be trusted.
export const HEDGE_MAX_SNAPSHOT_AGE_MS = 15 * 60_000;
export const HEDGE_MAX_INDEXER_SILENCE_MS = 5 * 60_000;
const HEDGE_MAX_LAG_BLOCKS = 60;

/** Why indexed hedge data is unusable right now, or undefined when it is fresh. */
export function hedgeDataStaleness(metadata: IndexerMetadata, now = Date.now()): string | undefined {
  const lastOk = Date.parse(metadata.indexerLastOk ?? "");
  if (!Number.isFinite(lastOk) || now - lastOk > HEDGE_MAX_INDEXER_SILENCE_MS) return "indexer has not reported a successful poll recently";
  const snapshotAt = Date.parse(metadata.lastSnapshotAt ?? "");
  if (!Number.isFinite(snapshotAt) || now - snapshotAt > HEDGE_MAX_SNAPSHOT_AGE_MS) return "latest indexer snapshot is too old";
  const lag = Number(metadata.lagBlocks ?? 0);
  if (!Number.isFinite(lag) || lag > HEDGE_MAX_LAG_BLOCKS) return "indexer is lagging the chain head";
  return undefined;
}

/** The keeper's hedge job is observe-only. Trading needs the separate hedger wallet (R6: never the keeper key), so
 * it lives in `bin/hedger.ts`; the keeper just publishes the book's net delta per name for the risk monitor. */
export function createHedgeJob(context: KeeperContext) {
  return async (): Promise<Record<string, unknown>> => {
    const metadata = await context.metadata();
    const stale = hedgeDataStaleness(metadata);
    if (stale) {
      context.logger.warn({ reason: stale }, "Hedge book skipped: indexed data is stale");
      return { attempted: [], skipped: stale, retryAfterMs: 60_000 };
    }
    const book = await loadBook(context.sql);
    const exposures = netDeltaFromBook(book.series, book.markets);
    const names: Record<string, unknown> = {};
    for (const [stock, e] of exposures) {
      names[book.markets.get(stock)?.name ?? stock] = { netDelta: e.netDelta, netGamma: e.netGamma, netVega: e.netVega, complete: e.complete, skipped: e.skipped };
    }
    return { attempted: [], observeOnly: true, names };
  };
}
