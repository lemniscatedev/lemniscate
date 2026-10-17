import { encodeFunctionData, formatEther, type Address, type Hex } from "viem";
import { OptionEngineAbi } from "../../abi";
import { safeErrorSummary } from "../../log";
import { saveJobMeta, type IndexerMetadata, type KeeperContext } from "../context";

// ---------------------------------------------------------------------------------------------------------------
// Thresholds (spec section 8 and todo 13 R5). Constants, not env: changing one is a reviewed code change.
// ---------------------------------------------------------------------------------------------------------------
/** Pool NAV per share down more than this from its 30-day high pauses buys. */
export const DRAWDOWN_PAUSE_PCT = 15;
export const DRAWDOWN_WINDOW_DAYS = 30;
/** A hedge venue reported unhealthy for longer than this pauses buys. */
export const HEDGE_VENUE_DOWN_MS = 15 * 60_000;
/** Hedge equity is posted hourly; two missed posts make it stale. Only checked once an equity above zero was posted. */
export const HEDGE_EQUITY_MAX_AGE_MS = 3 * 3_600_000;
/** A name whose vol posts have been stale this long has its series' buys paused (the engine already refuses them). */
export const VOL_STALE_PAUSE_MS = 15 * 60_000;
/** Indexed data older than this is not trusted to start a pause; the monitor warns instead. */
export const INDEXED_DATA_MAX_AGE_MS = 30 * 60_000;
export const INDEXER_SILENCE_MS = 5 * 60_000;
/** Warn (never pause) when the simulated stress loss of a name passes this share of NAV. */
export const STRESS_WARN_BPS = 1000;
/** Most series paused in one run when a single name goes stale. */
const MAX_SERIES_PAUSES_PER_RUN = 60;

export type RiskScope = { kind: "global" } | { kind: "stock"; stockToken: Address; name: string };

export interface RiskTrigger {
  /** Stable key for cool-down bookkeeping. */
  key: string;
  reason: string;
  scope: RiskScope;
}

export interface RiskInputs {
  now: Date;
  /** The keeper process's wall clock. The indexer stamps its liveness (last clean poll, last snapshot) in wall time,
   * which differs from the chain clock `now` on a fork moved with evm_increaseTime. Defaults to `now`. */
  wallNow?: Date;
  indexer: Pick<IndexerMetadata, "indexerLastOk" | "indexerLastError" | "lastSnapshotAt" | "lagBlocks">;
  pool: { current: number; peak: number; latestAt: Date | null };
  names: {
    name: string; stockToken: Address;
    netDelta: number; netGamma: number; netVega: number; stressLossBps: number; limitsAt: Date | null;
    session: string | null; fresh: boolean | null; volStale: boolean | null; volStaleSince: Date | null;
  }[];
  hedgeEquity: { equityUsdg: number; asOf: Date } | null;
  /** keeper_status 'hedger' meta, written by the hedger service; absent when no hedger / venue runs. */
  hedger: {
    venueHealthy?: boolean | undefined; venueUnhealthySince?: string | null | undefined;
    /** F30: name -> ISO time since which the hedger could not hedge it (no route, no venue, failing trades). */
    unhedgedNames?: Record<string, string> | undefined;
  } | null;
}

export interface RiskEvaluation {
  triggers: RiskTrigger[];
  warnings: string[];
  drawdownPct: number;
  dataTrusted: boolean;
}

/** The pure decision: from indexed state and the clock to the pauses that are due and the warnings to show. It can
 * only ever ask for a buy pause. Sells, withdrawals and claims have no action here, by design. */
