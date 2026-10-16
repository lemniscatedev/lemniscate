import type { ChainEvent, IndexerContext } from "../types";
import { asBigInt, asNumber } from "../units";

export async function handleHoursEvent(context: IndexerContext, event: ChainEvent): Promise<void> {
  if (event.source !== "hours") return;
  context.hasLemniscateEvents = true;
  if (event.eventName === "SessionsUpdated") {
    context.marketHours.count = asNumber(event.args.count);
    context.marketHours.firstOpen = asBigInt(event.args.firstOpen).toString();
    context.marketHours.lastClose = asBigInt(event.args.lastClose).toString();
    context.kinds.add("hours");
  }
}
