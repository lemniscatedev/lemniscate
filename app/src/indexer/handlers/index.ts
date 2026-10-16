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

/** Applies a batch in chain order, then settles the derived balances. */
export async function handleEvents(context: IndexerContext, events: readonly ChainEvent[]): Promise<void> {
  for (const event of events) await handleEvent(context, event);
  await applyBalances(context);
}
