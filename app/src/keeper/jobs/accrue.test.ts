import { describe, expect, test } from "bun:test";
import { A, FakeChain, WAD } from "../test-support";
import { accrueInBatches, createAccrueJob, selectGrid, type GridEntry } from "./accrue";

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
    // These pin the dust cadence to a day (KEEPER_ACCRUE_DUST_MAX_AGE_SECONDS); the default is hourly since 28-merge (decision 57).
    const DAILY = { KEEPER_ACCRUE_DUST_MAX_AGE_SECONDS: 86_400 };
    const marksSql = (chain: FakeChain, mark: number | undefined) => Object.assign(
      async () => (mark === undefined ? [] : chain.order.map((id) => ({ series_id: id, v_mark: String(mark) }))), { begin: async () => undefined });

    test("a 1-wei position is not accrued hourly, a real one is, and dust is still caught up daily", async () => {
      const chain = new FakeChain();
      const real = chain.addSeries({ stock: A.nvda, isCall: true, strike: 100n * WAD, tauSeconds: 86_400, supply: 50n * WAD, lastAccrual: chain.nowSeconds - 3700n });
      const dust = [1, 2, 3].map((i) => chain.addSeries({
        stock: A.nvda, isCall: true, strike: BigInt(100 + i) * WAD, tauSeconds: 86_400, supply: 1n, lastAccrual: chain.nowSeconds - 3700n }));
      const job = createAccrueJob(chain.context({ sql: marksSql(chain, 2) }, DAILY));
      const first = await job();
      expect(first).toMatchObject({ due: 1, accrued: 1, deferredDust: 3 });
      expect(chain.sent.flatMap((tx) => tx.args[0] as string[])).toEqual([real.id]);
      for (const d of dust) expect(chain.series.get(d.id)!.lastAccrual).toBe(chain.nowSeconds - 3700n);
      // A day later the dust is accrued too (bookValue lags by at most the dust threshold per series).
      chain.nowSeconds += 86_400n;
      const day = await createAccrueJob(chain.context({ sql: marksSql(chain, 2) }, DAILY))();
      expect(day.accrued).toBe(4);
    });

    test("a session-boundary force does not drag dust into the hourly loop either", async () => {
      const chain = new FakeChain();
      chain.addSeries({ stock: A.nvda, isCall: true, strike: 100n * WAD, tauSeconds: 86_400, supply: 1n, lastAccrual: chain.nowSeconds - 120n });
      const result = await createAccrueJob(chain.context({ sql: marksSql(chain, 2) }, DAILY))(true);
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
        accrued += Number((await createAccrueJob(chain.context({ sql: marksSql(chain, 2) }, DAILY))()).accrued ?? 0);
      }
      expect(accrued).toBe(100);
    });
  });
});

