import { describe, expect, test } from "bun:test";
import { A, FakeChain, WAD } from "../test-support";
import { createListerJob } from "./lister";
import { gridStrikes, moneynessBps, roundedStrike } from "../../config/listing";

const live = { s: 217n * WAD + WAD * 99n / 100n, session: 0, fresh: true, buysPaused: false, updatedAt: 1n }; // 217.99
function chainWith(price = live): FakeChain {
  const chain = new FakeChain();
  chain.prices.set(A.nvda, price);
  chain.prices.set(A.spy, { ...price, s: 770n * WAD + 3n * WAD / 4n });
  return chain;
}

describe("strike grid", () => {
  test("rounds to the per-stock step and dedupes", () => {
    expect(gridStrikes(217n * WAD + WAD * 99n / 100n, 5)).toEqual([195n, 205n, 220n, 230n, 240n].map((n) => n * WAD));
    expect(roundedStrike(100n * WAD, 0, 10)).toBe(100n * WAD);
    expect(gridStrikes(10n * WAD, 10).length).toBe(1);
    expect(moneynessBps(130n * WAD, 100n * WAD)).toBe(3000n);
  });
});

describe("lister", () => {
  test("lists calls and puts on the grid for both speeds, and a second run lists nothing", async () => {
    const chain = chainWith();
    const job = createListerJob(chain.context());
    const first = await job({ force: true });
    // 2 stocks x 2 speeds x 2 sides x 5 strikes = 40 (NVDA 5 distinct, SPY step 10 on 770.75: 690, 730, 770, 810, 850 = 5)
    expect(first.listed).toBe(40);
    expect(chain.sent.every((tx) => tx.name === "listSeries")).toBe(true);
    const before = chain.sent.length;
    const second = await job({ force: true });
    expect(second.listed).toBe(0);
    expect(chain.sent.length).toBe(before);
  });

  test("never lists when the price is stale, the session is closed, halted, or buys are paused", async () => {
    for (const price of [{ ...live, fresh: false }, { ...live, session: 2 }, { ...live, session: 4 }, { ...live, session: 3 }, { ...live, buysPaused: true }]) {
      const chain = chainWith(price);
      const result = await createListerJob(chain.context())({ force: true });
      expect(chain.sent).toEqual([]);
      expect((result.skipped as unknown[]).length).toBe(2);
      expect(result.retryAfterMs).toBeGreaterThan(0);
      expect(result.completedDay).toBeNull();
    }
  });

  test("archives series further than 30% from spot, keeps the rest, and does nothing when closed", async () => {
    const chain = chainWith();
    const far = chain.addSeries({ stock: A.nvda, isCall: true, strike: 300n * WAD, tauSeconds: 86_400 }); // +37.6%
    const near = chain.addSeries({ stock: A.nvda, isCall: false, strike: 150n * WAD, tauSeconds: 86_400 }); // -31.2%
    const ok = chain.addSeries({ stock: A.nvda, isCall: true, strike: 260n * WAD, tauSeconds: 604_800 }); // +19.3%
    chain.prices.set(A.spy, { ...live, session: 2 });
    await createListerJob(chain.context())({ force: true });
    const archived = chain.sent.filter((tx) => tx.name === "archive").map((tx) => tx.args[0]);
    expect(archived.sort()).toEqual([far.id, near.id].sort());
    expect(chain.series.get(ok.id)!.archived).toBe(false);
    // closed market: no archival at all
    const closed = chainWith({ ...live, session: 2 });
    closed.addSeries({ stock: A.nvda, isCall: true, strike: 300n * WAD, tauSeconds: 86_400 });
    await createListerJob(closed.context())({ force: true });
    expect(closed.sent).toEqual([]);
  });

  test("a listing that is not buyable by default is set buyable", async () => {
    const chain = chainWith();
    chain.listDefaultBuyable = false;
    chain.prices.delete(A.spy);
    chain.prices.set(A.spy, { ...live, session: 2 });
    await createListerJob(chain.context())({ force: true });
    expect(chain.sent.filter((tx) => tx.name === "setBuyable").length).toBe(20);
    expect([...chain.series.values()].every((s) => s.buyable)).toBe(true);
  });

  test("respects the per-run transaction cap and asks to be run again", async () => {
    const chain = chainWith();
    const result = await createListerJob(chain.context({}, { KEEPER_LISTER_MAX_TX: 10 }))({ force: true });
    expect(chain.sent.length).toBe(10);
    expect(result.remaining).toBe(30);
    expect(result.retryAfterMs).toBe(30_000);
  });

  test("a revert on one series does not stop the others, and is reported", async () => {
    const chain = chainWith();
    chain.prices.set(A.spy, { ...live, session: 2 });
    chain.failing.add("listSeries");
    await expect(createListerJob(chain.context())({ force: true })).rejects.toThrow("failed");
    expect(chain.sent.length).toBe(0);
  });

  test("completes the day only once, then skips until tomorrow", async () => {
    const chain = chainWith();
    let meta: Record<string, unknown> = {};
    const sql = Object.assign(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = strings.join("?");
      if (text.includes("select meta")) return [{ meta }];
      if (text.includes("insert into keeper_status")) meta = { ...meta, ...JSON.parse(String(values[1])) };
      return [];
    }, {});
    const context = chain.context({ sql });
    const job = createListerJob(context);
    const first = await job();
    expect(first.completedDay).toBeTruthy();
    meta = { ...meta, completedDay: first.completedDay };
    expect(await job()).toEqual({ skipped: "done today", completedDay: first.completedDay });
  });
});

