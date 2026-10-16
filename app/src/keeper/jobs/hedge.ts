import { encodeFunctionData } from "viem";
import { WriterPoolAbi as writerPoolAbi } from "../../abi/WriterPool";
import { safeErrorSummary } from "../../log";
import type { IndexerMetadata, KeeperContext } from "../context";

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

export function createHedgeJob(context: KeeperContext) {
  const lastAttempt = new Map<number, number>();
  return async (): Promise<Record<string, unknown>> => {
    const metadata = await context.metadata();
    const settings = metadata.vaultConfig;
    if (!settings) throw new Error("Waiting for indexed vault configuration");
    const stale = hedgeDataStaleness(metadata);
    if (stale) {
      context.logger.warn({ reason: stale }, "Hedge skipped: indexed hedge targets are stale");
      return { attempted: [], skipped: stale, retryAfterMs: 60_000 };
    }
    const ticks = await context.sql<{ market_id: number; spot: string; hedge_units: string; hedge_target: string; regime: number }[]>`
      select distinct on (market_id) market_id, spot, hedge_units, hedge_target, regime from ticks order by market_id, ts desc`;
    const attempted: number[] = [];
    let retryAfterMs: number | undefined;
    for (const tick of ticks) {
      const target = Number(tick.hedge_target);
      const difference = Math.abs(target - Number(tick.hedge_units));
      if (tick.regime === 2 || !Number.isFinite(difference) || difference === 0) continue;
      if (difference * Number(tick.spot) < Number(settings.minHedgeTradeUsdg)) continue;
      if (target > 0 && difference / target * 10000 < settings.rebalanceThresholdBps) continue;
      const cooldown = 120_000 - (Date.now() - (lastAttempt.get(tick.market_id) ?? 0));
      if (cooldown > 0) {
        // A new trade can change the target during the throttle window. Keep
        // that work queued so it runs as soon as the market can hedge again.
        retryAfterMs = Math.min(retryAfterMs ?? Infinity, cooldown);
        continue;
      }
      lastAttempt.set(tick.market_id, Date.now());
      try {
        await context.tx.submit({
          label: `hedge:${tick.market_id}`, to: context.deployment.contracts.vault,
          data: encodeFunctionData({ abi: writerPoolAbi, functionName: "rebalance", args: [tick.market_id] }),
        });
        attempted.push(tick.market_id);
      } catch (error) {
        context.logger.warn({ market: tick.market_id, err: safeErrorSummary(error) }, "Hedge simulation/send failed; skipping this market");
      }
    }
    return { attempted, retryAfterMs: retryAfterMs ?? null };
  };
}
