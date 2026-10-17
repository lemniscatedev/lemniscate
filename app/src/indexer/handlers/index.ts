import type { ChainEvent, IndexerContext } from "../types";
import { handleAgentEvent } from "./agent";
import { handleStockEvent } from "./corp";
import { handleEngineEvent } from "./engine";
import { handlePoolEvent } from "./pool";
import { handlePriceGuardEvent } from "./priceguard";
import { handleRegistryEvent } from "./registry";
import { applyBalances, handleTransferEvent } from "./token";
import { handleVolEvent } from "./vol";

/** Applies one decoded event. Registry events must come before the token events of the series they list. */
export async function handleEvent(context: IndexerContext, event: ChainEvent): Promise<void> {
  switch (event.source) {
    case "engine":
      return handleEngineEvent(context, event);
    case "registry":
      return handleRegistryEvent(context, event);
    case "pool":
      if (event.eventName === "Transfer") return handleTransferEvent(context, event);
      return handlePoolEvent(context, event);
    case "token":
      return handleTransferEvent(context, event);
    case "volOracle":
      return handleVolEvent(context, event);
    case "agentRouter":
      return handleAgentEvent(context, event);
    case "priceGuard":
      return handlePriceGuardEvent(context, event);
    case "stock":
      return handleStockEvent(context, event);
  }
}

/** Reasons are stored, so keep them short and free of user-controlled bulk. */
function skipReason(error: unknown): string {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return message.replace(/\s+/g, " ").slice(0, 300);
}

/**
 * Applies a batch in chain order, then settles the derived balances.
 *
 * Every event runs inside its own SAVEPOINT (F04). An event that throws (data a stranger controls, an ABI surprise) is
 * rolled back alone, recorded in indexer_skipped_events with the reason and logged as an error, and ingestion goes on:
 * one malformed event can never freeze the cursor.
 */
export async function handleEvents(context: IndexerContext, events: readonly ChainEvent[]): Promise<void> {
  for (const event of events) {
    await context.tx.unsafe("SAVEPOINT lmns_event");
    try {
      await handleEvent(context, event);
      await context.tx.unsafe("RELEASE SAVEPOINT lmns_event");
    } catch (error) {
      await context.tx.unsafe("ROLLBACK TO SAVEPOINT lmns_event");
      await context.tx.unsafe("RELEASE SAVEPOINT lmns_event");
      const reason = skipReason(error);
      context.logger.error(
        { source: event.source, event: event.eventName, tx: event.txHash, logIndex: event.logIndex, block: event.blockNumber.toString(), reason },
        "Indexer skipped an event it could not apply; ingestion continues",
      );
      await context.tx`
        INSERT INTO indexer_skipped_events (tx_hash, log_index, block, source, event_name, reason, skipped_at)
        VALUES (${event.txHash}, ${event.logIndex}, ${event.blockNumber.toString()}, ${event.source}, ${event.eventName}, ${reason}, NOW())
        ON CONFLICT (tx_hash, log_index) DO UPDATE SET reason = EXCLUDED.reason, skipped_at = NOW()
      `;
      context.kinds.add("skipped");
    }
  }
  await applyBalances(context);
}
