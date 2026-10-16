import { describe, expect, test } from "bun:test";
import { QUOTE_PARAMS } from "../api/quote/model";
import { makeConfig } from "./config";
import { DEFAULT_NAMES, LIMITS } from "./defaults";
import { Pool, type NameCtx } from "./pool";
import { fixturePrices, injectGap, PricePath, scaleGaps } from "./prices";
import { Rng } from "./rng";
import { runSim } from "./run";
import { sessionAt } from "./sessions";
import { BASE_SCENARIO } from "./types";
import { skewedSigma } from "./vol";

const T0 = Date.parse("2026-07-06T00:00:00Z") / 1000;
const spec = DEFAULT_NAMES.find((n) => n.name === "NVDA")!;

function pool(session: NameCtx["session"] = "REGULAR", nav = 1_000_000): Pool {
  const p = new Pool(nav, true);
  p.nowSec = Date.parse("2026-07-08T15:00:00Z") / 1000;
  p.ctx.set("NVDA", { spec, spot: 200, session, fresh: true, sigma: { DAILY: 0.5, WEEKLY: 0.5 }, hasVol: true, blockFromMs: null, blockToMs: null });
  return p;
}

describe("R2 flow model is deterministic", () => {
  test("same seed, same draws; different seed, different draws", () => {
    const a = new Rng(7), b = new Rng(7), c = new Rng(8);
    const xs = Array.from({ length: 5 }, () => a.next());
    expect(Array.from({ length: 5 }, () => b.next())).toEqual(xs);
    expect(Array.from({ length: 5 }, () => c.next())).not.toEqual(xs);
  });
  test("a whole run is a pure function of (config, seed, prices)", () => {
    const prices = fixturePrices(DEFAULT_NAMES, T0 - 15 * 86400, T0 + 4 * 86400, 1);
    const one = runSim(makeConfig(T0, 3, 1), prices.paths);
    const two = runSim(makeConfig(T0, 3, 1), prices.paths);
    const other = runSim(makeConfig(T0, 3, 2), prices.paths);
    expect(JSON.stringify(two)).toBe(JSON.stringify(one));
    expect(JSON.stringify(other.dailyNavPerShare)).not.toBe(JSON.stringify(one.dailyNavPerShare));
  });
  test("fixture prices are reproducible and print like the feed (0.5% deviation or 24h)", () => {
    const a = fixturePrices(DEFAULT_NAMES, T0, T0 + 5 * 86400, 3).paths.get("TSLA")!;
    const b = fixturePrices(DEFAULT_NAMES, T0, T0 + 5 * 86400, 3).paths.get("TSLA")!;
    expect(a.prints).toEqual(b.prints);
    for (let i = 1; i < a.prints.length; i++) {
      const moved = Math.abs(a.prints[i]!.p / a.prints[i - 1]!.p - 1) >= 0.005 - 1e-9;
      expect(moved || a.prints[i]!.t - a.prints[i - 1]!.t >= 86400).toBe(true);
    }
  });
});

describe("sessions", () => {
  test("regular, extended, weekend, holiday", () => {
    expect(sessionAt(Date.parse("2026-07-08T15:00:00Z") / 1000)).toBe("REGULAR");
    expect(sessionAt(Date.parse("2026-07-08T22:00:00Z") / 1000)).toBe("EXTENDED");
    expect(sessionAt(Date.parse("2026-07-13T00:00:00Z") / 1000)).toBe("EXTENDED");
    expect(sessionAt(Date.parse("2026-07-11T15:00:00Z") / 1000)).toBe("CLOSED");
    expect(sessionAt(Date.parse("2026-09-07T15:00:00Z") / 1000)).toBe("CLOSED");
  });
});

describe("R3 the simulator prices with the engine model", () => {
  test("a buy pays exactly the quote model's ask and books only the spread as pool gain", () => {
    const p = pool();
    const before = p.equity();
    const r = p.buy("a", "retail", "NVDA", true, 200, "WEEKLY", 5_000, 1e12);
    expect(r.ok).toBe(true);
    const gain = p.equity() - before;
    expect(gain).toBeCloseTo(p.spreadIncome, 6);
    // 1.5% of the mark at the money (QUOTE_PARAMS.spreadBpsAtm), within the one-cent minimum
    expect(p.spreadIncome / 5_000).toBeGreaterThan(QUOTE_PARAMS.spreadBpsAtm / 10_000 - 1e-4);
    expect(p.spreadIncome / 5_000).toBeLessThan(QUOTE_PARAMS.spreadBpsAtm / 10_000 + 0.01);
    expect(p.feeIncome).toBeGreaterThan(0);
  });
  test("skew raises sigma for OTM puts faster than OTM calls", () => {
    expect(skewedSigma(0.5, 180, 200)).toBeGreaterThan(skewedSigma(0.5, 220, 200));
    expect(skewedSigma(0.5, 200, 200)).toBe(0.5);
  });
});

