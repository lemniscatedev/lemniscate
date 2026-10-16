import type { Hex } from "viem";
import type { LemniscateDbClient } from "../../db/client";
import { saveJobMeta, type KeeperContext } from "../context";
import { EMPTY_ROOT, merkleProof, merkleRoot, sortedUnique, verifyMerkleProof } from "../merkle";
import {
  LEAF_KIND, navLeaf, tradeLeaf, volPostLeaf, type NavRow, type TradeRow, type VolPostRow,
} from "../receipts-leaves";

const HOUR_MS = 3_600_000;
/** The most hours a single run closes (a keeper that was down for days catches up over a few runs). */
const MAX_HOURS_PER_RUN = 48;
/** A first run, with no receipt yet, starts this many hours back at most. */
const FIRST_RUN_LOOKBACK_HOURS = 24;

type Sql = LemniscateDbClient["sql"];

export interface HourLeaves {
  trades: { row: TradeRow; leaf: Hex }[];
  volPosts: { row: VolPostRow; leaf: Hex }[];
  navs: { row: NavRow; leaf: Hex }[];
  all: Hex[];
}

export const hourStart = (date: Date): Date => new Date(Math.floor(date.getTime() / HOUR_MS) * HOUR_MS);

/** The leaves of the hour [start, start + 1h): trades, vol posts and pool NAV snapshots, read from the indexed tables. */
export async function loadHourLeaves(sql: Sql, start: Date): Promise<HourLeaves> {
  const from = start.toISOString();
  const to = new Date(start.getTime() + HOUR_MS).toISOString();
  const [trades, volPosts, navs] = await Promise.all([
    sql<TradeRow[]>`select tx_hash, log_index, ts, series_id, account, recipient, side, units::text, shares::text, usdg::text,
        v_mark::text, sigma_bps, session from trades where ts >= ${from} and ts < ${to} order by tx_hash, log_index`,
    sql<VolPostRow[]>`select tx_hash, log_index, ts, stock_token, speed, sigma_bps, skew_k::text, event_bump_bps, buy_block_from,
        buy_block_to, valid_until, nonce::text from vol_posts where ts >= ${from} and ts < ${to} order by tx_hash, log_index`,
    sql<NavRow[]>`select ts, block::text, usdg::text, hedge_equity::text, option_liability::text, reserve::text, nav::text,
        nav_per_share::text from pool_nav where ts >= ${from} and ts < ${to} order by ts`,
  ]);
  const withLeaf = <T>(rows: T[], make: (row: T) => Hex) => rows.map((row) => ({ row, leaf: make(row) }));
  const result = {
    trades: withLeaf(trades, tradeLeaf), volPosts: withLeaf(volPosts, volPostLeaf), navs: withLeaf(navs, navLeaf), all: [] as Hex[],
  };
  result.all = [...result.trades, ...result.volPosts, ...result.navs].map((entry) => entry.leaf);
  return result;
}

export interface Receipt {
  periodStart: Date; periodEnd: Date; root: Hex; leafCount: number; tradesCount: number; volPostsCount: number; navCount: number;
}

export function buildReceipt(start: Date, leaves: HourLeaves): Receipt {
  const unique = sortedUnique(leaves.all);
  return {
    periodStart: start, periodEnd: new Date(start.getTime() + HOUR_MS), root: unique.length ? merkleRoot(unique) : EMPTY_ROOT,
    leafCount: unique.length, tradesCount: leaves.trades.length, volPostsCount: leaves.volPosts.length, navCount: leaves.navs.length,
  };
}

/** Closes the hours up to (not including) the one `chainTime` is in, once the indexer has passed their end. */
export async function closeHours(sql: Sql, chainTime: Date, indexedUntil: Date): Promise<Receipt[]> {
  const horizon = hourStart(chainTime);
  const last = (await sql<{ period_start: Date }[]>`select max(period_start) as period_start from receipts`)[0]?.period_start;
  let next = last ? new Date(new Date(last).getTime() + HOUR_MS) : new Date(horizon.getTime() - FIRST_RUN_LOOKBACK_HOURS * HOUR_MS);
  const closed: Receipt[] = [];
  while (next < horizon && closed.length < MAX_HOURS_PER_RUN) {
    // An hour is final only when the indexer has read past its end (events are ingested after confirmations).
    if (indexedUntil.getTime() < next.getTime() + HOUR_MS) break;
    const receipt = buildReceipt(next, await loadHourLeaves(sql, next));
    await sql`insert into receipts (period_start, period_end, root, leaf_count, trades_count, vol_posts_count, nav_count)
      values (${receipt.periodStart.toISOString()}, ${receipt.periodEnd.toISOString()}, ${receipt.root}, ${receipt.leafCount},
        ${receipt.tradesCount}, ${receipt.volPostsCount}, ${receipt.navCount})
      on conflict (period_start) do nothing`;
    closed.push(receipt);
    next = new Date(next.getTime() + HOUR_MS);
  }
  return closed;
}

/** R6: hourly Merkle root of the previous hour(s). */
export async function writeReceipts(context: KeeperContext): Promise<Record<string, unknown>> {
  const metadata = await context.metadata();
  const chainTime = context.now(metadata);
  const indexedSeconds = Number(metadata.chainTimestamp);
  if (!Number.isFinite(indexedSeconds) || indexedSeconds <= 0) throw new Error("Waiting for the indexer's first block time");
  const closed = await closeHours(context.sql, chainTime, new Date(indexedSeconds * 1000));
  await saveJobMeta(context, "receipts", {
    lastPeriodStart: closed.at(-1)?.periodStart.toISOString() ?? null,
  });
  return { closed: closed.length, periods: closed.map((receipt) => ({ start: receipt.periodStart.toISOString(), leaves: receipt.leafCount, root: receipt.root })) };
}

export interface ReceiptProof {
  periodStart: Date; root: Hex; leaf: Hex; proof: Hex[]; verified: boolean;
}

/** Proof that one trade, vol post or NAV snapshot is part of the stored root of its hour. Rebuilds the hour from the
 * indexed tables and refuses (undefined) when the rebuilt root differs from the stored one: the proof is only worth
 * handing out if the data still matches what was committed. */
export async function proveLeaf(sql: Sql, periodStart: Date, leaf: Hex): Promise<ReceiptProof | undefined> {
  const stored = (await sql<{ root: string }[]>`select root from receipts where period_start = ${periodStart.toISOString()}`)[0];
  if (!stored) return undefined;
  const leaves = await loadHourLeaves(sql, periodStart);
  if (merkleRoot(leaves.all).toLowerCase() !== stored.root.toLowerCase() && !(leaves.all.length === 0 && stored.root === EMPTY_ROOT)) return undefined;
  const proof = merkleProof(leaves.all, leaf);
  if (!proof) return undefined;
  return { periodStart, root: stored.root as Hex, leaf, proof, verified: verifyMerkleProof(leaf, proof, stored.root as Hex) };
}

export { LEAF_KIND };