describe("F08/F24 retireDust: dust series leave the engine's live list (decision 32)", () => {
  test("a live series worth under the minimum trade is retired, and is not accrued; real ones are", async () => {
    const chain = new FakeChain();
    const real = chain.addSeries({ stock: A.nvda, isCall: true, strike: 100n * WAD, tauSeconds: 86_400, supply: 50n * WAD, lastAccrual: chain.nowSeconds - 3700n });
    const dust = chain.addSeries({ stock: A.nvda, isCall: false, strike: 100n * WAD, tauSeconds: 86_400, supply: 1n, riskValue: WAD / 2n, lastAccrual: chain.nowSeconds - 3700n });
    const result = await createAccrueJob(chain.context())();
    const retire = chain.sent.filter((tx) => tx.name === "retireDust");
    expect(retire.length).toBe(1);
    expect(retire[0]!.args[0]).toEqual([dust.id]);
    expect(retire[0]!.to).toBe(A.engine);
    expect(result.retireSent).toBe(1);
    expect(chain.sent.filter((tx) => tx.name === "accrueMany").flatMap((tx) => tx.args[0] as string[])).toEqual([real.id]);
    expect(chain.series.get(dust.id)!.live).toBe(false);
  });

  test("a series retireDust keeps (its refreshed value is real) is not retried every run", async () => {
    const chain = new FakeChain();
    const kept = chain.addSeries({ stock: A.nvda, isCall: true, strike: 100n * WAD, tauSeconds: 86_400, supply: 5n * WAD, riskValue: WAD / 2n });
    chain.refreshedRisk.set(kept.id, 3n * WAD);
    const job = createAccrueJob(chain.context());
    await job();
    chain.series.get(kept.id)!.riskValue = WAD / 2n; // stale last-touch value again
    chain.nowSeconds += 300n;
    await job();
    expect(chain.sent.filter((tx) => tx.name === "retireDust").length).toBe(1);
    chain.nowSeconds += 3600n;
    await job();
    expect(chain.sent.filter((tx) => tx.name === "retireDust").length).toBe(2);
  });

  test("a failing retireDust does not stop the accrual", async () => {
    const chain = new FakeChain();
    chain.addSeries({ stock: A.nvda, isCall: true, strike: 100n * WAD, tauSeconds: 86_400, supply: 50n * WAD, lastAccrual: chain.nowSeconds - 3700n });
    chain.addSeries({ stock: A.nvda, isCall: false, strike: 100n * WAD, tauSeconds: 86_400, supply: 1n, riskValue: 1n });
    chain.failing.add("retireDust");
    const result = await createAccrueJob(chain.context())();
    expect(result.accrued).toBe(1);
  });
});

