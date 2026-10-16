import type { ChainEvent, IndexerContext } from "../types";
import { bytes32Text } from "../units";
import { addr, iso } from "./common";

export async function handlePriceGuardEvent(context: IndexerContext, event: ChainEvent): Promise<void> {
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