export function evaluateRisk(input: RiskInputs): RiskEvaluation {
  const { now } = input;
  const warnings: string[] = [];
  const triggers: RiskTrigger[] = [];
  const age = (date: Date | null) => (date ? now.getTime() - date.getTime() : Infinity);

  const okAt = Date.parse(input.indexer.indexerLastOk ?? "");
  const snapshotAt = Date.parse(input.indexer.lastSnapshotAt ?? "");
  const lag = Number(input.indexer.lagBlocks ?? 0);
  const wall = (input.wallNow ?? now).getTime();
  let dataTrusted = true;
  if (!Number.isFinite(okAt) || wall - okAt > INDEXER_SILENCE_MS || input.indexer.indexerLastError) {
    dataTrusted = false; warnings.push("Indexer has not reported a clean poll recently; indexed risk data is not trusted");
  } else if (!Number.isFinite(snapshotAt) || wall - snapshotAt > INDEXED_DATA_MAX_AGE_MS) {
    dataTrusted = false; warnings.push("Latest indexer snapshot is too old; indexed risk data is not trusted");
  } else if (Number.isFinite(lag) && lag > 60) {
    dataTrusted = false; warnings.push("Indexer is more than 60 blocks behind; indexed risk data is not trusted");
  }

  const drawdownPct = input.pool.peak > 0 ? Math.max(0, (input.pool.peak - input.pool.current) / input.pool.peak * 100) : 0;
  if (dataTrusted) {
    if (drawdownPct > DRAWDOWN_PAUSE_PCT) {
      triggers.push({
        key: "drawdown", scope: { kind: "global" },
        reason: `pool NAV per share is ${drawdownPct.toFixed(1)}% below its ${DRAWDOWN_WINDOW_DAYS}-day high (limit ${DRAWDOWN_PAUSE_PCT}%)`,
      });
    } else if (drawdownPct > DRAWDOWN_PAUSE_PCT * 2 / 3) {
      warnings.push(`Pool drawdown ${drawdownPct.toFixed(1)}% is approaching the ${DRAWDOWN_PAUSE_PCT}% pause level`);
    }

    const equity = input.hedgeEquity;
    if (equity && equity.equityUsdg > 0 && now.getTime() - equity.asOf.getTime() > HEDGE_EQUITY_MAX_AGE_MS) {
      triggers.push({
        key: "hedge-equity-stale", scope: { kind: "global" },
        reason: `hedge equity was last posted ${Math.round((now.getTime() - equity.asOf.getTime()) / 60_000)} minutes ago`,
      });
    }

    const stale = input.names.filter((entry) => entry.volStale === true
      && entry.volStaleSince && now.getTime() - entry.volStaleSince.getTime() > VOL_STALE_PAUSE_MS);
    const withVol = input.names.filter((entry) => entry.volStale !== null);
    if (stale.length && stale.length === withVol.length) {
      triggers.push({
        key: "vol-stale:all", scope: { kind: "global" },
        reason: `vol posts are stale for every name (${stale.map((entry) => entry.name).join(", ")})`,
      });
    } else {
      for (const entry of stale) {
        triggers.push({
          key: `vol-stale:${entry.name}`, scope: { kind: "stock", stockToken: entry.stockToken, name: entry.name },
          reason: `vol posts for ${entry.name} have been stale for more than ${VOL_STALE_PAUSE_MS / 60_000} minutes`,
        });
      }
    }

    for (const entry of input.names) {
      if (entry.stressLossBps > STRESS_WARN_BPS) warnings.push(`${entry.name} stress loss is ${entry.stressLossBps.toFixed(0)} bps of NAV`);
      if (entry.fresh === false && (entry.session === "REGULAR" || entry.session === "EXTENDED" || entry.session === "HALTED")) {
        warnings.push(`${entry.name} price feed is not fresh in session ${entry.session}`);
      }
      if (age(entry.limitsAt) > INDEXED_DATA_MAX_AGE_MS) warnings.push(`${entry.name} limits row is older than 30 minutes`);
    }
  }

  const hedger = input.hedger;
  if (hedger?.venueHealthy === false) {
    const since = Date.parse(hedger.venueUnhealthySince ?? "");
    if (Number.isFinite(since) && now.getTime() - since > HEDGE_VENUE_DOWN_MS) {
      triggers.push({
        key: "hedge-venue", scope: { kind: "global" },
        reason: `hedge venue unavailable for ${Math.round((now.getTime() - since) / 60_000)} minutes (limit ${HEDGE_VENUE_DOWN_MS / 60_000})`,
      });
    } else warnings.push("Hedge venue is reported unhealthy");
  }
  // F30: a name the hedger cannot hedge keeps its delta on the pool. After the same grace as a down venue, its buys pause
  // (sells and exits are never touched). Independent of the indexer's trust: this comes from the hedger's own report.
  for (const [name, sinceIso] of Object.entries(hedger?.unhedgedNames ?? {})) {
    const entry = input.names.find((candidate) => candidate.name === name);
    const since = Date.parse(sinceIso);
    if (!entry || !Number.isFinite(since)) continue;
    if (now.getTime() - since > HEDGE_VENUE_DOWN_MS) {
      triggers.push({
        key: `hedge-route:${name}`, scope: { kind: "stock", stockToken: entry.stockToken, name },
        reason: `${name} could not be hedged for ${Math.round((now.getTime() - since) / 60_000)} minutes (limit ${HEDGE_VENUE_DOWN_MS / 60_000})`,
      });
    } else warnings.push(`${name} could not be hedged in the last pass`);
  }
  return { triggers, warnings, drawdownPct, dataTrusted };
}

