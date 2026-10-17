import type { ChainEvent, IndexerContext } from "../types";
import { asBigInt, asNumber, bytes32Text, optionTokens, sessionName, usdg, wad } from "../units";
import { accountSeen, addr, id32, iso } from "./common";

async function handleTrade(context: IndexerContext, event: ChainEvent, side: "buy" | "sell"): Promise<void> {
  const account = addr(event, "account");
  const recipient = addr(event, "recipient");
  const paid = side === "buy" ? event.args.usdgPaid : event.args.usdgReceived;
  await context.tx`
    INSERT INTO trades (tx_hash, log_index, block, ts, series_id, account, recipient, side, units, shares, usdg, v_mark, sigma_bps, session)
    VALUES (
      ${event.txHash}, ${event.logIndex}, ${event.blockNumber.toString()}, ${iso(event.ts)}, ${id32(event, "id")},
      ${account}, ${recipient}, ${side}, ${wad(event.args.units)}, ${optionTokens(event.args.tokens)}, ${usdg(paid)},
      ${wad(event.args.vMarkWad)}, ${asNumber(event.args.sigmaBps)}, ${sessionName(event.args.session)}
    )
    ON CONFLICT (tx_hash, log_index) DO NOTHING
  `;
  await accountSeen(context.tx, event, [account, recipient]);
  context.snapshotNeeded = true;
  context.kinds.add("trade");
}

async function handleAccrued(context: IndexerContext, event: ChainEvent): Promise<void> {
  const seriesId = id32(event, "id");
  await context.tx`
    INSERT INTO norm_history (series_id, ts, tx_hash, log_index, block, norm, v_mark, payoff, session)
    VALUES (
      ${seriesId}, ${iso(event.ts)}, ${event.txHash}, ${event.logIndex}, ${event.blockNumber.toString()},
      ${wad(event.args.norm)}, ${wad(event.args.vMarkWad)}, ${wad(event.args.payoffWad)}, ${sessionName(event.args.session)}
    )
    ON CONFLICT (series_id, ts, tx_hash, log_index) DO NOTHING
  `;
  await recomputeSeriesNorm(context, seriesId);
  context.snapshotNeeded = true;
  context.kinds.add("accrual");
}

/** norm and last_accrual always equal the latest norm_history row (or the listing defaults), so replays and rollbacks converge. */
export async function recomputeSeriesNorm(context: Pick<IndexerContext, "tx">, seriesId: string): Promise<void> {
  await context.tx`
    UPDATE series SET
      norm = COALESCE(latest.norm, 1),
      last_accrual = COALESCE(latest.ts, series.listed_at)
    FROM (SELECT ${seriesId}::text AS id) target
    LEFT JOIN LATERAL (
      SELECT norm, ts FROM norm_history WHERE series_id = target.id ORDER BY ts DESC, log_index DESC LIMIT 1
    ) latest ON true
    WHERE series.id = target.id
  `;
}

async function handleShield(context: IndexerContext, event: ChainEvent): Promise<void> {
  const account = addr(event, "account");
  await context.tx`
    INSERT INTO shields (tx_hash, log_index, block, ts, account, stock_token, series_id, token_units, usdg_paid)
    VALUES (
      ${event.txHash}, ${event.logIndex}, ${event.blockNumber.toString()}, ${iso(event.ts)}, ${account},
      ${addr(event, "stock")}, ${id32(event, "id")}, ${optionTokens(event.args.tokenUnits)}, ${usdg(event.args.usdgPaid)}
    )
    ON CONFLICT (tx_hash, log_index) DO NOTHING
  `;
  await accountSeen(context.tx, event, [account]);
  context.snapshotNeeded = true;
  context.kinds.add("shield");
}