describe("lister and series epochs (todo 23 fork bug: ids carry the epoch since 07b)", () => {
  test("a second run finds the listed epoch-0 series, lists nothing and turns them buyable", async () => {
    const chain = chainWith();
    chain.listDefaultBuyable = false;
    const job = createListerJob(chain.context());
    await job({ force: true });
    const listed = chain.sent.filter((tx) => tx.name === "listSeries").length;
    const second = await job({ force: true });
    expect(second.listed).toBe(0);
    expect(second.failures).toEqual([]);
    expect(chain.sent.filter((tx) => tx.name === "listSeries").length).toBe(listed);
    // every listing was followed by setBuyable on the series the registry actually created
    expect(chain.sent.filter((tx) => tx.name === "setBuyable").length).toBe(listed);
    expect([...chain.series.values()].every((s) => s.buyable)).toBe(true);
  });

  test("a strike whose live epoch decayed below norm 0.001 gets its next epoch listed (decision 27)", async () => {
    const chain = chainWith();
    chain.prices.delete(A.spy);
    await createListerJob(chain.context())({ force: true });
    const first = [...chain.series.values()].find((s) => s.isCall && s.tauSeconds === 86_400 && !s.archived)!;
    first.norm = 10n ** 14n;
    chain.sent.length = 0;
    const result = await createListerJob(chain.context())({ force: true });
    expect(result.listed).toBe(1);
    expect(chain.series.get(first.id)!.archived).toBe(true);
    const next = [...chain.series.values()].find((s) => s.stock === first.stock && s.isCall && s.strike === first.strike && s.tauSeconds === 86_400 && !s.archived)!;
    expect(next.id).not.toBe(first.id);
  });
});

describe("lister follow-up reads (todo 23 fork bug: 10 of 100 listings stayed non-buyable)", () => {
  test("a listing read back through a cached 'latest' still gets setBuyable (the read is pinned to the receipt block)", async () => {
    const chain = chainWith();
    chain.listDefaultBuyable = false;
    chain.staleLatest = true;
    const result = await createListerJob(chain.context())({ force: true });
    expect(result.listed).toBe(40);
    expect([...chain.series.values()].filter((s) => !s.buyable).length).toBe(0);
  });
});