describe("F11/F34 fixed 5-minute accrual grid (decision 35)", () => {
  const livePrice = { s: 100n * WAD, session: 0, fresh: true, buysPaused: false, updatedAt: 1n };
  function gridChain(session = 0): { chain: FakeChain; ids: string[] } {
    const chain = new FakeChain();
    chain.nowSeconds = 1_800_000_000n - (1_800_000_000n % 300n) + 10n; // 10 s into a grid slot
    chain.prices.set(A.nvda, { ...livePrice, session });
    const ids = [0, 1].map((i) => chain.addSeries({
      stock: A.nvda, isCall: i === 0, strike: 100n * WAD, tauSeconds: 86_400, supply: 50n * WAD, lastAccrual: chain.nowSeconds - 5n, riskValue: 500n * WAD }).id);
    return { chain, ids };
  }
  const accrued = (chain: FakeChain) => chain.sent.filter((tx) => tx.name === "accrueMany").flatMap((tx) => tx.args[0] as string[]);

  test("every live series is sampled once per slot even when a holder accrued it a moment ago", async () => {
    const { chain, ids } = gridChain();
    const job = createAccrueJob(chain.context());
    const first = await job();
    expect(accrued(chain).sort()).toEqual([...ids].sort());
    expect(first.gridSampled).toBe(2);
    // same slot: nothing more
    chain.nowSeconds += 60n;
    await job();
    expect(accrued(chain).length).toBe(2);
    // next slot: a holder accrued 1 s ago (lastAccrual is fresh), the keeper samples anyway
    chain.nowSeconds += 240n;
    for (const id of ids) chain.series.get(id as `0x${string}`)!.lastAccrual = chain.nowSeconds - 1n;
    await job();
    expect(accrued(chain).length).toBe(4);
  });

  test("the next run is timed to the next grid boundary", async () => {
    const { chain } = gridChain();
    const result = await createAccrueJob(chain.context())();
    expect(result.retryAfterMs).toBe((300 - 10 + 5) * 1000);
  });

  test("dust and closed or unreadable names are not grid sampled (the hourly catch-up still covers them)", async () => {
    const { chain, ids } = gridChain(2);
    expect((await createAccrueJob(chain.context())()).gridSampled).toBe(0);
    expect(accrued(chain)).toEqual([]);
    chain.prices.set(A.nvda, livePrice);
    chain.series.get(ids[0] as `0x${string}`)!.riskValue = WAD / 2n; // dust (retired, never accrued)
    chain.nowSeconds += 300n;
    await createAccrueJob(chain.context())();
    expect(accrued(chain)).toEqual([ids[1]!]);
    const unread = new FakeChain();
    unread.addSeries({ stock: A.nvda, isCall: true, strike: 100n * WAD, tauSeconds: 86_400, supply: 50n * WAD, lastAccrual: unread.nowSeconds - 5n });
    expect((await createAccrueJob(unread.context())()).gridSampled).toBe(0);
  });

  test("accrueMany batches never exceed 45 series, whatever the setting", async () => {
    const chain = chainWithSeries(100);
    await accrueInBatches(chain.context(), chain.order, 200);
    expect(Math.max(...chain.sent.map((tx) => (tx.args[0] as unknown[]).length))).toBeLessThanOrEqual(45);
    const { loadConfig } = await import("../../config");
    expect(() => loadConfig({ DATABASE_URL: "postgres://u:p@127.0.0.1:5432/x", POSTGRES_PASSWORD: "p", KEEPER_ACCRUE_BATCH: "46" })).toThrow();
    expect(loadConfig({ DATABASE_URL: "postgres://u:p@127.0.0.1:5432/x", POSTGRES_PASSWORD: "p" }).KEEPER_ACCRUE_BATCH).toBeLessThanOrEqual(45);
  });

  describe("R13 the funding grid is bounded", () => {
    const sentIds = (chain: FakeChain) => chain.sent.filter((tx) => tx.name === "accrueMany").flatMap((tx) => tx.args[0] as string[]);

    test("PoC: 500 archived deep-ITM series held at $1.50 each are not on the 5-minute grid, only on the hourly catch-up", async () => {
      const chain = new FakeChain();
      chain.nowSeconds = 1_800_000_000n - (1_800_000_000n % 300n) + 10n;
      chain.prices.set(A.nvda, { s: 214n * WAD, session: 0, fresh: true, buysPaused: false, updatedAt: chain.nowSeconds - 30n });
      const attacker = Array.from({ length: 500 }, (_, i) => chain.addSeries({
        stock: A.nvda, isCall: true, strike: BigInt(10 + i) * WAD, tauSeconds: 86_400, supply: 2n * WAD, archived: true, buyable: false,
        lastAccrual: chain.nowSeconds, riskValue: 3n * WAD / 2n }).id);
      const honest = chain.addSeries({ stock: A.nvda, isCall: true, strike: 214n * WAD, tauSeconds: 86_400, supply: 50n * WAD, lastAccrual: chain.nowSeconds, riskValue: 400n * WAD }).id;
      const job = createAccrueJob(chain.context());
      for (let step = 0; step < 288; step++) { await job(); chain.nowSeconds += 300n; } // a whole day of 5-minute runs
      const perSeries = new Map<string, number>();
      for (const id of sentIds(chain)) perSeries.set(id, (perSeries.get(id) ?? 0) + 1);
      expect(perSeries.get(honest)).toBeGreaterThanOrEqual(285); // the real position is sampled in every slot
      for (const id of attacker) expect(perSeries.get(id) ?? 0).toBeLessThanOrEqual(25); // hourly, not 288 times
    });

    test("PROPERTY (R13 + R3-01): the grid is within the budget, takes a name whole when it fits, and otherwise only its non-archived series above the minimum value, the most valuable first", async () => {
      let seed = 31337;
      const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
      for (let trial = 0; trial < 25; trial++) {
        const chain = new FakeChain();
        chain.nowSeconds = 1_800_000_000n - (1_800_000_000n % 300n) + 10n;
        chain.prices.set(A.nvda, { s: 214n * WAD, session: rnd(2), fresh: true, buysPaused: false, updatedAt: chain.nowSeconds - 30n });
        const count = 1 + rnd(120);
        const info = new Map<string, { archived: boolean; value: bigint }>();
        for (let i = 0; i < count; i++) {
          const archived = rnd(3) === 0;
          const value = BigInt(1 + rnd(2000)) * WAD / BigInt(1 + rnd(4));
          const series = chain.addSeries({ stock: A.nvda, isCall: i % 2 === 0, strike: BigInt(50 + i) * WAD, tauSeconds: 86_400, supply: 5n * WAD, archived, buyable: !archived,
            lastAccrual: chain.nowSeconds - 5n, riskValue: value });
          info.set(series.id, { archived, value });
        }
        const budget = 1 + rnd(150);
        const minValue = BigInt(rnd(300)) * WAD;
        const result = await createAccrueJob(chain.context({}, { KEEPER_ACCRUE_GRID_MAX_SERIES: budget, KEEPER_ACCRUE_GRID_MIN_VALUE_USDG: Number(minValue / WAD) }))();
        const sampled = sentIds(chain);
        expect(Number(result.gridSampled)).toBeLessThanOrEqual(budget);
        const tier0 = [...info.entries()].filter(([, row]) => row.value >= WAD);
        for (const id of sampled) expect(info.get(id)!.value >= WAD).toBe(true); // never a dust-tier series
        if (tier0.length <= budget) {
          // whole name: every tier-0 series, archived and small ones included (R3-01)
          expect([...sampled].sort()).toEqual(tier0.map(([id]) => id).sort());
          expect(Number(result.gridSplit)).toBe(0);
        } else {
          for (const id of sampled) {
            expect(info.get(id)!.archived).toBe(false);
            expect(info.get(id)!.value >= minValue).toBe(true);
          }
          const eligible = tier0.map(([, row]) => row).filter((row) => !row.archived && row.value >= minValue).map((row) => row.value).sort((a, b) => (a < b ? 1 : -1));
          const taken = sampled.map((id) => info.get(id)!.value).sort((a, b) => (a < b ? 1 : -1));
          expect(taken).toEqual(eligible.slice(0, Math.min(budget, eligible.length)));
          expect(Number(result.gridSplit)).toBe(1);
        }
      }
    });
  });

  describe("R3-01 the grid takes every live-tier series of a name, so the engine's NAV pass completes every slot", () => {
    const sentIds = (chain: FakeChain) => chain.sent.filter((tx) => tx.name === "accrueMany").flatMap((tx) => tx.args[0] as string[]);
    function pocChain(): { chain: FakeChain; big: string[]; small: string; archived: string } {
      const chain = new FakeChain();
      chain.nowSeconds = 1_800_000_000n - (1_800_000_000n % 300n) + 10n;
      chain.prices.set(A.nvda, { s: 100n * WAD, session: 0, fresh: true, buysPaused: false, updatedAt: chain.nowSeconds - 30n });
      const big = Array.from({ length: 20 }, (_, i) => chain.addSeries({ stock: A.nvda, isCall: i < 10, strike: BigInt(95 + i) * WAD, tauSeconds: 86_400,
        supply: 1_000n * WAD, lastAccrual: chain.nowSeconds - 5n, riskValue: 1_700n * WAD }).id);
      const small = chain.addSeries({ stock: A.nvda, isCall: true, strike: 1045n * WAD / 10n, tauSeconds: 86_400, supply: 8n * WAD,
        lastAccrual: chain.nowSeconds - 5n, riskValue: 255n * WAD / 100n }).id;
      const archived = chain.addSeries({ stock: A.nvda, isCall: true, strike: 60n * WAD, tauSeconds: 86_400, supply: 2n * WAD, archived: true, buyable: false,
        lastAccrual: chain.nowSeconds - 5n, riskValue: 80n * WAD }).id;
      return { chain, big, small, archived };
    }

    test("PoC: a $2.55 position and an archived $80 one are sampled every slot with the name's $100+ series (they were hourly)", async () => {
      const { chain, big, small, archived } = pocChain();
      const job = createAccrueJob(chain.context());
      for (let step = 0; step < 24; step++) { await job(); chain.nowSeconds += 300n; } // two hours of slots
      const perSeries = new Map<string, number>();
      for (const id of sentIds(chain)) perSeries.set(id, (perSeries.get(id) ?? 0) + 1);
      for (const id of [...big, small, archived]) expect(perSeries.get(id)).toBe(24);
    });

    test("PROPERTY: with many names, every name either has all its live-tier series on the grid or is reported split; the budget is never exceeded", () => {
      let seed = 4242;
      const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
      for (let trial = 0; trial < 200; trial++) {
        const entries: GridEntry[] = [];
        const names = 1 + rnd(8);
        for (let k = 0; k < names; k++) {
          const stock = `0x${(0xa00 + k).toString(16).padStart(40, "0")}` as `0x${string}`;
          for (let i = 0, n = 1 + rnd(40); i < n; i++) {
            entries.push({ id: `0x${(trial * 10_000 + k * 100 + i).toString(16).padStart(64, "0")}` as `0x${string}`, stock,
              value: BigInt(1 + rnd(5_000)) * WAD, archived: rnd(4) === 0 });
          }
        }
        const budget = rnd(120);
        const minValue = BigInt(rnd(500)) * WAD;
        const out = selectGrid(entries, budget, minValue);
        expect(out.grid.length).toBeLessThanOrEqual(budget);
        expect(new Set(out.grid).size).toBe(out.grid.length);
        const onGrid = new Set(out.grid);
        for (const stock of new Set(entries.map((entry) => entry.stock.toLowerCase()))) {
          const mine = entries.filter((entry) => entry.stock.toLowerCase() === stock);
          if (out.whole.includes(stock)) for (const entry of mine) expect(onGrid.has(entry.id)).toBe(true);
          else {
            expect(out.split).toContain(stock);
            for (const entry of mine) if (onGrid.has(entry.id)) expect(!entry.archived && entry.value >= minValue).toBe(true);
          }
        }
        expect(out.skipped).toBe(entries.length - out.grid.length);
        // budget pressure (skeptic follow-up): the R13 parts of ALL names come first, so every name keeps its most valuable
        // non-archived series whenever the R13 parts fit, however much dust another name holds
        const r13 = entries.filter((entry) => !entry.archived && entry.value >= minValue).sort((a, b) => (a.value < b.value ? 1 : a.value > b.value ? -1 : 0));
        for (const entry of r13.slice(0, budget)) {
          // ties at the cut may go either way
          if (r13.length > budget && entry.value === r13[budget]!.value) continue;
          expect(onGrid.has(entry.id)).toBe(true);
        }
        // a whole name never displaces an R13 series: the grid holds min(budget, |R13|) R13 series at least
        expect(out.grid.filter((id) => r13.some((entry) => entry.id === id)).length).toBe(Math.min(budget, r13.length));
      }
    });

    test("PoC (skeptic): $2 in 430 archived series of the largest name cannot starve another name's 20 honest $5k series", () => {
      const X = "0x1111111111111111111111111111111111111111" as `0x${string}`;
      const Y = "0x2222222222222222222222222222222222222222" as `0x${string}`;
      let n = 0;
      const id = () => `0x${(++n).toString(16).padStart(64, "0")}` as `0x${string}`;
      const entries: GridEntry[] = [];
      for (let i = 0; i < 20; i++) entries.push({ id: id(), stock: X, value: 50_000n * WAD, archived: false });
      for (let i = 0; i < 430; i++) entries.push({ id: id(), stock: X, value: 2n * WAD, archived: true });
      const honestY = Array.from({ length: 20 }, () => id());
      for (const y of honestY) entries.push({ id: y, stock: Y, value: 5_000n * WAD, archived: false });
      const out = selectGrid(entries, 450, 100n * WAD);
      for (const y of honestY) expect(out.grid).toContain(y);
      expect(out.grid.length).toBeLessThanOrEqual(450);
      expect(out.whole).toContain(Y.toLowerCase());
      expect(out.split).toContain(X.toLowerCase()); // X's archived dust is what is left to the hourly catch-up
    });

    test("the keeper's dust line follows the engine's: a minimum trade of 0 means the $1 default", async () => {
      const { chain } = pocChain();
      chain.guards.minTradeUsdg = 0n;
      const dust = chain.addSeries({ stock: A.nvda, isCall: false, strike: 70n * WAD, tauSeconds: 86_400, supply: 1n * WAD, lastAccrual: chain.nowSeconds - 5n, riskValue: WAD / 2n }).id;
      const { readLiveRisk } = await import("../series");
      expect((await readLiveRisk(chain.context())).dustWad).toBe(WAD);
      await createAccrueJob(chain.context())();
      expect(sentIds(chain)).not.toContain(dust);
    });

    test("a dust-tier series (under the minimum trade at its mark) is not needed on the grid", async () => {
      const { chain } = pocChain();
      const dust = chain.addSeries({ stock: A.nvda, isCall: false, strike: 70n * WAD, tauSeconds: 86_400, supply: 1n * WAD, lastAccrual: chain.nowSeconds - 5n, riskValue: WAD / 2n }).id;
      await createAccrueJob(chain.context())();
      expect(sentIds(chain)).not.toContain(dust);
    });

    test("ALERT: a live-tier series of a name in session not re-marked for two grid intervals is reported", async () => {
      const { chain, small } = pocChain();
      const job = createAccrueJob(chain.context());
      expect((await job()).staleTier0).toBe(0); // first run: no alert (every mark is old after a start)
      chain.nowSeconds += 300n;
      expect((await job()).staleTier0).toBe(0);
      // the small series' mark did not move for two intervals (e.g. its accrual failed): reported
      chain.nowSeconds += 300n;
      chain.series.get(small as `0x${string}`)!.lastAccrual = chain.nowSeconds - 700n;
      expect((await job()).staleTier0).toBe(1);
    });
  });

  describe("R15 + R07 (28-merge): retired series go to accrueMany in an hourly dust pass, never re-sent in vain", () => {
    const manyIds = (chain: FakeChain) => chain.sent.filter((tx) => tx.name === "accrueMany").flatMap((tx) => tx.args[0] as string[]);
    const singles = (chain: FakeChain) => chain.sent.filter((tx) => tx.name === "accrue").map((tx) => tx.args[0] as string);

    test("PoC: retired dust series (supply left, off the live list) are accrued through accrueMany once an hour, never singly, never every run", async () => {
      const chain = new FakeChain();
      chain.nowSeconds = 1_800_000_000n - (1_800_000_000n % 300n) + 10n;
      chain.prices.set(A.nvda, { s: 214n * WAD, session: 0, fresh: true, buysPaused: false, updatedAt: chain.nowSeconds - 30n });
      const retired = [1, 2, 3].map((i) => chain.addSeries({ stock: A.nvda, isCall: true, strike: BigInt(300 + i) * WAD, tauSeconds: 86_400, supply: 1n,
        live: false, riskValue: WAD / 100n, lastAccrual: chain.nowSeconds - 3n * 86_400n }).id);
      const real = chain.addSeries({ stock: A.nvda, isCall: true, strike: 214n * WAD, tauSeconds: 86_400, supply: 50n * WAD, riskValue: 400n * WAD,
        lastAccrual: chain.nowSeconds }).id;
      const job = createAccrueJob(chain.context());
      let reportedAccrued = 0;
      let maxAge = 0n;
      for (let step = 0; step < 288; step++) {
        const r = await job(); reportedAccrued += Number(r.accrued ?? 0);
        for (const id of retired) { const age = chain.nowSeconds - chain.series.get(id as `0x${string}`)!.lastAccrual; if (age > maxAge) maxAge = age; }
        chain.nowSeconds += 300n;
      }
      for (const id of retired) {
        const n = manyIds(chain).filter((x) => x === id).length;
        expect(n).toBeGreaterThanOrEqual(22); // the R07 contract fix accrues them there: an hourly dust pass (decision 57)
        expect(n).toBeLessThanOrEqual(25); // the old R15 job sent each of them about 288 times
        expect(singles(chain).filter((x) => x === id).length).toBe(0);
      }
      expect(maxAge).toBeLessThanOrEqual(3600n + 300n); // every retired series is re-marked within the dust cadence + one run
      expect(manyIds(chain).filter((x) => x === real).length).toBeGreaterThanOrEqual(285);
      expect(reportedAccrued).toBe(manyIds(chain).length);
    });

    test("the dust pass sends every dust-tier series together, so the dust tier's NAV-mark pass completes in one run", async () => {
      const chain = new FakeChain();
      chain.prices.set(A.nvda, { s: 214n * WAD, session: 3, fresh: true, buysPaused: false, updatedAt: chain.nowSeconds - 30n });
      const old = chain.addSeries({ stock: A.nvda, isCall: true, strike: 301n * WAD, tauSeconds: 86_400, supply: 1n, live: false, riskValue: WAD / 100n,
        lastAccrual: chain.nowSeconds - 3700n }).id;
      const recent = chain.addSeries({ stock: A.nvda, isCall: true, strike: 302n * WAD, tauSeconds: 86_400, supply: 1n, live: false, riskValue: WAD / 100n,
        lastAccrual: chain.nowSeconds - 900n }).id; // retired a quarter of an hour ago
      const r = await createAccrueJob(chain.context())();
      expect(manyIds(chain).sort()).toEqual([old, recent].sort());
      expect(r.dustPass).toBe(2);
    });

    test("a retired series worth the minimum again is re-listed by the dust pass and joins the 5-minute grid", async () => {
      const chain = new FakeChain();
      chain.nowSeconds = 1_800_000_000n - (1_800_000_000n % 300n) + 10n;
      chain.prices.set(A.nvda, { s: 214n * WAD, session: 0, fresh: true, buysPaused: false, updatedAt: chain.nowSeconds - 30n });
      const back = chain.addSeries({ stock: A.nvda, isCall: true, strike: 210n * WAD, tauSeconds: 86_400, supply: 50n * WAD, live: false,
        riskValue: 400n * WAD, lastAccrual: chain.nowSeconds - 3700n }).id; // back in the money since its retirement
      const job = createAccrueJob(chain.context());
      await job();
      expect(chain.series.get(back as `0x${string}`)!.live).toBe(true);
      chain.nowSeconds += 300n;
      await job();
      expect(manyIds(chain).filter((x) => x === back).length).toBe(2); // dust pass, then the grid
    });

    test("PROPERTY: with no price change a second run sends nothing; over a day every held series is accrued within its cadence and a retired one at most 25 times", async () => {
      let seed = 2718;
      const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
      for (let trial = 0; trial < 20; trial++) {
        const chain = new FakeChain();
        chain.nowSeconds = 1_800_000_000n - (1_800_000_000n % 300n) + 10n;
        chain.prices.set(A.nvda, { s: 214n * WAD, session: 3, fresh: true, buysPaused: false, updatedAt: chain.nowSeconds - 30n }); // CLOSED-like: no grid
        const retired: string[] = [];
        const held: string[] = [];
        for (let i = 0; i < 1 + rnd(40); i++) {
          const kind = rnd(3);
          const series = chain.addSeries({ stock: A.nvda, isCall: i % 2 === 0, strike: BigInt(100 + i) * WAD, tauSeconds: 86_400,
            supply: kind === 2 ? 0n : BigInt(1 + rnd(5)) * WAD, live: kind === 0, riskValue: kind === 0 ? BigInt(10 + rnd(500)) * WAD : WAD / 100n,
            lastAccrual: chain.nowSeconds - BigInt(rnd(5) * 86_400 + 3_700) });
          if (kind === 1) retired.push(series.id);
          if (kind !== 2) held.push(series.id);
        }
        const job = createAccrueJob(chain.context());
        await job();
        const sent = chain.sent.length;
        await job(); // same instant, nothing changed
        expect(chain.sent.length).toBe(sent);
        let worst = 0n;
        for (let step = 0; step < 288; step++) {
          chain.nowSeconds += 300n; await job();
          for (const id of held) { const age = chain.nowSeconds - chain.series.get(id as `0x${string}`)!.lastAccrual; if (age > worst) worst = age; }
        }
        expect(worst).toBeLessThanOrEqual(3600n + 300n);
        expect(singles(chain).length).toBe(0);
        for (const id of retired) expect(manyIds(chain).filter((x) => x === id).length).toBeLessThanOrEqual(25);
      }
    });
  });
});
