import type { TransactionSql } from "postgres";
import { recomputeBalances } from "./handlers/token";

/** Tables whose rows each belong to exactly one block (column `block`) and are re-created by re-ingesting it. */
const BLOCK_TABLES = [
  "trades",
  "shields",
  "agent_trades",
  "agent_policy_events",
  "agent_policy_stocks",
  "router_tickets",
  "norm_history",
  "ticks",
  "vol_posts",
  "pool_nav",
  "limits_state",
  "hedge_equity_posts",
  "pool_hedge_events",
  "pause_log",
  "series_flag_log",
  "pool_events",
  "indexer_skipped_events",
] as const;

export interface RollbackSummary {
  readonly ancestor: bigint;
  readonly seriesRemoved: number;
  readonly balancesRecomputed: number;
}

/**
 * Removes everything the indexer derived from blocks after `ancestor` (the last block both the old and the new
 * chain agree on) and leaves the cursor at `ancestor`, so the next tick re-ingests the replacement blocks.
 *
 * Event rows are deleted. State that is a function of events is recomputed from what remains: series norm and
 * flags, balances, queued sells and withdrawals (reopened), first-seen accounts. Chain-state snapshots (pool_nav,
 * ticks, limits_state) taken above the ancestor are dropped; the next snapshot replaces them.
 */
export async function rollbackAfter(tx: TransactionSql, ancestor: bigint): Promise<RollbackSummary> {
  const after = ancestor.toString();

  // Which derived rows are affected must be read before the event rows disappear.
  const balancePairs = (await tx`
    SELECT DISTINCT token, account FROM (
      SELECT token, from_addr AS account FROM transfers WHERE block > ${after}
      UNION SELECT token, to_addr AS account FROM transfers WHERE block > ${after}
    ) touched
  `) as unknown as { token: string; account: string }[];
  const touchedSeries = (await tx`
    SELECT DISTINCT series_id FROM (
      SELECT series_id FROM norm_history WHERE block > ${after}
      UNION SELECT series_id FROM series_flag_log WHERE block > ${after}
    ) touched
  `) as unknown as { series_id: string }[];

  for (const table of BLOCK_TABLES) {
    await tx.unsafe(`DELETE FROM ${table} WHERE block > $1`, [after]);
  }
  await tx`DELETE FROM transfers WHERE block > ${after}`;

  // Sell queue and withdrawal tickets: undo closings above the ancestor, drop tickets opened above it.
  await tx`DELETE FROM queued_sells WHERE queued_block > ${after}`;
  await tx`
    UPDATE queued_sells SET status = 'open', closed_at = NULL, closed_block = NULL, closed_tx = NULL, closed_log = NULL,
      filler = NULL, usdg_out = NULL
    WHERE closed_block > ${after}
  `;
  await tx`DELETE FROM withdrawals WHERE queued_block > ${after}`;
  await tx`
    UPDATE withdrawals SET status = 'queued', claimed_at = NULL, claimed_block = NULL, claimed_tx = NULL, claimed_log = NULL, usdg = NULL
    WHERE claimed_block > ${after}
  `;

  // On-chain corporate action rows carry their block in details.
  await tx`DELETE FROM corp_actions WHERE source = 'onchain' AND (details->>'block')::bigint > ${after}`;

  // Series: forget those listed above the ancestor, recompute the rest from the logs that remain.
  const removed = await tx`DELETE FROM series WHERE listed_block > ${after} RETURNING id`;
  for (const { series_id: seriesId } of touchedSeries) {
    await tx`
      UPDATE series SET
        norm = COALESCE((SELECT norm FROM norm_history WHERE series_id = ${seriesId} ORDER BY ts DESC, log_index DESC LIMIT 1), 1),
        last_accrual = COALESCE((SELECT ts FROM norm_history WHERE series_id = ${seriesId} ORDER BY ts DESC, log_index DESC LIMIT 1), listed_at),
        buyable = COALESCE((SELECT value FROM series_flag_log WHERE series_id = ${seriesId} AND kind = 'buyable' ORDER BY block DESC, log_index DESC LIMIT 1), false),
        archived = COALESCE((SELECT value FROM series_flag_log WHERE series_id = ${seriesId} AND kind = 'archived' ORDER BY block DESC, log_index DESC LIMIT 1), false)
      WHERE id = ${seriesId}
    `;
  }

  await recomputeBalances(tx, balancePairs);

  await tx`DELETE FROM account_metadata WHERE first_seen_block > ${after}`;
  await tx`UPDATE account_metadata SET last_seen_block = ${after} WHERE last_seen_block > ${after}`;

  await tx`DELETE FROM block_hashes WHERE block > ${after}`;
  await tx`UPDATE cursors SET block = ${after}, updated_at = NOW() WHERE name = 'main'`;

  return { ancestor, seriesRemoved: removed.length, balancesRecomputed: balancePairs.length };
}
