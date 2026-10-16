import { expect, test } from "bun:test";
import { TtlCache } from "../../api/cache";
import type { ApiDependencies } from "../../api/types";
import { upcomingMarketConfig } from "../../config/upcoming";
import { buildUpcoming, subscribeUpcoming, upcomingMarkets, unsubscribeUpcoming } from "./upcoming";

const address = "0x1111111111111111111111111111111111111111";
const asOf = "2026-10-08T12:00:00.000Z";

test("buildUpcoming orders soon before live and includes interest and wallet state", () => {
  const items = upcomingMarketConfig.slice(0, 3);
  const result = buildUpcoming(items, [
    { symbol: "SPCX", launched: false },
    { symbol: "GLD", launched: true },
  ], new Map([["spcx", 5], ["gld", 7]]), new Set(["gld"]), asOf);

  expect(result.asOf).toBe(asOf);
  expect(result.items.map((item) => item.id)).toEqual(["spcx", "gme", "gld"]);
  expect(result.items).toMatchObject([
    { id: "spcx", status: "soon", interest: 5, subscribed: false },
    { id: "gme", status: "soon", interest: 0, subscribed: false },
    { id: "gld", status: "live", interest: 7, subscribed: true },
  ]);
});

test("buildUpcoming uses null subscription state when no address is supplied", () => {
  const result = buildUpcoming(upcomingMarketConfig, [], new Map(), null, asOf);
  expect(result.items).toHaveLength(10);
  expect(result.items.every((item) => item.status === "soon" && item.interest === 0 && item.subscribed === null)).toBe(true);
});

test("upcomingMarkets returns fresh per-address state and launched status", async () => {
  const calls: { query: string; values: unknown[] }[] = [];
  const cache = new TtlCache();
  void cache.getOrLoad("markets:list", 3_000, async () => [
    { symbol: "SPCX", launched: true }, { symbol: "GLD", launched: false },
  ]);
  const sql = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.join("?");
    calls.push({ query, values });
    if (query.includes("group by upcoming_id")) return [{ upcoming_id: "spcx", n: 3 }];
    if (query.includes("where address =")) return [{ upcoming_id: "spcx" }];
    return [];
  };
  const result = await upcomingMarkets({
    config: { NETWORK: "mainnet" }, cache, sql,
  } as unknown as ApiDependencies, address);

  expect(result.items.find((item) => item.id === "spcx")).toMatchObject({ status: "live", interest: 3, subscribed: true });
  expect(result.items.find((item) => item.id === "gld")).toMatchObject({ status: "soon", interest: 0, subscribed: false });
  expect(calls.some((call) => call.query.includes("where address =") && call.values[0] === address)).toBe(true);
});

test("subscribe and unsubscribe return fresh database state", async () => {
  let isSubscribed = false;
  const sql = async (strings: TemplateStringsArray, ..._values: unknown[]) => {
    const query = strings.join("?");
    if (query.includes("insert into upcoming_subscriptions")) isSubscribed = true;
    if (query.includes("delete from upcoming_subscriptions")) isSubscribed = false;
    if (query.includes("count(*)")) return [{ n: isSubscribed ? 1 : 0 }];
    if (query.includes("select 1 from upcoming_subscriptions")) return isSubscribed ? [{ one: 1 }] : [];
    return [];
  };
  const deps = { sql } as unknown as ApiDependencies;

  expect(await subscribeUpcoming(deps, "spcx", address)).toEqual({ interest: 1, subscribed: true });
  expect(await unsubscribeUpcoming(deps, "spcx", address)).toEqual({ interest: 0, subscribed: false });
});
