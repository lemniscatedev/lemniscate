import { encodeFunctionData, type Address, type Hex } from "viem";
import { OptionEngineAbi, OptionTokenAbi, PriceGuardAbi } from "../../abi";
import { safeErrorSummary } from "../../log";
import type { KeeperContext } from "../context";
import { chunkedMulticall, createSeriesReader, readLiveRisk, type ChainSeries, type LiveRisk } from "../series";
import { keepLastGoodPrices } from "./prices";

/** At a session boundary every series with supply is accrued if anything at all has elapsed since its last accrual. */
const BOUNDARY_MIN_ELAPSED_SECONDS = 30n;

/** Most series per accrueMany / retireDust transaction (about half a block, decision 32), whatever the setting. */
export const ACCRUE_BATCH_MAX = 45;
const accrueBatch = (configured: number): number => Math.max(1, Math.min(ACCRUE_BATCH_MAX, Math.floor(configured) || ACCRUE_BATCH_MAX));

/** R15: a series the engine retired as dust (supply left, off the live list) is accrued one by one, not through accrueMany, which
 * skips it without touching lastAccrual and would be sent the same id on every run for ever. */
const RETIRED_LABEL = "accrue:retired";

/** A series retireDust kept (its refreshed value was real) is not sent to retireDust again for this long. */
const RETIRE_RETRY_SECONDS = 3600n;
const HELD_QUEUE = /nonce .* (is held|is unresolved|remains held)|local signer is not configured|existing pending transaction/i;

/** Review F08/F24 (decision 32): sends engine.retireDust for live series whose last-touch value is under the minimum
 * trade, so they leave the live list (accrueMany and monitoring stop paying for them). The engine re-accrues each one
 * first and keeps any that is not dust after all; such a series is not tried again for RETIRE_RETRY_SECONDS. A failed
 * call is logged and never stops the accrual. Returns the ids judged dust (not worth an accrual) and how many were sent. */
async function retireDustSeries(
  context: Pick<KeeperContext, "tx" | "deployment" | "logger">,
  risk: LiveRisk, nowSeconds: bigint, tried: Map<Hex, bigint>, batchSize: number,
): Promise<{ dust: Set<Hex>; sent: number }> {
  for (const [id, at] of tried) if (nowSeconds - at >= RETIRE_RETRY_SECONDS) tried.delete(id);
  const dust = new Set(risk.live.filter((entry) => entry.value < risk.dustWad).map((entry) => entry.id));
  const due = [...dust].filter((id) => !tried.has(id));
  let sent = 0;
  for (let i = 0; i < due.length; i += batchSize) {
    const batch = due.slice(i, i + batchSize);
    for (const id of batch) tried.set(id, nowSeconds);
    try {
      await context.tx.submit({
        label: "accrue:retire-dust", to: context.deployment.contracts.engine as Address,
        data: encodeFunctionData({ abi: OptionEngineAbi, functionName: "retireDust", args: [batch] }),
      });
      sent += batch.length;
    } catch (error) {
      const summary = safeErrorSummary(error);
      if (HELD_QUEUE.test(summary.message)) throw error;
      context.logger.warn({ count: batch.length, err: summary }, "retireDust failed; the accrual continues");
    }
  }
  return { dust, sent };
}

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
  batchSize = accrueBatch(batchSize);
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
      if (HELD_QUEUE.test(summary.message)) throw error;
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

/** Latest indexed per-unit mark (USDG) of each series, from the accrual history. Series without a row are absent. */
async function latestMarks(context: KeeperContext, ids: readonly Hex[]): Promise<Map<Hex, number>> {
  const marks = new Map<Hex, number>();
  if (!ids.length) return marks;
  const rows = await context.sql<{ series_id: string; v_mark: string }[]>`
    select distinct on (series_id) series_id, v_mark::text as v_mark from norm_history
    where series_id = any(string_to_array(${ids.join(",")}, ',')) order by series_id, ts desc`;
  for (const row of rows ?? []) if (row?.series_id) marks.set(row.series_id as Hex, Number(row.v_mark));
  return marks;
}

/** Funding sampling grid (review F11/F34, decision 35): every live series of a name in REGULAR or EXTENDED that is worth
 * sampling is accrued once per slot, whatever its lastAccrual, so a holder who accrues at prints of their choosing cannot
 * suppress the keeper's samples. R13: "worth sampling" is bounded. Archived series (beyond the archive moneyness), series
 * under KEEPER_ACCRUE_GRID_MIN_VALUE_USDG of outstanding value and anything past KEEPER_ACCRUE_GRID_MAX_SERIES per slot
 * (the most valuable are kept) are left to the hourly catch-up, so positions an attacker holds for a dollar each cannot bill
 * the keeper's gas at the grid rate. */
export const ACCRUE_GRID_SECONDS = 300n;
/** The next run is timed this long after the next grid boundary (the first price read after it). */
const GRID_SETTLE_MS = 5_000;
// SessionKind: REGULAR 0, EXTENDED 1.
const GRID_SESSIONS = new Set([0, 1]);

