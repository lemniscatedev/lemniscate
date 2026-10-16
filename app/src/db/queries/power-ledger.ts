import { fixed, multiply } from "../../lib/fixed";
import { addAtCost, emptyCostState, removeAtAverageCost, type CostState } from "./cost-ledger";
import type { ApiDependencies, DbRow } from "../../api/types";
import { asRows, dateValue, numberValue } from "../../api/types";

export interface PowerLedgerEvent extends DbRow {
  event_kind: "trade" | "transfer";
  market_id: number | string;
  side: string | null;
  from_addr: string;
  to_addr: string;
  quantity: string;
  usdg: string;
  price: string;
  block: string | number | bigint;
  log_index: number | string;
  ts: Date | string;
  tx_hash: string;
}

/** One sell by the address, with the cost it removed at average cost. */
export interface RealizedFill {
  marketId: number;
  txHash: string;
  logIndex: number;
  ts: string;
  quantity: bigint;
  proceeds: bigint;
  costRemoved: bigint;
  realized: bigint;
}

/** Cap on the trade/transfer ledger replayed for cost basis, newest first. */
export const PORTFOLIO_EVENT_LIMIT = 5_000;

/** Newest PORTFOLIO_EVENT_LIMIT power-token ledger rows for an address, oldest first. */
export async function powerLedgerEvents(
  deps: ApiDependencies,
  address: string,
): Promise<{ events: PowerLedgerEvent[]; historyComplete: boolean }> {
  // Each branch is bounded first so the per-column account indexes are used.
  const result = await deps.sql`
    select * from (
      select * from (
        select 'trade'::text as event_kind, market_id, side, account as from_addr, recipient as to_addr,
          tokens::text as quantity, usdg::text, price::text, block, log_index, ts, tx_hash
        from trades where account = ${address}
        union
        select 'trade'::text, market_id, side, account, recipient, tokens::text, usdg::text, price::text, block, log_index, ts, tx_hash
        from trades where recipient = ${address}
        order by block desc, log_index desc limit ${PORTFOLIO_EVENT_LIMIT + 1}
      ) trade_rows
      union all
      select * from (
        select 'transfer'::text as event_kind, market_id, null::text as side, from_addr, to_addr,
          amount::text as quantity, '0'::text as usdg,
          coalesce((select price from ticks where ticks.market_id = transfers.market_id and ticks.block <= transfers.block order by ticks.block desc, ticks.ts desc limit 1), 0)::text as price,
          block, log_index, ts, tx_hash
        from transfers where market_id is not null and (from_addr = ${address} or to_addr = ${address})
        order by block desc, log_index desc limit ${PORTFOLIO_EVENT_LIMIT + 1}
      ) transfer_rows
      order by block desc, log_index desc limit ${PORTFOLIO_EVENT_LIMIT + 1}
    ) ledger order by block, log_index
  `;
  const events = asRows<PowerLedgerEvent>(result);
  const historyComplete = events.length <= PORTFOLIO_EVENT_LIMIT;
  // Drop the oldest row of the over-fetch: it only signals truncation.
  return { events: historyComplete ? events : events.slice(events.length - PORTFOLIO_EVENT_LIMIT), historyComplete };
}

/** Replays the ledger at average cost per market and records every sell by the address. */
export function replayPowerLedger(events: PowerLedgerEvent[], address: string): { costs: Map<number, CostState>; fills: RealizedFill[] } {
  const costs = new Map<number, CostState>();
  const fills: RealizedFill[] = [];
  for (const event of events) {
    const marketId = numberValue(event.market_id);
    const state = costs.get(marketId) ?? emptyCostState();
    const quantity = fixed(event.quantity);
    if (event.event_kind === "trade" && event.side === "buy" && event.to_addr.toLowerCase() === address) {
      addAtCost(state, quantity, event.from_addr.toLowerCase() === address ? fixed(event.usdg) : multiply(quantity, fixed(event.price)));
    } else if (event.event_kind === "trade" && event.side === "sell" && event.from_addr.toLowerCase() === address) {
      const costRemoved = removeAtAverageCost(state, quantity);
      const proceeds = fixed(event.usdg);
      state.realized += proceeds - costRemoved;
      fills.push({
        marketId,
        txHash: event.tx_hash,
        logIndex: numberValue(event.log_index),
        ts: dateValue(event.ts)?.toISOString() ?? "",
        quantity,
        proceeds,
        costRemoved,
        realized: proceeds - costRemoved,
      });
    } else if (event.event_kind === "transfer" && event.from_addr.toLowerCase() !== address && event.to_addr.toLowerCase() === address) {
      addAtCost(state, quantity, multiply(quantity, fixed(event.price)));
    } else if (event.event_kind === "transfer" && event.from_addr.toLowerCase() === address && event.to_addr.toLowerCase() !== address) {
      removeAtAverageCost(state, quantity);
    }
    costs.set(marketId, state);
  }
  return { costs, fills };
}
