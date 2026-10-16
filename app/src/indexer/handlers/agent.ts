import type { ChainEvent, IndexerContext } from "../types";
import { asBigInt, unixToDate, usdg } from "../units";
import { accountSeen, addr, id32, iso } from "./common";

export async function handleAgentEvent(context: IndexerContext, event: ChainEvent): Promise<void> {
  if (event.eventName === "PolicySet" || event.eventName === "PolicyRevoked") return handlePolicy(context, event);
  if (event.eventName !== "AgentTrade") return;
  const owner = addr(event, "owner");
  const agent = addr(event, "agent");
  await context.tx`
    INSERT INTO agent_trades (tx_hash, log_index, block, ts, owner, agent, series_id, is_buy, usdg)
    VALUES (
      ${event.txHash}, ${event.logIndex}, ${event.blockNumber.toString()}, ${iso(event.ts)}, ${owner}, ${agent},
      ${id32(event, "seriesId")}, ${Boolean(event.args.isBuy)}, ${usdg(event.args.usdg)}
    )
    ON CONFLICT (tx_hash, log_index) DO NOTHING
  `;
  await accountSeen(context.tx, event, [owner, agent]);
  context.kinds.add("agent");
}

/** PolicySet and PolicyRevoked: one row per event; the API reads an (owner, agent) pair's newest row. */
async function handlePolicy(context: IndexerContext, event: ChainEvent): Promise<void> {
  const owner = addr(event, "owner");
  const agent = addr(event, "agent");
  const set = event.eventName === "PolicySet";
  await context.tx`
    INSERT INTO agent_policy_events (
      tx_hash, log_index, block, ts, kind, owner, agent, budget_usdg, max_per_trade_usdg, expires_at, can_sell, can_shield
    ) VALUES (
      ${event.txHash}, ${event.logIndex}, ${event.blockNumber.toString()}, ${iso(event.ts)}, ${set ? "set" : "revoked"}, ${owner}, ${agent},
      ${set ? usdg(event.args.budgetUsdg) : null}, ${set ? usdg(event.args.maxPerTradeUsdg) : null},
      ${set ? iso(unixToDate(asBigInt(event.args.expiresAt))) : null},
      ${set ? Boolean(event.args.canSell) : null}, ${set ? Boolean(event.args.canShield) : null}
    )
    ON CONFLICT (tx_hash, log_index) DO NOTHING
  `;
  await accountSeen(context.tx, event, [owner, agent]);
  context.kinds.add("agent");
}