describe("caps, sessions and funding", () => {
  test("CLOSED blocks buys and counts the reason, but sells go through", () => {
    const open = pool("REGULAR");
    const r = open.buy("a", "retail", "NVDA", true, 200, "DAILY", 2_000, 1e12);
    expect(r.ok).toBe(true);
    const closed = open;
    closed.ctx.get("NVDA")!.session = "CLOSED";
    const blocked = closed.buy("b", "retail", "NVDA", true, 200, "DAILY", 2_000, 1e12);
    expect(blocked).toEqual({ ok: false, kind: "paused", reason: "SESSION_CLOSED" });
    expect(closed.paused["SESSION_CLOSED"]).toBe(1);
    if (r.ok) closed.sell(r.positionId);
    expect(closed.positions.size).toBe(0);
    expect(closed.sells).toBe(1);
  });
  test("per-account cap trims the size; per-series cap bounds the series", () => {
    const p = pool();
    for (let i = 0; i < 30; i++) p.buy("whale", "retail", "NVDA", true, 200, "WEEKLY", 20_000, 1e12);
    const s = [...p.series.values()][0]!;
    const value = s.tokens * s.norm * (p.liabilityOfName("NVDA") / (s.tokens * s.norm));
    expect(value).toBeLessThanOrEqual(Math.min(LIMITS.perSeriesUsd, 0.02 * p.equity()) * 1.001);
    expect(Object.keys(p.capBlocked).length).toBeGreaterThan(0);
  });
  test("stress budget refuses buys beyond 20% of NAV", () => {
    const p = pool("REGULAR", 100_000);
    for (let i = 0; i < 200; i++) p.buy(`a${i}`, "retail", "NVDA", i % 2 === 0, 200, "DAILY", 3_000, 1e12);
    expect(p.stressLoss()).toBeLessThanOrEqual(0.2 * p.equity() * 1.0001);
  });
  test("funding moves value from holders to the pool exactly", () => {
    const p = pool();
    p.buy("a", "retail", "NVDA", true, 200, "DAILY", 10_000, 1e12);
    const liab = p.totalLiability();
    const eq = p.equity();
    p.accrue(3600);
    expect(p.totalLiability()).toBeLessThan(liab);
    // the liability fell by (about, V frozen at the start of the step) what the pool booked as funding income
    expect(p.equity() - eq).toBeGreaterThan(0);
    expect(p.fundingIncome).toBeGreaterThan(0);
    expect(Math.abs(p.equity() - eq - p.fundingIncome) / p.fundingIncome).toBeLessThan(0.05);
  });
  test("LP deposit mints at NAV plus 10 bps and respects the NAV cap", () => {
    const p = pool("REGULAR", 1_000_000);
    expect(p.deposit(500_000)).toBe(true);
    expect(p.navPerShare()).toBeGreaterThan(1);
    expect(p.deposit(1_000_000)).toBe(false);
  });
});

describe("price transforms", () => {
  const path = new PricePath("X", [{ t: 0, p: 100 }, { t: 10, p: 102 }, { t: 20, p: 102.5 }, { t: 30, p: 90 }]);
  test("gaps x1.5 scales only moves of at least 1%", () => {
    const out = scaleGaps(path, 1.5);
    expect(Math.log(out.prints[1]!.p / out.prints[0]!.p)).toBeCloseTo(Math.log(1.02) * 1.5, 9);
    expect(Math.log(out.prints[2]!.p / out.prints[1]!.p)).toBeCloseTo(Math.log(102.5 / 102), 9);
    expect(scaleGaps(path, 1)).toBe(path);
  });
  test("injectGap steps every later price", () => {
    const out = injectGap(path, 15, Math.log(0.8));
    expect(out.at(14)!.p).toBe(102);
    expect(out.at(15)!.p).toBeCloseTo(81.6, 9);
    expect(out.at(30)!.p).toBeCloseTo(72, 9);
  });
});

describe("R4 outputs and the gate", () => {
  test("a run reports NAV path, drawdown, exposure, pauses, reserve and the insolvency flag", () => {
    const prices = fixturePrices(DEFAULT_NAMES, T0 - 15 * 86400, T0 + 6 * 86400, 1);
    const r = runSim(makeConfig(T0, 5, 1), prices.paths);
    expect(r.dailyNavPerShare.length).toBe(5);
    expect(typeof r.insolvent).toBe("boolean");
    expect(r.maxDrawdown30dPct).toBeGreaterThanOrEqual(0);
    expect(Object.keys(r.perName).sort()).toEqual(["AAPL", "NVDA", "QQQ", "SPY", "TSLA"]);
    expect(r.reserve.peakUsd).toBeGreaterThanOrEqual(0);
    expect(r.pass).toBe(!r.insolvent && r.maxDrawdown30dPct <= 15);
  });
  test("no-hedge scenario makes no hedge trades", () => {
    const prices = fixturePrices(DEFAULT_NAMES, T0 - 15 * 86400, T0 + 6 * 86400, 1);
    const r = runSim(makeConfig(T0, 5, 1, { ...BASE_SCENARIO, hedge: false }), prices.paths);
    expect(r.trades.hedgeTrades).toBe(0);
  });
});

describe("R3 engine comparison harness", () => {
  test("20 deterministic states; a quoter that echoes the sim passes, a skewed one fails", async () => {
    const { buildStates, compareWithEngine } = await import("./engine-check");
    const { quoteUnits } = await import("../api/quote/model");
    const { toRaw } = await import("../api/quote/parity");
    const states = buildStates();
    expect(states.length).toBe(20);
    expect(JSON.stringify(buildStates(), (_, v) => (typeof v === "bigint" ? v.toString() : v))).toBe(JSON.stringify(states, (_, v) => (typeof v === "bigint" ? v.toString() : v)));
    let current = states[0]!;
    const apply = async (s: typeof current) => { current = s; };
    const echo = async ({ isBuy }: { isBuy: boolean }) => toRaw(quoteUnits(current.series, current.market, current.unitsWad, isBuy)!);
    const ok = await compareWithEngine(echo as never, () => "0x", apply, states);
    expect(ok.status).toBe("pass");
    const skew = async ({ isBuy }: { isBuy: boolean }) => ({ ...toRaw(quoteUnits(current.series, current.market, current.unitsWad, isBuy)!), spreadBps: 1n });
    const bad = await compareWithEngine(skew as never, () => "0x", apply, states);
    expect(bad.status).toBe("fail");
  });
});