interface ActionState { at: string; done: boolean; paused: string[] }

const toDate = (value: unknown): Date | null => {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isFinite(date.getTime()) ? date : null;
};

/** R5: reads indexed state, decides with evaluateRisk, and sends buy pauses through the guardian-role keeper key. */
export function createRiskJob(context: KeeperContext) {
  const engine = context.deployment.contracts.engine as Address;
  let nextBalanceCheck = 0;
  let balance = 0n;

  async function load(now: Date, metadata: IndexerMetadata): Promise<RiskInputs> {
    const windowStart = new Date(now.getTime() - DRAWDOWN_WINDOW_DAYS * 86_400_000).toISOString();
    const [poolRows, limits, ticks, equityRows, hedgerRows] = await Promise.all([
      context.sql<{ current: string | null; peak: string | null; latest_at: Date | string | null }[]>`
        select (select nav_per_share from pool_nav order by ts desc limit 1) as current,
          (select ts from pool_nav order by ts desc limit 1) as latest_at,
          max(nav_per_share) as peak from pool_nav where ts >= ${windowStart}`,
      context.sql<{ name: string; ts: Date | string; stock_token: string; net_delta: string; net_gamma: string; net_vega: string; stress_loss_bps: string }[]>`
        select distinct on (name) name, ts, stock_token, net_delta, net_gamma, net_vega, stress_loss_bps
        from limits_state order by name, ts desc`,
      context.sql<{ stock_token: string; name: string | null; session: string; fresh: boolean; vol_stale: boolean | null; stale_since: Date | string | null }[]>`
        select t.stock_token, t.name, t.session, t.fresh, t.vol_stale,
          (select min(x.ts) from ticks x where x.stock_token = t.stock_token and t.vol_stale = true
             and x.ts > coalesce((select max(y.ts) from ticks y where y.stock_token = t.stock_token and y.vol_stale = false), '-infinity'::timestamptz)
             and x.vol_stale = true) as stale_since
        from (select distinct on (stock_token) * from ticks order by stock_token, ts desc) t`,
      context.sql<{ equity_usdg: string; as_of: Date | string }[]>`
        select equity_usdg, as_of from hedge_equity_posts order by ts desc limit 1`,
      context.sql<{ meta: Record<string, unknown> }[]>`select meta from keeper_status where job = 'hedger'`,
    ]);
    const pool = poolRows[0];
    const tickByStock = new Map(ticks.map((row) => [row.stock_token, row]));
    const hedger = hedgerRows[0]?.meta;
    return {
      now,
      indexer: metadata,
      pool: { current: Number(pool?.current ?? 0), peak: Number(pool?.peak ?? 0), latestAt: toDate(pool?.latest_at) },
      names: limits.map((row) => {
        const tick = tickByStock.get(row.stock_token);
        return {
          name: row.name, stockToken: row.stock_token as Address,
          netDelta: Number(row.net_delta), netGamma: Number(row.net_gamma), netVega: Number(row.net_vega),
          stressLossBps: Number(row.stress_loss_bps), limitsAt: toDate(row.ts),
          session: tick?.session ?? null, fresh: tick ? tick.fresh : null,
          volStale: tick ? tick.vol_stale : null, volStaleSince: toDate(tick?.stale_since),
        };
      }),
      hedgeEquity: equityRows[0] ? { equityUsdg: Number(equityRows[0].equity_usdg), asOf: toDate(equityRows[0].as_of)! } : null,
      hedger: hedger ? {
        venueHealthy: hedger.venueHealthy as boolean | undefined, venueUnhealthySince: (hedger.venueUnhealthySince as string | null | undefined) ?? null,
        unhedgedNames: (hedger.unhedgedNames as Record<string, string> | undefined) ?? {},
      } : null,
    };
  }

  async function seriesOfStock(stockToken: Address): Promise<Hex[]> {
    const rows = await context.sql<{ id: string }[]>`
      select id from series where stock_token = ${stockToken} and archived = false and buyable = true order by id`;
    return rows.map((row) => row.id as Hex);
  }

  return async (): Promise<Record<string, unknown>> => {
    const metadata = await context.metadata();
    const now = context.now(metadata);
    const signer = context.clients.walletClient?.account?.address;
    if (signer && Date.now() >= nextBalanceCheck) {
      balance = await context.clients.txClient.getBalance({ address: signer });
      nextBalanceCheck = Date.now() + 30 * 60_000;
    }
    // chainClock() is wall time except on the fork; there the indexer's liveness stamps are still wall time.
    const inputs = { ...(await load(now, metadata)), wallNow: context.config.NETWORK === "fork" ? new Date() : now };
    const evaluation = evaluateRisk(inputs);
    const warnings = [...evaluation.warnings];
    if (signer && balance < 2_000_000_000_000_000n) warnings.push("Keeper ETH balance is below 0.002");
    const sessions = await context.sql<{ meta: Record<string, unknown> }[]>`select meta from keeper_status where job = 'sessions'`;
    if (Number(sessions[0]?.meta.horizon ?? 0) - now.getTime() / 1000 < 3 * 86400) warnings.push("Market sessions expire within three days");

    const status = await context.sql<{ meta: Record<string, unknown> }[]>`select meta from keeper_status where job = 'risk'`;
    const states: Record<string, ActionState> = { ...((status[0]?.meta.actions as Record<string, ActionState> | undefined) ?? {}) };
    const cooldownMs = context.config.KEEPER_RISK_COOLDOWN_SECONDS * 1000;
    const acted: string[] = [];
    const wouldPause: string[] = [];
    const failures: string[] = [];

    for (const trigger of evaluation.triggers) {
      const state = states[trigger.key];
      if (state?.done && now.getTime() - Date.parse(state.at) < cooldownMs) continue;
      const fresh: ActionState = state && !state.done ? state : { at: now.toISOString(), done: false, paused: [] };
      try {
        if (trigger.scope.kind === "global") {
          context.logger.fatal({ key: trigger.key, reason: trigger.reason }, "RISK_PAUSE: pausing new buys");
          const result = await context.tx.submit({
            label: `risk:${trigger.key}`, to: engine,
            data: encodeFunctionData({ abi: OptionEngineAbi, functionName: "setBuysPaused", args: [true] }),
          });
          if (result.simulated) wouldPause.push(trigger.key);
          else { fresh.done = true; acted.push(trigger.key); }
        } else {
          const all = await seriesOfStock(trigger.scope.stockToken);
          const ids = all.filter((id) => !fresh.paused.includes(id));
          context.logger.fatal({ key: trigger.key, reason: trigger.reason, series: ids.length }, "RISK_PAUSE: pausing buys for one name");
          let simulated = false;
          for (const id of ids.slice(0, MAX_SERIES_PAUSES_PER_RUN)) {
            const result = await context.tx.submit({
              label: `risk:${trigger.key}`, to: engine,
              data: encodeFunctionData({ abi: OptionEngineAbi, functionName: "setSeriesBuysPaused", args: [id, true] }),
            });
            if (result.simulated) simulated = true; else fresh.paused.push(id);
          }
          if (simulated) wouldPause.push(trigger.key);
          else {
            fresh.done = all.every((id) => fresh.paused.includes(id));
            acted.push(trigger.key);
          }
        }
        fresh.at = now.toISOString();
        if (!wouldPause.includes(trigger.key)) states[trigger.key] = fresh;
      } catch (error) {
        const summary = safeErrorSummary(error);
        failures.push(`${trigger.key}: ${summary.message}`);
        context.logger.error({ key: trigger.key, err: summary }, "Risk pause failed");
      }
    }
    for (const warning of warnings) context.logger.warn({ warning }, "Keeper risk warning");

    const names = Object.fromEntries(inputs.names.map((entry) => [entry.name, {
      netDelta: entry.netDelta, netGamma: entry.netGamma, netVega: entry.netVega, stressLossBps: entry.stressLossBps,
    }]));
    await saveJobMeta(context, "risk", { actions: states });
    if (failures.length) throw new Error(`Risk pause failed: ${failures[0]}`);
    return {
      warnings, drawdownPct: evaluation.drawdownPct, dataTrusted: evaluation.dataTrusted,
      triggers: evaluation.triggers.map((trigger) => ({ key: trigger.key, reason: trigger.reason })),
      acted, wouldPause, names, keeperEth: formatEther(balance),
    };
  };
}