/** PriceGuard session per stock; a failed read leaves the stock out (no grid sample; the hourly catch-up still runs). */
async function liveSessionStocks(context: KeeperContext, stocks: readonly Address[]): Promise<Set<string>> {
  if (!stocks.length) return new Set();
  const reads = await context.clients.stateClient.multicall({
    allowFailure: true,
    contracts: stocks.map((stock) => ({
      address: context.deployment.contracts.priceGuard as Address, abi: PriceGuardAbi, functionName: "read", args: [stock],
    })) as never,
  }) as { status: "success" | "failure"; result?: { session: number } }[];
  return new Set(stocks.filter((_, index) => reads[index]?.status === "success" && GRID_SESSIONS.has(Number(reads[index]!.result!.session)))
    .map((stock) => stock.toLowerCase()));
}

/** R2: accrues every series with outstanding supply whose last accrual is older than KEEPER_ACCRUE_MAX_AGE_SECONDS
 * (default one hour), plus, once per 5-minute grid slot, every live non-dust series of a name in session (F11). Due-ness
 * of the hourly part comes from the chain's own `lastAccrual`, so an hour that was skipped (keeper down, RPC outage,
 * failed batch) is caught up by the next run. `force` is the session boundary poke: it accrues whatever has any time
 * elapsed, so funding is settled at the old regime before the new one. Each run asks to be run again just after the
 * next grid boundary. */
export function createAccrueJob(context: KeeperContext) {
  const reader = createSeriesReader(context);
  const retireTried = new Map<Hex, bigint>();
  /** R15: when each retired series was last sent to engine.accrue. */
  const retiredTried = new Map<Hex, bigint>();
  let lastGridSlot: bigint | undefined;
  return async (force = false): Promise<Record<string, unknown>> => {
    const metadata = await context.metadata();
    const nowMs = context.now(metadata).getTime();
    const nowSeconds = BigInt(Math.floor(nowMs / 1000));
    const slot = nowSeconds / ACCRUE_GRID_SECONDS;
    const retryAfterMs = Number((slot + 1n) * ACCRUE_GRID_SECONDS * 1000n) - nowMs + GRID_SETTLE_MS;
    const maxAge = BigInt(context.config.KEEPER_ACCRUE_MAX_AGE_SECONDS);
    const threshold = force ? BOUNDARY_MIN_ELAPSED_SECONDS : maxAge;
    // PriceGuard's last good price first: it is what sells use once the session closes (keepLastGoodPrices).
    const prices = await keepLastGoodPrices(context).catch((error: unknown) => {
      context.logger.warn({ err: safeErrorSummary(error) }, "PriceGuard last-good-price upkeep failed");
      return { poked: [], latched: [], failed: [String((error as Error).message)] };
    });
    const pokes = prices.poked.length + prices.latched.length;
    const risk = await readLiveRisk(context).catch((error: unknown) => {
      context.logger.warn({ err: safeErrorSummary(error) }, "Engine live list unreadable; no dust retirement or grid sample this run");
      return undefined;
    });
    const retire = risk
      ? await retireDustSeries(context, risk, nowSeconds, retireTried, accrueBatch(context.config.KEEPER_ACCRUE_BATCH))
      : { dust: new Set<Hex>(), sent: 0 };
    const retireSent = retire.sent;

    const all = await reader.readAll();

    // F11 grid sample: once per slot, the live series of a name in session that are worth sampling (R13).
    let grid: Hex[] = [];
    let gridSkipped = 0;
    if (risk && slot !== lastGridSlot) {
      const archived = new Set(all.filter((series) => series.archived).map((series) => series.id));
      const minValue = BigInt(Math.round(Number(context.config.KEEPER_ACCRUE_GRID_MIN_VALUE_USDG ?? 100) * 1e6)) * 10n ** 12n;
      const candidates = risk.live.filter((entry) => !retire.dust.has(entry.id) && !archived.has(entry.id) && entry.value >= minValue);
      const inSession = await liveSessionStocks(context, [...new Set(candidates.map((entry) => entry.stock))]).catch((error: unknown) => {
        context.logger.warn({ err: safeErrorSummary(error) }, "PriceGuard sessions unreadable; no grid sample this run");
        return new Set<string>();
      });
      const sampled = candidates.filter((entry) => inSession.has(entry.stock.toLowerCase()))
        .sort((a, b) => (a.value === b.value ? 0 : a.value > b.value ? -1 : 1));
      const budget = Math.max(0, Math.floor(Number(context.config.KEEPER_ACCRUE_GRID_MAX_SERIES ?? 450)));
      gridSkipped = Math.max(0, sampled.length - budget);
      grid = sampled.slice(0, budget).map((entry) => entry.id);
      if (gridSkipped > 0) context.logger.warn({ sampled: sampled.length, budget, skipped: gridSkipped },
        "ALERT: more series qualify for the 5-minute funding grid than its per-slot budget; the least valuable are left to the hourly catch-up");
    }

    const liveIds = risk ? new Set<Hex>(risk.live.map((entry) => entry.id)) : undefined;
    const hourly = await hourlyDue(context, all, nowSeconds, threshold, retire.dust, liveIds);
    const ids = [...new Set<Hex>([...grid, ...hourly.due])];
    // R15: retired series (supply left, off the live list) are accrued singly at the daily dust cadence.
    const dustAfterSeconds = BigInt(context.config.KEEPER_ACCRUE_DUST_MAX_AGE_SECONDS ?? 86_400);
    for (const [id, at] of retiredTried) if (nowSeconds - at >= dustAfterSeconds) retiredTried.delete(id);
    const retiredDue = hourly.retired.filter((series) => nowSeconds - series.lastAccrual >= dustAfterSeconds && !retiredTried.has(series.id));
    let retiredSent = 0;
    for (const series of retiredDue) {
      retiredTried.set(series.id, nowSeconds);
      try {
        await context.tx.submit({
          label: RETIRED_LABEL, to: context.deployment.contracts.engine as Address,
          data: encodeFunctionData({ abi: OptionEngineAbi, functionName: "accrue", args: [series.id] }),
        });
        retiredSent++;
      } catch (error) {
        const summary = safeErrorSummary(error);
        if (HELD_QUEUE.test(summary.message)) throw error;
        context.logger.warn({ id: series.id, err: summary }, "Accrual of a retired series failed; it is retried after a day");
      }
    }
    const base = { series: all.length, pokes, retireSent, retiredSent, deferredDust: hourly.deferredDust, gridSampled: grid.length, gridSkipped, retryAfterMs };
    if (risk && slot !== lastGridSlot && !ids.length) lastGridSlot = slot;
    if (!ids.length) return { ...base, due: 0, accrued: 0, idle: retiredSent === 0 };

    const result = await accrueInBatches(context, ids, context.config.KEEPER_ACCRUE_BATCH);
    if (risk) lastGridSlot = slot;
    const summary = {
      ...base, due: ids.length, accrued: result.accrued.length, transactions: result.transactions,
      failed: result.failed.length, dryRun: result.simulated, idle: false, forced: force,
      lastAccruedAt: new Date(Number(nowSeconds) * 1000).toISOString(),
    };
    if (result.failed.length) {
      // Reported through the job's error path so the scheduler retries soon and the health route shows it.
      throw new Error(`Accrual failed for ${result.failed.length} of ${ids.length} series: ${result.failed[0]!.error}`);
    }
    return summary;
  };
}

