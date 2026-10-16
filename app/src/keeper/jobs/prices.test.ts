import { describe, expect, test } from "bun:test";
import { A, FakeChain, WAD } from "../test-support";
import { keepLastGoodPrices } from "./prices";

const live = { s: 214n * WAD, session: 0, fresh: true, buysPaused: false, updatedAt: 1_792_000_000n };

describe("PriceGuard last good price upkeep (todo 23 fork bug: weekend sells found no price)", () => {
  test("a live, fresh price newer than the stored last good price is poked; nothing when it is current", async () => {
    const chain = new FakeChain();
    chain.prices.set(A.nvda, live);
    const ctx = chain.context();
    expect((await keepLastGoodPrices(ctx)).poked).toEqual([A.nvda]);
    expect(chain.lastGood.get(A.nvda)).toEqual({ s: live.s, at: live.updatedAt });
    expect((await keepLastGoodPrices(ctx)).poked).toEqual([]);
    chain.prices.set(A.nvda, { ...live, s: 215n * WAD, updatedAt: live.updatedAt + 3600n });
    expect((await keepLastGoodPrices(ctx)).poked).toEqual([A.nvda]);
    expect(chain.sent.filter((tx) => tx.name === "poke").length).toBe(2);
  });

  test("never pokes outside a live session or on a stale price (poke would only keep the old value)", async () => {
    for (const price of [{ ...live, session: 2 }, { ...live, session: 4 }, { ...live, fresh: false }]) {
      const chain = new FakeChain();
      chain.prices.set(A.nvda, price);
      expect((await keepLastGoodPrices(chain.context())).poked).toEqual([]);
      expect(chain.sent).toEqual([]);
    }
  });
});

describe("the accrual job runs the upkeep", () => {
  test("even when no series is due it pokes a stale last good price", async () => {
    const { createAccrueJob } = await import("./accrue");
    const chain = new FakeChain();
    chain.prices.set(A.nvda, live);
    const result = await createAccrueJob(chain.context())();
    expect(result.idle).toBe(true);
    expect(result.pokes).toBe(1);
    expect(chain.lastGood.get(A.nvda)?.s).toBe(live.s);
  });
});
