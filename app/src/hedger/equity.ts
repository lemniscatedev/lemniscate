import type { Sql } from "postgres";
import { keccak256, stringToHex, type Address, type Hex } from "viem";
import { type IHedgeVenue } from "./types";
import { haltFor, hedgeRevertOf, type HedgerState } from "./service";

export interface EquityDeps {
  venues: readonly IHedgeVenue[];
  stocks: readonly Address[];
  nowSeconds: number;
  /** as_of of the last post seen on chain / in the database, seconds (0 if none). */
  lastPostedAsOf: number;
  intervalSeconds: number;
  dryRun: boolean;
  /** Sends pool.postHedgeEquity(equityUsdg, asOf, ref). */
  post: (equityUsdg: bigint, asOf: bigint, ref: Hex) => Promise<{ hash?: string | undefined }>;
  /** Hedger state: a post refused with PerpEquityCap or HedgerFrozen stops posts for an hour (decision 39). */
  state?: Pick<HedgerState, "equityHalted">;
}

export type EquityOutcome =
  | { posted: true; equityUsdg: bigint; ref: Hex; hash?: string | undefined }
  | { posted: false; reason: "interval" | "dry_run" | "venue_unhealthy" | "no_perp_venue" | "halted"; equityUsdg?: bigint; ref?: Hex; unhealthy?: string[]; until?: string };

/** The venue snapshot that is hashed into `ref`. Order and shape are fixed so the hash is reproducible. */
export async function venueSnapshot(venues: readonly IHedgeVenue[], stocks: readonly Address[], asOf: number) {
  const entries = [];
  for (const venue of [...venues].sort((a, b) => a.name.localeCompare(b.name))) {
    const positions: Record<string, string> = {};
    for (const stock of [...stocks].map((s) => s.toLowerCase() as Address).sort()) {
      positions[stock] = (await venue.netPosition(stock)).toString();
    }
    entries.push({ venue: venue.name, equityUsdg: (await venue.equityUsdg()).toString(), positions });
  }
  return { asOf, venues: entries };
}

export const snapshotRef = (snapshot: unknown): Hex => keccak256(stringToHex(JSON.stringify(snapshot)));

/** R5. Hedge equity = sum of venue equity (spot: wallet USDG + stock at TWAP; perp: account equity). Posted once per
 * interval. Fails closed: any unhealthy venue, or any error reading one, means nothing is posted. */
export async function postHedgeEquityOnce(input: EquityDeps): Promise<EquityOutcome> {
  // Only off-chain (perp) venues are posted (decision 19): the pool's spot hedge is valued on chain inside NAV. With no
  // perp venue there is nothing to post, and posting a zero would arm pool.hedgeStale() for no reason.
  const deps = { ...input, venues: input.venues.filter((v) => v.postsEquity !== false) };
  if (!deps.venues.length) return { posted: false, reason: "no_perp_venue" };
  const halt = input.state?.equityHalted;
  if (halt && halt.untilMs > deps.nowSeconds * 1000) return { posted: false, reason: "halted", until: new Date(halt.untilMs).toISOString() };
  if (deps.nowSeconds - deps.lastPostedAsOf < deps.intervalSeconds) return { posted: false, reason: "interval" };
  const health = await Promise.all(deps.venues.map(async (v) => ({ name: v.name, ok: await v.healthy().catch(() => false) })));
  const unhealthy = health.filter((h) => !h.ok).map((h) => h.name);
  if (unhealthy.length) return { posted: false, reason: "venue_unhealthy", unhealthy };
  let snapshot;
  try { snapshot = await venueSnapshot(deps.venues, deps.stocks, deps.nowSeconds); }
  catch { return { posted: false, reason: "venue_unhealthy", unhealthy: ["snapshot_read_failed"] }; }
  const equityUsdg = snapshot.venues.reduce((sum, v) => sum + BigInt(v.equityUsdg), 0n);
  const ref = snapshotRef(snapshot);
  if (deps.dryRun) return { posted: false, reason: "dry_run", equityUsdg, ref };
  try {
    const { hash } = await deps.post(equityUsdg, BigInt(deps.nowSeconds), ref);
    if (input.state) delete input.state.equityHalted;
    return { posted: true, equityUsdg, ref, hash };
  } catch (error) {
    const revert = hedgeRevertOf(error);
    if (!revert || !input.state) throw error;
    // Decision 39: a refused post is not retried for an hour (the cap or the freeze will not change by itself sooner).
    input.state.equityHalted = haltFor(revert === "HedgeLossBudget" ? "PerpEquityCap" : revert, deps.nowSeconds * 1000);
    return { posted: false, reason: "halted", equityUsdg, ref, until: new Date(input.state.equityHalted.untilMs).toISOString() };
  }
}

/** Unix seconds of the newest indexed hedge-equity post (0 when none). Epoch is computed in SQL: the services' client is
 * wrapped by drizzle, which makes timestamps come back as strings, so `.getTime()` on the row crashed the equity job. */
export async function lastEquityPostAsOf(sql: Sql): Promise<number> {
  const [row] = await sql<{ as_of: string | null }[]>`select extract(epoch from max(as_of))::bigint::text as as_of from hedge_equity_posts`;
  return row?.as_of ? Number(row.as_of) : 0;
}