async function logPause(
  context: IndexerContext,
  event: ChainEvent,
  scope: "global" | "series",
  key: string,
  paused: boolean,
  reason: string | null,
): Promise<void> {
  await context.tx`
    INSERT INTO pause_log (tx_hash, log_index, block, ts, scope, key, paused, reason)
    VALUES (${event.txHash}, ${event.logIndex}, ${event.blockNumber.toString()}, ${iso(event.ts)}, ${scope}, ${key}, ${paused}, ${reason})
    ON CONFLICT (tx_hash, log_index) DO NOTHING
  `;
}

async function handleQueued(context: IndexerContext, event: ChainEvent): Promise<void> {
  const seller = addr(event, "seller");
  const recipient = addr(event, "recipient");
  await context.tx`
    INSERT INTO queued_sells (ticket, series_id, seller, recipient, tokens, queued_at, queued_block, queued_tx, queued_log)
    VALUES (
      ${asBigInt(event.args.ticket).toString()}, ${id32(event, "id")}, ${seller}, ${recipient}, ${optionTokens(event.args.tokens)},
      ${iso(event.ts)}, ${event.blockNumber.toString()}, ${event.txHash}, ${event.logIndex}
    )
    ON CONFLICT (ticket) DO NOTHING
  `;
  await accountSeen(context.tx, event, [seller, recipient]);
  context.kinds.add("queue");
}

async function closeQueued(context: IndexerContext, event: ChainEvent, status: "filled" | "cancelled"): Promise<void> {
  const filler = status === "filled" ? addr(event, "filler") : null;
  const usdgOut = status === "filled" ? usdg(event.args.usdgOut) : null;
  await context.tx`
    UPDATE queued_sells SET
      status = ${status}, closed_at = ${iso(event.ts)}, closed_block = ${event.blockNumber.toString()},
      closed_tx = ${event.txHash}, closed_log = ${event.logIndex}, filler = ${filler}, usdg_out = ${usdgOut}
    WHERE ticket = ${asBigInt(event.args.ticket).toString()} AND status = 'open'
  `;
  context.snapshotNeeded = true;
  context.kinds.add("queue");
}

/** Engine safety events (decisions 31, 32): a dust series retired from the live list, an ORC-4 settlement. */
async function handleSafetyEvent(context: IndexerContext, event: ChainEvent): Promise<void> {
  const retired = event.eventName === "SeriesRetired";
  await context.tx`
    INSERT INTO engine_events (tx_hash, log_index, block, ts, kind, series_id, stock_token, account, price, until)
    VALUES (
      ${event.txHash}, ${event.logIndex}, ${event.blockNumber.toString()}, ${iso(event.ts)},
      ${retired ? "series_retired" : "stock_settled"}, ${retired ? id32(event, "id") : null}, ${retired ? null : addr(event, "stock")},
      NULL, ${retired ? null : wad(event.args.s)}, NULL
    )
    ON CONFLICT (tx_hash, log_index) DO NOTHING
  `;
  context.snapshotNeeded = true;
  context.kinds.add(retired ? "series" : "oracle");
}

export async function handleEngineEvent(context: IndexerContext, event: ChainEvent): Promise<void> {
  switch (event.eventName) {
    case "SeriesRetired":
    case "StockSettled":
      return handleSafetyEvent(context, event);
    case "Bought":
      return handleTrade(context, event, "buy");
    case "Sold":
      return handleTrade(context, event, "sell");
    case "Accrued":
      return handleAccrued(context, event);
    case "ShieldBought":
      return handleShield(context, event);
    case "BuysPaused": {
      const global = Boolean(event.args.global);
      await logPause(context, event, global ? "global" : "series", global ? "global" : id32(event, "id"), Boolean(event.args.paused), null);
      context.kinds.add("pause");
      return;
    }
    case "AutoPaused":
      await logPause(context, event, "global", "auto", true, bytes32Text(event.args.reason));
      context.kinds.add("pause");
      return;
    case "SellQueued":
      return handleQueued(context, event);
    case "QueuedSellFilled":
      return closeQueued(context, event, "filled");
    case "QueuedSellCancelled":
      return closeQueued(context, event, "cancelled");
    default:
      return;
  }
}
