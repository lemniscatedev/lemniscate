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

/** R15 + R07 (decision 57): the engine's accrueMany accrues retired dust series (supply left, off the live list) and re-lists
 * one worth the minimum again, so they go to accrueMany in the dust pass. When the pass is due, every dust-tier series not
 * accrued in the last grid slot is sent with it, so the dust tier's NAV-mark pass completes in one keeper run. */
const DUST_PASS_MIN_AGE_SECONDS = 300n;

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

/** Funding sampling grid (review F11/F34, decision 35): every live series of a name in REGULAR or EXTENDED is accrued once
 * per slot, whatever its lastAccrual, so a holder who accrues at prints of their choosing cannot suppress the keeper's
 * samples. Review R3-01 (decision 67): the grid takes a name WHOLE, i.e. every series in the engine's live NAV tier (tier 0:
 * on the live list and worth at least the minimum trade at its mark, archived or not, whatever its size), because the
 * engine completes a name's live-tier pass only when every one of them is re-marked; one series left to the hourly catch-up
 * held the name's claim envelope to the hour. R13 still bounds the work: at most KEEPER_ACCRUE_GRID_MAX_SERIES per slot.
 * Every name's R13 part (non-archived series worth KEEPER_ACCRUE_GRID_MIN_VALUE_USDG or more) is admitted first, then whole
 * names largest first in what is left (selectGrid), so an attacker holding a dollar in hundreds of archived series can
 * neither bill the keeper's gas past the budget nor push any name's honest positions off the grid. A name that does not fit
 * whole is reported with an ALERT (its pass is hourly until the budget is raised). */
export const ACCRUE_GRID_SECONDS = 300n;
/** R3-01 alert: a name in session whose oldest tier-0 mark is older than this has a stale live-tier NAV pass. */
export const GRID_STALE_SECONDS = 2n * ACCRUE_GRID_SECONDS;

export interface GridEntry { id: Hex; stock: Address; value: bigint; archived: boolean }

/** R3-01 grid selection (pure), in two phases so one name's dust cannot starve another name's real positions:
 * (a) every name's R13 part (non-archived, worth `minValue` or more), the most valuable first across names, within `budget`;
 * (b) then the rest of each name's tier-0 series, largest name first, a name only WHOLE in the budget left.
 * `tier0`: the engine's live-tier series (live list, value at the mark >= the minimum trade) of names in session. Returns the
 * ids to sample, the names on the grid whole and the names split (some of their tier-0 series left to the hourly catch-up). */
export function selectGrid(tier0: readonly GridEntry[], budget: number, minValue: bigint):
  { grid: Hex[]; whole: string[]; split: string[]; skipped: number } {
  const desc = (a: bigint, b: bigint) => (a === b ? 0 : a > b ? -1 : 1);
  const byName = new Map<string, { value: bigint; entries: GridEntry[] }>();
  for (const entry of tier0) {
    const key = entry.stock.toLowerCase();
    const name = byName.get(key) ?? { value: 0n, entries: [] };
    name.value += entry.value;
    name.entries.push(entry);
    byName.set(key, name);
  }
  const cap = Math.max(0, budget);
  // (a) the R13 parts of all names first
  const r13 = tier0.filter((entry) => !entry.archived && entry.value >= minValue).sort((a, b) => desc(a.value, b.value));
  const taken = new Set<Hex>(r13.slice(0, cap).map((entry) => entry.id));
  // (b) whole names with what is left
  const whole: string[] = [];
  const split: string[] = [];
  for (const [stock, name] of [...byName.entries()].sort((a, b) => desc(a[1].value, b[1].value))) {
    const rest = name.entries.filter((entry) => !taken.has(entry.id));
    if (taken.size + rest.length <= cap) {
      for (const entry of rest) taken.add(entry.id);
      whole.push(stock);
    } else {
      split.push(stock);
    }
  }
  const grid = tier0.filter((entry) => taken.has(entry.id)).sort((a, b) => desc(a.value, b.value)).map((entry) => entry.id);
  return { grid, whole, split, skipped: tier0.length - grid.length };
}

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

    // F11 grid sample: once per slot, every tier-0 series of each name in session, whole names (R3-01) within the R13 budget.
    let grid: Hex[] = [];
    let gridSkipped = 0;
    let gridSplit: string[] = [];
    let staleTier0: string[] = [];
    if (risk && slot !== lastGridSlot) {
      const seriesOf = new Map(all.map((series) => [series.id, series]));
      const minValue = BigInt(Math.round(Number(context.config.KEEPER_ACCRUE_GRID_MIN_VALUE_USDG ?? 100) * 1e6)) * 10n ** 12n;
      // The engine's live tier: on the live list and worth the minimum trade at the mark (EngineMarkLib's tier line).
      const tier0 = risk.live.filter((entry) => !retire.dust.has(entry.id) && entry.value >= risk.dustWad);
      const inSession = await liveSessionStocks(context, [...new Set(tier0.map((entry) => entry.stock))]).catch((error: unknown) => {
        context.logger.warn({ err: safeErrorSummary(error) }, "PriceGuard sessions unreadable; no grid sample this run");
        return new Set<string>();
      });
      const sampled = tier0.filter((entry) => inSession.has(entry.stock.toLowerCase()))
        .map((entry) => ({ ...entry, archived: seriesOf.get(entry.id)?.archived ?? false }));
      const budget = Math.max(0, Math.floor(Number(context.config.KEEPER_ACCRUE_GRID_MAX_SERIES ?? 450)));
      const selection = selectGrid(sampled, budget, minValue);
      grid = selection.grid;
      gridSkipped = selection.skipped;
      gridSplit = selection.split;
      if (gridSplit.length) context.logger.warn({ names: gridSplit, budget, skipped: gridSkipped },
        "ALERT: names in session do not fit the 5-minute funding grid whole (KEEPER_ACCRUE_GRID_MAX_SERIES); their live-tier NAV pass is hourly, raise the budget");
      // R3-01 (3): a name in session whose oldest tier-0 mark is more than two grid intervals old (checked once the keeper
      // has been gridding: the first run after a start sees every mark as old).
      if (lastGridSlot !== undefined) {
        const oldest = new Map<string, bigint>();
        for (const entry of sampled) {
          const at = seriesOf.get(entry.id)?.lastAccrual;
          if (at === undefined) continue;
          const key = entry.stock.toLowerCase();
          const prev = oldest.get(key);
          if (prev === undefined || at < prev) oldest.set(key, at);
        }
        staleTier0 = [...oldest.entries()].filter(([, at]) => nowSeconds - at > GRID_STALE_SECONDS).map(([stock]) => stock);
        if (staleTier0.length) context.logger.warn({ names: staleTier0, maxAgeSeconds: Number(GRID_STALE_SECONDS) },
          "ALERT: a live-tier series of a name in session was not re-marked for two grid intervals; the name's NAV bounds are stale");
      }
    }

    const liveIds = risk ? new Set<Hex>(risk.live.map((entry) => entry.id)) : undefined;
    const hourly = await hourlyDue(context, all, nowSeconds, threshold, retire.dust, liveIds);
    const ids = [...new Set<Hex>([...grid, ...hourly.due])];
    const base = { series: all.length, pokes, retireSent, retired: hourly.retired, dustPass: hourly.dustPass, deferredDust: hourly.deferredDust,
      gridSampled: grid.length, gridSkipped, gridSplit: gridSplit.length, staleTier0: staleTier0.length, retryAfterMs };
    if (risk && slot !== lastGridSlot && !ids.length) lastGridSlot = slot;
    if (!ids.length) return { ...base, due: 0, accrued: 0, idle: true };

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

