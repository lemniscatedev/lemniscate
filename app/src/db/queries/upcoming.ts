import { apiNow } from "../../api/clock";
import type { ApiDependencies, DbRow } from "../../api/types";
import { asRows, numberValue, textValue } from "../../api/types";
import { upcomingMarketConfig, type UpcomingMarketConfig } from "../../config/upcoming";
import { listMarkets, type MarketView } from "./markets";

export interface UpcomingItem extends UpcomingMarketConfig {
  status: "soon" | "live";
  interest: number;
  subscribed: boolean | null;
}

export interface UpcomingResponse {
  items: UpcomingItem[];
  asOf: string;
}

export function buildUpcoming(
  items: readonly UpcomingMarketConfig[],
  markets: readonly Pick<MarketView, "symbol" | "launched">[],
  counts: ReadonlyMap<string, number>,
  subscribed: ReadonlySet<string> | null,
  asOf: string,
): UpcomingResponse {
  const result = items.map((item): UpcomingItem => {
    const live = markets.some((market) => market.symbol.toUpperCase() === item.symbol && market.launched);
    return {
      ...item,
      status: live ? "live" : "soon",
      interest: Math.max(0, counts.get(item.id) ?? 0),
      subscribed: subscribed === null ? null : subscribed.has(item.id),
    };
  });
  return { items: [...result.filter((item) => item.status === "soon"), ...result.filter((item) => item.status === "live")], asOf };
}

export async function upcomingMarkets(deps: ApiDependencies, address?: string): Promise<UpcomingResponse> {
  const [markets, countResult, subscribedResult, now] = await Promise.all([
    deps.cache.getOrLoad("markets:list", 3_000, () => listMarkets(deps)),
    deps.sql`select upcoming_id, count(*)::int as n from upcoming_subscriptions group by upcoming_id`,
    address
      ? deps.sql`select upcoming_id from upcoming_subscriptions where address = ${address}`
      : Promise.resolve([]),
    apiNow(deps),
  ]);
  const counts = new Map(asRows<DbRow>(countResult).map((row) => [textValue(row.upcoming_id), numberValue(row.n)]));
  const subscribed = address
    ? new Set(asRows<DbRow>(subscribedResult).map((row) => textValue(row.upcoming_id)))
    : null;
  return buildUpcoming(upcomingMarketConfig, markets, counts, subscribed, now.toISOString());
}

async function subscriptionState(deps: ApiDependencies, id: string, address: string): Promise<{ interest: number; subscribed: boolean }> {
  const [countResult, subscribedResult] = await Promise.all([
    deps.sql`select count(*)::int as n from upcoming_subscriptions where upcoming_id = ${id}`,
    deps.sql`select 1 from upcoming_subscriptions where upcoming_id = ${id} and address = ${address} limit 1`,
  ]);
  const count = asRows<DbRow>(countResult)[0]?.n;
  return { interest: Math.max(0, numberValue(count)), subscribed: asRows<DbRow>(subscribedResult).length > 0 };
}

export async function subscribeUpcoming(deps: ApiDependencies, id: string, address: string) {
  await deps.sql`
    insert into upcoming_subscriptions (upcoming_id, address)
    values (${id}, ${address.toLowerCase()})
    on conflict do nothing
  `;
  return subscriptionState(deps, id, address.toLowerCase());
}

export async function unsubscribeUpcoming(deps: ApiDependencies, id: string, address: string) {
  await deps.sql`delete from upcoming_subscriptions where upcoming_id = ${id} and address = ${address.toLowerCase()}`;
  return subscriptionState(deps, id, address.toLowerCase());
}