/** The hourly part: held series whose last accrual is at least `threshold` old, with F28 dust deferred to daily. */
async function hourlyDue(
  context: KeeperContext, all: readonly ChainSeries[], nowSeconds: bigint, threshold: bigint, engineDust: ReadonlySet<Hex>,
  liveIds?: ReadonlySet<Hex>,
): Promise<{ due: Hex[]; deferredDust: number; retired: ChainSeries[] }> {
  // Dust on the engine's live list is skipped by accrueMany anyway: never pay to send it.
  const aged = all.filter((series) => nowSeconds - series.lastAccrual >= threshold && !engineDust.has(series.id));
  if (!aged.length) return { due: [], deferredDust: 0, retired: [] };
  // Only series somebody holds can change: a zero-supply series has nothing to shrink.
  const supplies = await chunkedMulticall(context, aged.map((series: ChainSeries) => ({
    address: series.token, abi: OptionTokenAbi, functionName: "totalSupply",
  }))) as bigint[];
  const heldAll = aged.filter((_, index) => BigInt(supplies[index]!) > 0n);
  // R15: held but off the engine's live list = retired. accrueMany skips it without moving lastAccrual, so it would be due on
  // every run for ever; it goes to the daily single accrual instead.
  const retired = liveIds ? heldAll.filter((series) => !liveIds.has(series.id)) : [];
  const held = liveIds ? heldAll.filter((series) => liveIds.has(series.id)) : heldAll;
  if (!held.length) return { due: [], deferredDust: 0, retired };

  // F28: dust (outstanding value under KEEPER_ACCRUE_DUST_USDG) is accrued lazily, not hourly. Trades accrue first anyway,
  // so the only cost of waiting is a book value that lags by at most the dust threshold per series. Unknown value = not dust.
  const supplyOf = new Map(aged.map((series, index) => [series.id, BigInt(supplies[index]!)]));
  const marks = await latestMarks(context, held.map((series) => series.id));
  const dustAfter = BigInt(context.config.KEEPER_ACCRUE_DUST_MAX_AGE_SECONDS ?? 86_400);
  const dustLimit = Number(context.config.KEEPER_ACCRUE_DUST_USDG ?? 1);
  let deferredDust = 0;
  const due = held.filter((series) => {
    const mark = marks.get(series.id);
    if (mark === undefined || !(dustLimit > 0)) return true;
    const value = (Number(supplyOf.get(series.id)!) / 1e18) * (Number(series.norm) / 1e18) * mark;
    if (value >= dustLimit) return true;
    if (nowSeconds - series.lastAccrual >= dustAfter) return true;
    deferredDust++;
    return false;
  });
  return { due: due.map((series) => series.id), deferredDust, retired };
}
