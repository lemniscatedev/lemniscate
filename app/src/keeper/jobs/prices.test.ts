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
      chain.kind = 2; // CLOSED: a halt is not latched outside REGULAR/EXTENDED (R05 below covers the in-session case)
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

const halted = { s: 100n * WAD, session: 4, fresh: false, buysPaused: true, updatedAt: 1n };

describe("R05: the keeper latches a halt that only the keeper will ever see", () => {
  test("PoC: a feed that stops in session is latched by the price upkeep (it was skipped as 'not live') and not twice", async () => {
    const chain = new FakeChain();
    chain.prices.set(A.nvda, halted);
    chain.kind = 0; // REGULAR
    const ctx = chain.context();
    const first = await keepLastGoodPrices(ctx);
    expect(first.latched).toEqual([A.nvda]);
    expect(chain.haltedSince.get(A.nvda)).toBe(chain.nowSeconds);
    expect(chain.sent.map((tx) => tx.label)).toEqual(["prices:latch-halt"]);
    expect((await keepLastGoodPrices(ctx)).latched).toEqual([]); // latched once, not re-sent every run
  });

  test("EXTENDED latches too; CLOSED and UNKNOWN never do (poke would be a no-op there)", async () => {
    for (const [kind, expected] of [[0, 1], [1, 1], [2, 0], [3, 0]] as const) {
      const chain = new FakeChain();
      chain.prices.set(A.nvda, halted);
      chain.kind = kind;
      expect((await keepLastGoodPrices(chain.context())).latched.length).toBe(expected);
    }
  });

  test("a name whose halt is already latched, or that is live, is left alone", async () => {
    const chain = new FakeChain();
    chain.prices.set(A.nvda, halted);
    chain.haltedSince.set(A.nvda, chain.nowSeconds - 100n);
    chain.prices.set(A.spy, { ...live, updatedAt: 1n });
    chain.lastGood.set(A.spy, { s: live.s, at: 1n });
    expect((await keepLastGoodPrices(chain.context())).latched).toEqual([]);
    expect(chain.sent).toEqual([]);
  });

  test("PROPERTY: for any session pattern and any in-session stop time, with only the keeper jobs running, the halt is latched on the first in-session pass and settleHalted is sent on the first pass after the delay", async () => {
    const { createSettleHaltedJob } = await import("./settle-halted");
    const HOUR = 3600n;
    let seed = 12345;
    const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
    for (let trial = 0; trial < 40; trial++) {
      const chain = new FakeChain();
      const start = chain.nowSeconds;
      // A pattern of session kinds per hour: some in-session hours (0 or 1), the rest CLOSED or UNKNOWN, random but with at least one in-session hour a day.
      const kinds = Array.from({ length: 24 * 12 }, (_, h) => (h % 24 < 8 || rnd(5) === 0 ? 2 + rnd(2) : rnd(2)));
      const stopAt = rnd(24 * 3) ;
      const ctx = chain.context();
      const settle = createSettleHaltedJob(ctx);
      let latchedAt: bigint | undefined;
      let firstInSessionHalted: bigint | undefined;
      let settledAt: bigint | undefined;
      for (let h = 0; h < kinds.length; h++) {
        chain.nowSeconds = start + BigInt(h) * HOUR;
        chain.kind = kinds[h]!;
        const stale = h >= stopAt;
        const inSession = chain.kind <= 1;
        // PriceGuard: stale in session = HALTED; stale and CLOSED for under 5 days = CLOSED at the last good price; older = HALTED.
        const ageDays = stale ? Number(chain.nowSeconds - (start + BigInt(stopAt) * HOUR)) / 86_400 : 0;
        const session = !stale ? 0 : inSession ? 4 : ageDays < 5 ? 2 : 4;
        chain.prices.set(A.nvda, { s: 100n * WAD, session, fresh: !stale, buysPaused: stale, updatedAt: start });
        chain.prices.delete(A.spy);
        ctx.deployment.stocks = [{ name: "NVDA", stock: A.nvda }] as never;
        if (stale && inSession && firstInSessionHalted === undefined) firstInSessionHalted = chain.nowSeconds;
        await keepLastGoodPrices(ctx);
        if (chain.haltedSince.get(A.nvda) && latchedAt === undefined) latchedAt = chain.nowSeconds;
        await settle();
        if (chain.settlePrices.get(A.nvda) && settledAt === undefined) settledAt = chain.nowSeconds;
      }
      if (firstInSessionHalted === undefined) continue; // never saw an in-session pass after the stop in this trial
      expect(latchedAt).toBe(firstInSessionHalted);
      const delay = BigInt(chain.guards.haltSettleDelay);
      const due = latchedAt! + delay;
      // settleable from `due` on, whenever the reading is HALTED then (always, past the 5-day age bound)
      expect(settledAt).toBeDefined();
      expect(settledAt! >= due).toBe(true);
      expect(settledAt! - due <= 2n * HOUR).toBe(true);
    }
  });
});

