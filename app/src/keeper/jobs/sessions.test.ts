import { expect, test } from "bun:test";
import { decodeFunctionData } from "viem";
import { MarketHoursAbi } from "../../abi/MarketHours";
import { A, FakeChain } from "../test-support";
import { sessionsMeta, updateSessions } from "./sessions";
import { computeKindedSessions } from "../sessions";

function setup(now: string, meta: Record<string, unknown> = {}) {
  const chain = new FakeChain();
  chain.nowSeconds = BigInt(Date.parse(now) / 1000);
  // both stocks readable and quiet (CLOSED, no halt): the pre-push latch upkeep sends nothing
  for (const stock of [A.nvda, A.spy]) chain.prices.set(stock, { s: 100n * 10n ** 18n, session: 2, fresh: true, buysPaused: false, updatedAt: 1n });
  const pushes: { sessions: { open: bigint; close: bigint }[]; kinds: number[] }[] = [];
  const sql = Object.assign(async () => [{ meta }], {});
  const context = chain.context({
    sql,
    tx: { submit: async (t: { to: string; data: `0x${string}` }) => {
      expect(t.to).toBe(A.marketHours);
      const d = decodeFunctionData({ abi: MarketHoursAbi, data: t.data });
      expect(d.functionName).toBe("setSessionsWithKinds");
      const [sessions, kinds] = d.args as [{ open: bigint; close: bigint }[], number[]];
      pushes.push({ sessions: [...sessions], kinds: [...kinds] });
      return { simulated: false };
    } },
  });
  return { context, pushes, chain };
}

test("pushes a kinded calendar when none is stored, with REGULAR/EXTENDED kinds and no overlap", async () => {
  const { context, pushes } = setup("2026-10-16T15:00:00Z");
  const result = await updateSessions(context);
  expect(result.calendarUpdateNeeded).toBe(true);
  expect(pushes.length).toBe(1);
  const { sessions, kinds } = pushes[0]!;
  expect(sessions.length).toBe(kinds.length);
  expect(sessions.length).toBeLessThanOrEqual(32);
  expect(new Set(kinds)).toEqual(new Set([0, 1]));
  expect(Array.isArray(result.kinded)).toBe(true);
});

test("does nothing while the stored calendar covers a week ahead and matches", async () => {
  const now = new Date("2026-10-16T15:00:00Z");
  const stored = sessionsMeta(computeKindedSessions(now));
  const { context, pushes } = setup("2026-10-16T15:00:00Z", stored);
  expect(await updateSessions(context)).toEqual({ calendarUpdateNeeded: false });
  expect(pushes).toEqual([]);
});

test("pushes again when the stored horizon is closing in", async () => {
  const stored = sessionsMeta(computeKindedSessions(new Date("2026-10-01T15:00:00Z")));
  const { context, pushes } = setup("2026-10-20T15:00:00Z", stored);
  expect((await updateSessions(context)).calendarUpdateNeeded).toBe(true);
  expect(pushes.length).toBe(1);
});

test("R3-03: before a push deletes the past sessions, a visible derived halt start is stored", async () => {
  const chain = new FakeChain();
  chain.nowSeconds = BigInt(Date.parse("2026-10-23T20:05:00Z") / 1000);
  chain.kind = 3;
  chain.prices.set(A.nvda, { s: 100n * 10n ** 18n, session: 4, fresh: false, buysPaused: true, updatedAt: 1n });
  const derived = chain.nowSeconds - 30n * 3600n;
  chain.derivedHalt.set(A.nvda, derived);
  const order: string[] = [];
  const inner = chain.tx();
  const context = chain.context({
    sql: Object.assign(async () => [{ meta: {} }], {}),
    tx: { submit: async (t: { label: string; to: `0x${string}`; data: `0x${string}` }) => {
      order.push(t.label);
      if (t.to === A.marketHours) { chain.derivedHalt.delete(A.nvda); return { simulated: false }; }
      return inner.submit(t);
    } },
  });
  expect((await updateSessions(context)).calendarUpdateNeeded).toBe(true);
  expect(order).toEqual(["prices:latch-halt", "sessions"]);
  expect(chain.haltedView(A.nvda)).toBe(derived);
});

/** A stored calendar whose horizon is between `minH` and `maxH` hours after `now`. */
function storedEndingIn(now: Date, minH: number, maxH: number) {
  for (let back = 1; back < 40 * 24; back++) {
    const kinded = computeKindedSessions(new Date(now.getTime() - back * 3600_000));
    const left = Number(kinded.at(-1)!.close) - now.getTime() / 1000;
    if (left > minH * 3600 && left < maxH * 3600) return sessionsMeta(kinded);
  }
  throw new Error("no stored calendar fits");
}

function haltedChain(now: string) {
  const chain = new FakeChain();
  chain.nowSeconds = BigInt(Date.parse(now) / 1000);
  chain.kind = 2;
  chain.prices.set(A.nvda, { s: 100n * 10n ** 18n, session: 4, fresh: false, buysPaused: true, updatedAt: 1n });
  chain.prices.set(A.spy, { s: 100n * 10n ** 18n, session: 2, fresh: true, buysPaused: false, updatedAt: 1n });
  chain.derivedHalt.set(A.nvda, chain.nowSeconds - 30n * 3600n);
  return chain;
}

function pushContext(chain: FakeChain, meta: Record<string, unknown>) {
  const labels: string[] = [];
  const inner = chain.tx();
  const context = chain.context({
    sql: Object.assign(async () => [{ meta }], {}),
    tx: { submit: async (t: { label: string; to: `0x${string}`; data: `0x${string}` }) => {
      if (t.to === A.marketHours) { labels.push(t.label); chain.derivedHalt.delete(A.nvda); return { simulated: false }; }
      return inner.submit(t);
    } },
  });
  return { context, labels };
}

test("R3-03 follow-up: a failed latch poke defers the push (retried next hour), so the derived start is not erased", async () => {
  const now = "2026-10-23T20:05:00Z";
  const chain = haltedChain(now);
  chain.failing.add("poke");
  const { context, labels } = pushContext(chain, storedEndingIn(new Date(now), 48, 6 * 24));
  const result = await updateSessions(context);
  expect(result.deferred).toBe(true);
  expect(labels).toEqual([]);
  expect(chain.derivedHalt.get(A.nvda)).toBeDefined(); // still readable; stored on the next try
  chain.failing.delete("poke");
  expect((await updateSessions(context)).deferred).toBeUndefined();
  expect(labels).toEqual(["sessions"]);
  expect(chain.haltedView(A.nvda)).toBe(chain.nowSeconds - 30n * 3600n);
});

test("R3-03 follow-up: a stock whose state could not be read defers the push", async () => {
  const now = "2026-10-23T20:05:00Z";
  const chain = haltedChain(now);
  chain.prices.delete(A.spy); // its read reverts
  const { context, labels } = pushContext(chain, storedEndingIn(new Date(now), 48, 6 * 24));
  expect((await updateSessions(context)).deferred).toBe(true);
  expect(labels).toEqual([]);
});

test("R3-03 follow-up: with under a day of calendar left the push goes out anyway (an expired calendar is worse)", async () => {
  const now = "2026-10-23T20:05:00Z";
  const chain = haltedChain(now);
  chain.failing.add("poke");
  const { context, labels } = pushContext(chain, storedEndingIn(new Date(now), 1, 23));
  expect((await updateSessions(context)).calendarUpdateNeeded).toBe(true);
  expect(labels).toEqual(["sessions"]);
});
