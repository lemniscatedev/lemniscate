import { expect, test } from "bun:test";
import type { ApiDependencies } from "../../api/types";
import { vaultSnapshot } from "./vault";

const DAY = 86_400_000;
function depsFor(ticks: Array<{ ts: Date; nav_per_share: string }>) {
  const ordered = [...ticks].sort((a, b) => b.ts.getTime() - a.ts.getTime());
  return {
    config: { NETWORK: "mainnet" },
    sql: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const query = strings.join("?");
      if (query.includes("from markets")) return [];
      if (query.includes("interval")) {
        const days = query.includes("'30 days'") ? 30 : 7;
        return ordered.filter((t) => t.ts.getTime() <= Date.parse(String(values[0])) - days * DAY).slice(0, 1);
      }
      return query.includes("ts asc") ? ordered.slice(-1) : ordered.slice(0, 1);
    },
  } as unknown as ApiDependencies;
}

test("vault changes keep seven-day fallback and return null for short or absent history", async () => {
  const now = Date.now();
  const result = await vaultSnapshot(depsFor([{ ts: new Date(now), nav_per_share: "1.02" }, { ts: new Date(now - 10 * DAY), nav_per_share: "1" }]));
  expect(result.change7dPct).toBe(2);
  expect(result.change30dPct).toBeNull();
  expect(result.changeSinceInceptionPct).toBe(2);
  const empty = await vaultSnapshot(depsFor([]));
  expect(empty.change7dPct).toBe(0);
  expect(empty.change30dPct).toBeNull();
  expect(empty.changeSinceInceptionPct).toBeNull();
});

test("vault thirty-day reference is the latest old-enough tick, distinct from inception", async () => {
  const now = Date.now();
  const result = await vaultSnapshot(depsFor([
    { ts: new Date(now), nav_per_share: "1.1" },
    { ts: new Date(now - 29 * DAY), nav_per_share: "2" },
    { ts: new Date(now - 31 * DAY), nav_per_share: "1" },
    { ts: new Date(now - 60 * DAY), nav_per_share: "0.5" },
  ]));
  expect(result.change30dPct).toBe(10);
  expect(result.changeSinceInceptionPct).toBe(120);
});

test("vault hedge book omits unlaunched markets without changing its registry query", async () => {
  const deps = {
    config: { NETWORK: "mainnet" },
    sql: async (strings: TemplateStringsArray) => {
      const query = strings.join("?");
      if (query.includes("from markets m")) return [
        { symbol: "SPY", launched: false, liability: "5", hedge_units: "0", hedge_target: "0", spot: "10" },
        { symbol: "SPYROOT", launched: null, liability: "0", hedge_units: "0", hedge_target: "0", spot: "10" },
        { symbol: "SPCX", launched: true, liability: "2", hedge_units: "0", hedge_target: "0", spot: "10" },
      ];
      return [];
    },
  } as unknown as ApiDependencies;
  const result = await vaultSnapshot(deps);
  expect(result.markets.map((market) => market.symbol)).toEqual(["SPCX"]);
});
