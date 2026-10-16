import { encodeFunctionData, type Address, type Hex } from "viem";
import { OptionEngineAbi, OptionTokenAbi } from "../../abi";
import { safeErrorSummary } from "../../log";
import type { KeeperContext } from "../context";
import { chunkedMulticall, createSeriesReader, type ChainSeries } from "../series";
import { keepLastGoodPrices } from "./prices";

/** At a session boundary every series with supply is accrued if anything at all has elapsed since its last accrual. */
const BOUNDARY_MIN_ELAPSED_SECONDS = 30n;

/** Splits `ids` into engine.accrueMany transactions of at most `batchSize`. When a transaction fails (one series that
 * reverts, or a batch that does not fit the gas limit) the batch is halved and retried, so a single bad series
 * cannot stop the others from being accrued. Returns what was accrued and what could not be. */
export async function accrueInBatches(
  context: Pick<KeeperContext, "tx" | "deployment" | "logger">,
  ids: readonly Hex[],
  batchSize: number,
): Promise<{ accrued: Hex[]; failed: { id: Hex; error: string }[]; transactions: number; simulated: boolean }> {
  const engine = context.deployment.contracts.engine as Address;
  const accrued: Hex[] = [];
  const failed: { id: Hex; error: string }[] = [];
  let transactions = 0;
  let simulated = false;
  const queue: Hex[][] = [];
  for (let i = 0; i < ids.length; i += batchSize) queue.push(ids.slice(i, i + batchSize));
  while (queue.length) {
    const batch = queue.shift()!;
    try {
      const result = await context.tx.submit({
        label: "accrue", to: engine,
        data: encodeFunctionData({ abi: OptionEngineAbi, functionName: "accrueMany", args: [batch] }),
      });
      transactions++;
      simulated ||= result.simulated;
      accrued.push(...batch);
    } catch (error) {
      const summary = safeErrorSummary(error);
      // A held nonce or a missing signer is not the batch's fault: splitting would only repeat the failure.
      if (/nonce .* (is held|is unresolved|remains held)|local signer is not configured|existing pending transaction/i.test(summary.message)) throw error;
      if (batch.length === 1) {
        failed.push({ id: batch[0]!, error: summary.message });
        context.logger.warn({ id: batch[0], err: summary }, "Accrual of one series failed; the others continue");
        continue;
      }
      const half = Math.ceil(batch.length / 2);
      queue.unshift(batch.slice(0, half), batch.slice(half));
    }
  }
  return { accrued, failed, transactions, simulated };
}

/** R2: accrues every series with outstanding supply whose last accrual is older than KEEPER_ACCRUE_MAX_AGE_SECONDS
 * (default one hour). Due-ness comes from the chain's own `lastAccrual`, so an hour that was skipped (keeper down, RPC
 * outage, failed batch) is caught up by the next run, and nothing is sent when nothing is due. `force` is the session
 * boundary poke: it accrues whatever has any time elapsed, so funding is settled at the old regime before the new one. */
export function createAccrueJob(context: KeeperContext) {
  const reader = createSeriesReader(context);
  return async (force = false): Promise<Record<string, unknown>> => {
    const metadata = await context.metadata();
    const nowSeconds = BigInt(Math.floor(context.now(metadata).getTime() / 1000));
    const maxAge = BigInt(context.config.KEEPER_ACCRUE_MAX_AGE_SECONDS);
    const threshold = force ? BOUNDARY_MIN_ELAPSED_SECONDS : maxAge;
    // PriceGuard's last good price first: it is what sells use once the session closes (keepLastGoodPrices).
    const prices = await keepLastGoodPrices(context).catch((error: unknown) => {
      context.logger.warn({ err: safeErrorSummary(error) }, "PriceGuard last-good-price upkeep failed");
      return { poked: [], failed: [String((error as Error).message)] };
    });
    const pokes = prices.poked.length;
    const all = await reader.readAll();
    const aged = all.filter((series) => nowSeconds - series.lastAccrual >= threshold);
    if (!aged.length) return { series: all.length, due: 0, accrued: 0, idle: true, pokes };

    // Only series somebody holds can change: a zero-supply series has nothing to shrink.
    const supplies = await chunkedMulticall(context, aged.map((series: ChainSeries) => ({
      address: series.token, abi: OptionTokenAbi, functionName: "totalSupply",
    }))) as bigint[];
    const due = aged.filter((_, index) => BigInt(supplies[index]!) > 0n);
    if (!due.length) return { series: all.length, due: 0, accrued: 0, idle: true, pokes };

    const result = await accrueInBatches(context, due.map((series) => series.id), context.config.KEEPER_ACCRUE_BATCH);
    const summary = {
      series: all.length, due: due.length, accrued: result.accrued.length, transactions: result.transactions,
      failed: result.failed.length, dryRun: result.simulated, idle: false, forced: force, pokes,
      lastAccruedAt: new Date(Number(nowSeconds) * 1000).toISOString(),
    };
    if (result.failed.length) {
      // Reported through the job's error path so the scheduler retries soon and the health route shows it.
      throw new Error(`Accrual failed for ${result.failed.length} of ${due.length} series: ${result.failed[0]!.error}`);
    }
    return summary;
  };
}
