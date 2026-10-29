// Reads the Writer Pool flows the points need from the indexer's tables (Postgres only, no RPC):
//  - pool_events kind 'deposit' (WriterPool Deposit: owner, assets, shares);
//  - transfers of the pool share token FROM a wallet (requestWithdraw escrow to the pool, or a transfer to anyone).
// Mints (from the zero address) are the deposits' own Transfer and burns leave from the pool itself: both are skipped.
import type { Sql } from "postgres";
import { fixed, type PoolFlow } from "./writer-points";

const ZERO = "0x0000000000000000000000000000000000000000";

export async function loadPoolFlows(sql: Sql, pool: string, untilSec?: number): Promise<PoolFlow[]> {
  const poolAddr = pool.toLowerCase();
  const until = untilSec === undefined ? null : new Date(untilSec * 1_000).toISOString();
  const deposits = await sql`
    SELECT account, block::text AS block, log_index, extract(epoch FROM ts)::bigint::text AS ts, assets::text AS assets, shares::text AS shares
    FROM pool_events WHERE kind = 'deposit' ${until ? sql`AND ts < ${until}` : sql``}` as unknown as Row[];
  const outs = await sql`
    SELECT from_addr AS account, block::text AS block, log_index, extract(epoch FROM ts)::bigint::text AS ts, amount::text AS shares
    FROM transfers WHERE token = ${poolAddr} AND from_addr <> ${ZERO} AND from_addr <> ${poolAddr}
    ${until ? sql`AND ts < ${until}` : sql``}` as unknown as Row[];
  return [
    ...deposits.map((row) => flow("deposit", row)),
    ...outs.map((row) => flow("out", row)),
  ];
}

interface Row { account: string; block: string; log_index: number; ts: string; assets?: string; shares: string }

function flow(kind: PoolFlow["kind"], row: Row): PoolFlow {
  return {
    kind,
    account: row.account.toLowerCase(),
    block: BigInt(row.block),
    logIndex: Number(row.log_index),
    ts: Number(row.ts),
    shares18: fixed(row.shares, 18),
    assetsMicro: kind === "deposit" ? fixed(row.assets ?? "0", 6) : 0n,
  };
}

/** The newest pool snapshot time (unix seconds): how far the indexer has read. A week is final once this passes its end. */
export async function indexedThroughSec(sql: Sql): Promise<number | null> {
  const rows = await sql`SELECT extract(epoch FROM max(ts))::bigint::text AS ts FROM pool_nav` as unknown as { ts: string | null }[];
  return rows[0]?.ts ? Number(rows[0].ts) : null;
}
