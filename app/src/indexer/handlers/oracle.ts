import type { ChainEvent, IndexerContext } from "../types";
import { asBigInt, units, wad } from "../units";

export async function handleOracleEvent(context: IndexerContext, event: ChainEvent): Promise<void> {
  if (event.source !== "external") return;
  const marketId = event.marketId;
  if (marketId === undefined || marketId < 0) return;
  context.marketIds.add(marketId);

  if (event.eventName === "AnswerUpdated") {
    await context.tx`
      INSERT INTO oracle_updates (market_id, ts, round_id, answer, block, tx_hash, log_index)
      VALUES (
        ${marketId}, ${event.ts.toISOString()}, ${asBigInt(event.args.roundId).toString()}, ${units(event.args.current, 8)},
        ${event.blockNumber.toString()}, ${event.txHash}, ${event.logIndex}
      )
      ON CONFLICT (tx_hash, log_index) DO NOTHING
    `;
    context.snapshotNeeded = true;
    context.kinds.add("oracle");
    return;
  }

  const market = context.marketById.get(marketId);
  const symbol = market?.symbol ?? `MARKET${marketId}`;
  const multiplierEvent = event.eventName === "UIMultiplierUpdated";
  const effectiveAt = multiplierEvent
    ? new Date(Number(asBigInt(event.args.effectiveAtTimestamp)) * 1_000)
    : null;
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
  const oldMultiplier = multiplierEvent ? wad(event.args.oldMultiplier) : null;
  const newMultiplier = multiplierEvent ? wad(event.args.newMultiplier) : null;
  const details: Record<string, unknown> = {
    stockAddress: event.address,
    eventName: event.eventName,
  };
  if (multiplierEvent) {
    details.effectiveAtTimestamp = asBigInt(event.args.effectiveAtTimestamp).toString();
  }

  await context.tx`
    INSERT INTO corp_actions (id, symbol, kind, status, effective_at, old_mult, new_mult, details, source, updated_at)
    VALUES (
      ${`${event.txHash}-${event.logIndex}`}, ${symbol}, ${kind}, ${status}, ${effectiveAt?.toISOString() ?? null},
      ${oldMultiplier}, ${newMultiplier}, ${JSON.stringify(details)}::jsonb, 'onchain', NOW()
    )
    ON CONFLICT (id) DO NOTHING
  `;
  context.snapshotNeeded = true;
  context.kinds.add("corp_action");
}