/** The hourly part: held series whose last accrual is at least `threshold` old, plus the dust pass. Dust-tier series (retired
 * by the engine, dust on its live list, or F28 dust by indexed value) are accrued together once the oldest of them is
 * KEEPER_ACCRUE_DUST_MAX_AGE_SECONDS old (hourly by default, decision 57): the engine's accrueMany accrues retired series and
 * re-lists those worth the minimum again (R07), and a dust pass that re-marks the whole tier resets its NAV-mark envelope. */
async function hourlyDue(
  context: KeeperContext, all: readonly ChainSeries[], nowSeconds: bigint, threshold: bigint, engineDust: ReadonlySet<Hex>,
  liveIds?: ReadonlySet<Hex>,
): Promise<{ due: Hex[]; deferredDust: number; retired: number; dustPass: number }> {
  const minAge = threshold < DUST_PASS_MIN_AGE_SECONDS ? threshold : DUST_PASS_MIN_AGE_SECONDS;
  const aged = all.filter((series) => nowSeconds - series.lastAccrual >= minAge);
  if (!aged.length) return { due: [], deferredDust: 0, retired: 0, dustPass: 0 };
  // Only series somebody holds can change: a zero-supply series has nothing to shrink.
  const supplies = await chunkedMulticall(context, aged.map((series: ChainSeries) => ({
    address: series.token, abi: OptionTokenAbi, functionName: "totalSupply",
  }))) as bigint[];
  const supplyOf = new Map(aged.map((series, index) => [series.id, BigInt(supplies[index]!)]));
  const held = aged.filter((series) => supplyOf.get(series.id)! > 0n);
  if (!held.length) return { due: [], deferredDust: 0, retired: 0, dustPass: 0 };

  // Held but off the engine's live list = retired (R07): dust tier. Dust on the live list (retireDust is retiring it) too.
  const retired = liveIds ? held.filter((series) => !liveIds.has(series.id)) : [];
  const retiredIds = new Set(retired.map((series) => series.id));
  // F28: dust by indexed value (outstanding value under KEEPER_ACCRUE_DUST_USDG). Unknown value = not dust.
  const marks = await latestMarks(context, held.filter((series) => !retiredIds.has(series.id) && !engineDust.has(series.id)).map((series) => series.id));
  const dustLimit = Number(context.config.KEEPER_ACCRUE_DUST_USDG ?? 1);
  const isIndexedDust = (series: ChainSeries): boolean => {
    const mark = marks.get(series.id);
    if (mark === undefined || !(dustLimit > 0)) return false;
    return (Number(supplyOf.get(series.id)!) / 1e18) * (Number(series.norm) / 1e18) * mark < dustLimit;
  };
  const dustTier = held.filter((series) => retiredIds.has(series.id) || engineDust.has(series.id) || isIndexedDust(series));
  const dustIds = new Set(dustTier.map((series) => series.id));
  const regular = held.filter((series) => !dustIds.has(series.id) && nowSeconds - series.lastAccrual >= threshold);

  const dustAfter = BigInt(context.config.KEEPER_ACCRUE_DUST_MAX_AGE_SECONDS ?? 3_600);
  const passDue = dustTier.some((series) => nowSeconds - series.lastAccrual >= dustAfter);
  const pass = passDue ? dustTier : [];
  return {
    due: [...regular, ...pass].map((series) => series.id),
    deferredDust: passDue ? 0 : dustTier.length,
    retired: retired.length,
    dustPass: pass.length,
  };
}
