import { keccak256, stringToHex, type Address, type Hex } from "viem";
import { type IHedgeVenue } from "./types";

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
}

export type EquityOutcome =
  | { posted: true; equityUsdg: bigint; ref: Hex; hash?: string | undefined }
  | { posted: false; reason: "interval" | "dry_run" | "venue_unhealthy" | "no_perp_venue"; equityUsdg?: bigint; ref?: Hex; unhealthy?: string[] };

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
  const { hash } = await deps.post(equityUsdg, BigInt(deps.nowSeconds), ref);
  return { posted: true, equityUsdg, ref, hash };
}
