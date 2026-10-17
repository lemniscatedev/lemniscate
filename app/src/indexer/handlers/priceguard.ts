import type { ChainEvent, IndexerContext } from "../types";
import { bytes32Text } from "../units";
import { addr, iso } from "./common";

export async function handlePriceGuardEvent(context: IndexerContext, event: ChainEvent): Promise<void> {
  if (event.eventName === "HaltLatched") {
    // Decision 31: the feed read HALTED in session; after the settle delay anyone may settle the stock (ORC-4).
    await context.tx`
      INSERT INTO engine_events (tx_hash, log_index, block, ts, kind, series_id, stock_token, account, price, until)
      VALUES (${event.txHash}, ${event.logIndex}, ${event.blockNumber.toString()}, ${iso(event.ts)}, 'halt_latched', NULL,
        ${addr(event, "stock")}, NULL, NULL, NULL)
      ON CONFLICT (tx_hash, log_index) DO NOTHING
    `;
    context.snapshotNeeded = true;
    context.kinds.add("oracle");
    return;
  }
  if (event.eventName !== "BuysPausedSet") return;
  await context.tx`
    INSERT INTO pause_log (tx_hash, log_index, block, ts, scope, key, paused, reason)
    VALUES (
      ${event.txHash}, ${event.logIndex}, ${event.blockNumber.toString()}, ${iso(event.ts)}, 'stock',
      ${addr(event, "stock")}, ${Boolean(event.args.paused)}, ${bytes32Text(event.args.reason)}
    )
    ON CONFLICT (tx_hash, log_index) DO NOTHING
  `;
  context.snapshotNeeded = true;
  context.kinds.add("pause");
}