describe("R3-03: the latch decision reads the STORED latch, so a calendar push cannot erase a halt", () => {
  test("PoC: a derived start was visible, so the keeper never latched; a push then erased it. Now the start is stored", async () => {
    const chain = new FakeChain();
    const derived = chain.nowSeconds - 3600n;
    chain.prices.set(A.nvda, halted);
    chain.derivedHalt.set(A.nvda, derived);
    chain.kind = 0; // REGULAR
    const ctx = chain.context();
    expect((await keepLastGoodPrices(ctx)).latched).toEqual([A.nvda]);
    expect(chain.haltedSince.get(A.nvda)).toBe(derived); // the derived start, not now
    chain.derivedHalt.delete(A.nvda); // the sessions job pushes a future-only calendar
    expect(chain.haltedView(A.nvda)).toBe(derived);
    expect((await keepLastGoodPrices(ctx)).latched).toEqual([]); // stored once
  });

  test("out of session a visible derived start is stored too; without one nothing is sent", async () => {
    for (const kind of [2, 3]) {
      const chain = new FakeChain();
      chain.prices.set(A.nvda, halted);
      chain.kind = kind;
      expect((await keepLastGoodPrices(chain.context())).latched).toEqual([]);
      chain.derivedHalt.set(A.nvda, chain.nowSeconds - 7200n);
      expect((await keepLastGoodPrices(chain.context())).latched).toEqual([A.nvda]);
      expect(chain.haltedSince.get(A.nvda)).toBe(chain.nowSeconds - 7200n);
    }
  });

  test("a stored latch later than the derived start is moved earlier, never later", async () => {
    const chain = new FakeChain();
    chain.prices.set(A.nvda, halted);
    chain.kind = 2;
    chain.haltedSince.set(A.nvda, chain.nowSeconds - 100n);
    chain.derivedHalt.set(A.nvda, chain.nowSeconds - 5000n);
    expect((await keepLastGoodPrices(chain.context())).latched).toEqual([A.nvda]);
    expect(chain.haltedSince.get(A.nvda)).toBe(chain.nowSeconds - 5000n);
    chain.derivedHalt.set(A.nvda, chain.nowSeconds - 50n);
    expect((await keepLastGoodPrices(chain.context())).latched).toEqual([]);
    expect(chain.haltedSince.get(A.nvda)).toBe(chain.nowSeconds - 5000n);
  });

  test("PROPERTY: for any session pattern, stop time and calendar push times, with only the keeper jobs running, the halt start never increases or disappears while the feed is stale and settleHalted is sent on the first pass after first-stale + delay", async () => {
    const { createSettleHaltedJob } = await import("./settle-halted");
    const HOUR = 3600n;
    let seed = 777;
    const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
    for (let trial = 0; trial < 60; trial++) {
      const chain = new FakeChain();
      const start = chain.nowSeconds;
      const kinds = Array.from({ length: 24 * 12 }, (_, h) => (h % 24 < 8 || rnd(5) === 0 ? 2 + rnd(2) : rnd(2)));
      const pushes = new Set(Array.from({ length: 1 + rnd(4) }, () => rnd(24 * 12)));
      const stopAt = rnd(24 * 3);
      const ctx = chain.context();
      ctx.deployment.stocks = [{ name: "NVDA", stock: A.nvda }] as never;
      const settle = createSettleHaltedJob(ctx);
      let firstStale: bigint | undefined;
      let prev = 0n;
      let settledAt: bigint | undefined;
      const setPrice = (h: number) => {
        const stale = h >= stopAt;
        const inSession = chain.kind <= 1;
        const ageDays = stale ? Number(chain.nowSeconds - (start + BigInt(stopAt) * HOUR)) / 86_400 : 0;
        const latchedOrDerived = chain.haltedView(A.nvda) !== 0n;
        const session = !stale ? 0 : inSession || latchedOrDerived || ageDays >= 5 ? 4 : 2;
        chain.prices.set(A.nvda, { s: 100n * WAD, session, fresh: !stale, buysPaused: stale, updatedAt: start });
      };
      for (let h = 0; h < kinds.length; h++) {
        chain.nowSeconds = start + BigInt(h) * HOUR;
        chain.kind = kinds[h]!;
        // the derived start: the first in-session stale moment, visible until a push deletes that past session
        if (h >= stopAt && chain.kind <= 1 && firstStale === undefined) { firstStale = chain.nowSeconds; chain.derivedHalt.set(A.nvda, firstStale); }
        const pushFirst = rnd(2) === 0;
        const push = async () => {
          if (!pushes.has(h)) return;
          setPrice(h);
          await keepLastGoodPrices(ctx); // updateSessions stores any visible start before it pushes
          chain.derivedHalt.delete(A.nvda);
        };
        if (pushFirst) await push();
        setPrice(h);
        await keepLastGoodPrices(ctx);
        if (!pushFirst) await push();
        setPrice(h);
        await settle();
        if (chain.settlePrices.get(A.nvda) && settledAt === undefined) settledAt = chain.nowSeconds;
        const view = chain.haltedView(A.nvda);
        if (prev !== 0n) {
          expect(view).not.toBe(0n);
          expect(view <= prev).toBe(true);
        }
        if (view !== 0n) prev = view;
      }
      if (firstStale === undefined) continue;
      expect(prev).toBe(firstStale);
      const due = firstStale + BigInt(chain.guards.haltSettleDelay);
      if (start + BigInt(kinds.length - 1) * HOUR < due) continue;
      expect(settledAt).toBeDefined();
      expect(settledAt! >= due && settledAt! - due <= HOUR).toBe(true);
    }
  });
});

