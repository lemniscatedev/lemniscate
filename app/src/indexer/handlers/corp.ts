import type { ChainEvent, IndexerContext } from "../types";
import { asBigInt, unixToDate, wad } from "../units";
import { iso } from "./common";

/** Stock Token multiplier and pause events feed the corporate actions table that the keeper and API read. */
export async function handleStockEvent(context: IndexerContext, event: ChainEvent): Promise<void> {
  if (event.source !== "stock") return;
  const symbol = context.stockNames.get(event.address) ?? event.address;
  const multiplierEvent = event.eventName === "UIMultiplierUpdated";
  const effectiveAt = multiplierEvent ? unixToDate(event.args.effectiveAtTimestamp) : null;
  const kind = multiplierEvent
    ? "ui_multiplier"
    : event.eventName === "OraclePaused" || event.eventName === "OracleUnpaused"
      ? "oracle_pause"
      : "token_pause";
  const status = multiplierEvent
    ? effectiveAt && effectiveAt.getTime() > event.ts.getTime()
      ? "scheduled"
      : "applied"
    : event.eventName === "OraclePaused" || event.eventName === "Paused"
      ? "paused"
      : "unpaused";
  const details: Record<string, unknown> = {
    stockAddress: event.address,
    eventName: event.eventName,
    // Lets a reorg rollback find on-chain rows by block.
    block: event.blockNumber.toString(),
  };
  if (multiplierEvent) details.effectiveAtTimestamp = asBigInt(event.args.effectiveAtTimestamp).toString();
  await context.tx`
    INSERT INTO corp_actions (id, symbol, kind, status, effective_at, old_mult, new_mult, details, source, updated_at)
    VALUES (
      ${`${event.txHash}-${event.logIndex}`}, ${symbol}, ${kind}, ${status}, ${effectiveAt ? iso(effectiveAt) : null},
      ${multiplierEvent ? wad(event.args.oldMultiplier) : null}, ${multiplierEvent ? wad(event.args.newMultiplier) : null},
      ${JSON.stringify(details)}::jsonb, 'onchain', NOW()
    )
    ON CONFLICT (id) DO NOTHING
  `;
  context.snapshotNeeded = true;
  context.kinds.add("corp_action");
}
