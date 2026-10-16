import { expect, test } from "bun:test";
import { createHedgeJob, hedgeDataStaleness } from "./jobs/hedge";
import { createLogger } from "../log";
import type { KeeperContext } from "./context";

test("the keeper hedge job only observes: it publishes net delta per name and sends no transaction", async () => {
  const now = Date.now();
  const rows = (query: TemplateStringsArray) => {
    const text = query.join("?");
    if (text.includes("from series")) {
      return [{ id: "0xs1", stock_token: "0xaa", is_call: true, speed: "DAILY", tau_s: 86400, strike: "100", norm: "1", supply: "10" }];
    }
    return [{ stock_token: "0xaa", name: "NVDA", spot: "100", session: "REGULAR", fresh: true, ts: new Date(now), sigma_daily_bps: 5000, sigma_weekly_bps: 5000 }];
  };
  let submitted = 0;
  const context = {
    metadata: async () => ({ indexerLastOk: new Date(now).toISOString(), lastSnapshotAt: new Date(now).toISOString(), lagBlocks: "3" }),
    sql: async (query: TemplateStringsArray) => rows(query),
    tx: { submit: async () => { submitted++; return { simulated: false }; } },
    logger: createLogger("silent"),
  } as unknown as KeeperContext;
  const result = await createHedgeJob(context)();
  expect(result.observeOnly).toBe(true);
  const nvda = (result.names as Record<string, { netDelta: number; complete: boolean }>).NVDA!;
  expect(nvda.complete).toBe(true);
  expect(nvda.netDelta).toBeGreaterThan(4.9);
  expect(nvda.netDelta).toBeLessThan(5.1);
  expect(submitted).toBe(0);
});

test("hedging is skipped while the indexed hedge target is stale", async () => {
  const now = Date.parse("2026-10-05T12:00:00Z");
  const fresh = { indexerLastOk: new Date(now - 10_000).toISOString(), lastSnapshotAt: new Date(now - 60_000).toISOString(), lagBlocks: "2" };
  expect(hedgeDataStaleness(fresh, now)).toBeUndefined();
  expect(hedgeDataStaleness({ ...fresh, lastSnapshotAt: new Date(now - 16 * 60_000).toISOString() }, now)).toContain("snapshot");
  expect(hedgeDataStaleness({ ...fresh, indexerLastOk: "" }, now)).toContain("poll");
  expect(hedgeDataStaleness({ ...fresh, lagBlocks: 500 }, now)).toContain("lagging");

  const context = {
    metadata: async () => ({ indexerLastOk: new Date().toISOString(), lastSnapshotAt: new Date(Date.now() - 3_600_000).toISOString(), lagBlocks: "1" }),
    logger: createLogger("silent"),
  } as unknown as KeeperContext;
  const result = await createHedgeJob(context)();
  expect(result.attempted).toEqual([]);
  expect(result.skipped).toContain("snapshot");
});