describe("R3-04: a latch left by a transient in-session halt is cleared on the next keeper pass", () => {
  test("PoC: the halt ended without a new feed round, so the live stock was skipped and the latch stayed", async () => {
    const chain = new FakeChain();
    chain.prices.set(A.nvda, { ...live });
    chain.lastGood.set(A.nvda, { s: live.s, at: live.updatedAt }); // same round as the live read
    chain.haltedSince.set(A.nvda, chain.nowSeconds - 600n); // latched by a 10-minute issuer pause
    const result = await keepLastGoodPrices(chain.context());
    expect(result.poked).toEqual([A.nvda]);
    expect(chain.haltedSince.get(A.nvda)).toBeUndefined();
    expect((await keepLastGoodPrices(chain.context())).poked).toEqual([]); // nothing left to clear
  });

  test("a continuity-paused stock is not re-poked every pass (poke would not clear it)", async () => {
    const chain = new FakeChain();
    chain.prices.set(A.nvda, { ...live });
    chain.lastGood.set(A.nvda, { s: live.s, at: live.updatedAt });
    chain.haltedSince.set(A.nvda, chain.nowSeconds - 600n);
    chain.contPaused.add(A.nvda);
    expect((await keepLastGoodPrices(chain.context())).poked).toEqual([]);
    expect(chain.sent).toEqual([]);
  });

  test("PROPERTY: after any in-session halt that ends with a live read and no new round, the stored latch is 0 after one pass", async () => {
    let seed = 99;
    const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
    for (let trial = 0; trial < 50; trial++) {
      const chain = new FakeChain();
      chain.kind = rnd(2);
      const ctx = chain.context();
      ctx.deployment.stocks = [{ name: "NVDA", stock: A.nvda }] as never;
      chain.prices.set(A.nvda, { ...live });
      await keepLastGoodPrices(ctx);
      const passes = 1 + rnd(5);
      for (let i = 0; i < passes; i++) {
        chain.nowSeconds += BigInt(60 + rnd(600));
        chain.prices.set(A.nvda, { ...halted, s: live.s, updatedAt: live.updatedAt });
        await keepLastGoodPrices(ctx);
      }
      expect(chain.haltedSince.get(A.nvda)).toBeDefined();
      chain.prices.set(A.nvda, { ...live }); // the halt ends; same feed round
      await keepLastGoodPrices(ctx);
      expect(chain.haltedSince.get(A.nvda)).toBeUndefined();
      chain.kind = 2; // a CLOSED read afterwards is not forced HALTED by a stale latch
      expect(chain.haltedView(A.nvda)).toBe(0n);
    }
  });
});
