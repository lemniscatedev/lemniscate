import { describe, expect, test } from "bun:test";
import { A, FakeChain, WAD } from "../test-support";
import { accrueInBatches, createAccrueJob } from "./accrue";

function chainWithSeries(count: number, supply = 5n * WAD): FakeChain {
  const chain = new FakeChain();
  for (let i = 0; i < count; i++) {
    chain.addSeries({ stock: A.nvda, isCall: i % 2 === 0, strike: BigInt(100 + i) * WAD, tauSeconds: 86_400, supply, lastAccrual: chain.nowSeconds - 3700n });
  }
  return chain;
}

describe("accrual", () => {
  test("accrues everything that is due in batches that fit", async () => {
    const chain = chainWithSeries(100);
    const result = await createAccrueJob(chain.context({}, { KEEPER_ACCRUE_BATCH: 30 }))();
    expect(result.accrued).toBe(100);
    expect(chain.sent.length).toBe(4);
    expect(chain.sent.map((tx) => (tx.args[0] as unknown[]).length)).toEqual([30, 30, 30, 10]);
  });

  test("sends nothing when nothing is due or nobody holds the series", async () => {
    const chain = chainWithSeries(5);
    for (const s of chain.series.values()) s.lastAccrual = chain.nowSeconds - 3599n;
    const job = createAccrueJob(chain.context());
    expect((await job()).idle).toBe(true);
    for (const s of chain.series.values()) { s.lastAccrual = chain.nowSeconds - 7200n; s.supply = 0n; }
    expect((await job()).idle).toBe(true);
    expect(chain.sent).toEqual([]);
  });

  test("a skipped hour is caught up by the next run, and a second run in the same hour sends nothing", async () => {
    const chain = chainWithSeries(3);
    const job = createAccrueJob(chain.context());
    chain.nowSeconds += 3n * 3600n; // keeper was down for three hours
    for (const s of chain.series.values()) s.lastAccrual = chain.nowSeconds - 3n * 3600n - 3700n;
    expect((await job()).accrued).toBe(3);
    expect(chain.sent.length).toBe(1);
    expect((await job()).idle).toBe(true);
    expect(chain.sent.length).toBe(1);
  });

  test("a forced boundary accrual settles anything with time elapsed, even inside the hour", async () => {
    const chain = chainWithSeries(2);
    for (const s of chain.series.values()) s.lastAccrual = chain.nowSeconds - 120n;
    const job = createAccrueJob(chain.context());
    expect((await job()).idle).toBe(true);
    expect((await job(true)).accrued).toBe(2);
  });

  test("one series that reverts is isolated by splitting the batch; the rest are accrued", async () => {
    const chain = chainWithSeries(8);
    const bad = chain.order[5]!;
    chain.failing.add(`accrue:${bad}`);
    const outcome = await accrueInBatches(chain.context(), chain.order, 8);
    expect(outcome.failed.map((f) => f.id)).toEqual([bad]);
    expect(outcome.accrued.length).toBe(7);
    expect(chain.series.get(bad)!.lastAccrual).not.toBe(chain.nowSeconds);
    // the job reports the failure so the scheduler backs off and retries
    await expect(createAccrueJob(chain.context())()).rejects.toThrow("Accrual failed for 1");
  });

  test("dry run simulates and sends nothing real", async () => {
    const chain = chainWithSeries(2);
    chain.dryRun = true;
    const result = await createAccrueJob(chain.context())();
    expect(result.dryRun).toBe(true);
    expect([...chain.series.values()].every((s) => s.lastAccrual < chain.nowSeconds)).toBe(true);
  });

  describe("F28 dust positions are accrued lazily", () => {
    const marksSql = (chain: FakeChain, mark: number | undefined) => Object.assign(
      async () => (mark === undefined ? [] : chain.order.map((id) => ({ series_id: id, v_mark: String(mark) }))), { begin: async () => undefined });

    test("a 1-wei position is not accrued hourly, a real one is, and dust is still caught up daily", async () => {
      const chain = new FakeChain();
      const real = chain.addSeries({ stock: A.nvda, isCall: true, strike: 100n * WAD, tauSeconds: 86_400, supply: 50n * WAD, lastAccrual: chain.nowSeconds - 3700n });
      const dust = [1, 2, 3].map((i) => chain.addSeries({
        stock: A.nvda, isCall: true, strike: BigInt(100 + i) * WAD, tauSeconds: 86_400, supply: 1n, lastAccrual: chain.nowSeconds - 3700n }));
      const job = createAccrueJob(chain.context({ sql: marksSql(chain, 2) }));
      const first = await job();
      expect(first).toMatchObject({ due: 1, accrued: 1, deferredDust: 3 });
      expect(chain.sent.flatMap((tx) => tx.args[0] as string[])).toEqual([real.id]);
      for (const d of dust) expect(chain.series.get(d.id)!.lastAccrual).toBe(chain.nowSeconds - 3700n);
      // A day later the dust is accrued too (bookValue lags by at most the dust threshold per series).
      chain.nowSeconds += 86_400n;
      const day = await createAccrueJob(chain.context({ sql: marksSql(chain, 2) }))();
      expect(day.accrued).toBe(4);
    });

    test("a session-boundary force does not drag dust into the hourly loop either", async () => {
      const chain = new FakeChain();
      chain.addSeries({ stock: A.nvda, isCall: true, strike: 100n * WAD, tauSeconds: 86_400, supply: 1n, lastAccrual: chain.nowSeconds - 120n });
      const result = await createAccrueJob(chain.context({ sql: marksSql(chain, 2) }))(true);
      expect(result).toMatchObject({ idle: true });
      expect(chain.sent).toEqual([]);
    });

    test("fail-safe: an unknown mark is never treated as dust", async () => {
      const chain = new FakeChain();
      chain.addSeries({ stock: A.nvda, isCall: true, strike: 100n * WAD, tauSeconds: 86_400, supply: 1n, lastAccrual: chain.nowSeconds - 3700n });
      expect((await createAccrueJob(chain.context({ sql: marksSql(chain, undefined) }))()).accrued).toBe(1);
    });

    test("sybil: 100 dust positions on 100 series cost one accrual a day, not 24", async () => {
      const chain = new FakeChain();
      for (let i = 0; i < 100; i++) chain.addSeries({ stock: A.nvda, isCall: i % 2 === 0, strike: BigInt(100 + i) * WAD, tauSeconds: 86_400, supply: 1n, lastAccrual: chain.nowSeconds - 3700n });
      let accrued = 0;
      for (let hour = 0; hour < 24; hour++) {
        chain.nowSeconds += 3600n;
        accrued += Number((await createAccrueJob(chain.context({ sql: marksSql(chain, 2) }))()).accrued ?? 0);
      }
      expect(accrued).toBe(100);
    });
  });
});
