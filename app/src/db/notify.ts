import type { Sql } from "postgres";

export const LEMNISCATE_EVENTS_CHANNEL = "lemniscate_events";

export type LemniscateEventSummary = Record<string, unknown>;
export type LemniscateEventHandler = (event: LemniscateEventSummary) => void | Promise<void>;

export async function notifyLemniscateEvents(
  sql: Sql,
  event: LemniscateEventSummary,
): Promise<void> {
  const payload = JSON.stringify(event, (_key, value: unknown) =>
    typeof value === "bigint" ? value.toString() : value,
  );
  await sql.notify(LEMNISCATE_EVENTS_CHANNEL, payload);
}

export async function listenLemniscateEvents(
  sql: Sql,
  handler: LemniscateEventHandler,
): Promise<() => Promise<void>> {
  const subscription = await sql.listen(LEMNISCATE_EVENTS_CHANNEL, (payload) => {
    let event: unknown;
    try {
      event = JSON.parse(payload) as unknown;
    } catch {
      return;
    }
    if (!event || typeof event !== "object" || Array.isArray(event)) return;
    void Promise.resolve(handler(event as LemniscateEventSummary)).catch(() => undefined);
  });
  return async () => {
    await subscription.unlisten();
  };
}
