import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { TAU, YEAR_S, callValue, timeValue, uOf } from "./everlasting";
import { VOL_POINT, callGreeks, dVdu, dudSigma, putGreeks } from "./greeks";
import { VECTORS_PATH, type PricingVector } from "../../scripts/gen-pricing-vectors";

const DAILY = TAU.DAILY / YEAR_S;
const WEEKLY = TAU.WEEKLY / YEAR_S;

/** mulberry32, fixed seed: the "fuzz" cases are the same on every run. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Point {
  S: number;
  K: number;
  sigma: number;
  tau: number;
}

/** S/K log-uniform in [1/2, 2], K log-uniform in [1, 1e4], sigma in [10%, 300%], tau in [1 h, 30 d]. */
function randomPoints(seed: number, n: number): Point[] {
  const r = rng(seed);
  const out: Point[] = [];
  for (let i = 0; i < n; i += 1) {
    const K = Math.exp(r() * Math.log(1e4));
    const S = K * Math.exp((r() * 2 - 1) * Math.LN2);
    const sigma = 0.1 + r() * 2.9;
    const tau = (3600 + r() * (30 * 86_400 - 3600)) / YEAR_S;
    out.push({ S, K, sigma, tau });
  }
  return out;
}

const relErr = (got: number, want: number): number => Math.abs(got - want) / Math.max(Math.abs(want), 1e-300);

/** Skip the subnormal far tail, where a double has no relative precision left to compare. */
const representable = (p: Point): boolean => timeValue(p.S, p.K, p.sigma, p.tau) > 1e-200 * p.K;

/** Step in S: S / (1000 u), so (h u / S)^2 = 1e-6 keeps the O(h^2) truncation far below 1e-4. */
const stepS = (p: Point): number => p.S / (1000 * uOf(p.sigma, p.tau));

/** Move S at least 4 steps away from the strike so the central difference does not straddle the branch change. */
function awayFromStrike(p: Point): Point {
  const h = stepS(p);
  if (Math.abs(p.S - p.K) >= 4 * h) return p;
  return { ...p, S: p.S <= p.K ? p.K - 4 * h : p.K + 4 * h };
}

// Gamma and vega are taken from the time value: the closed form minus its intrinsic part (S - K)+, which has zero
// gamma and vega away from the strike. It keeps deep in-the-money differences free of the cancellation in S - K + tv.
const tv = (S: number, p: Point, sigma = p.sigma): number => timeValue(S, p.K, sigma, p.tau);

const POINTS = randomPoints(0x47524b53, 3000).filter(representable);
const AT_STRIKE: Point[] = [];
for (const tau of [DAILY, WEEKLY, 3600 / YEAR_S, 30 / 365]) {
  for (const sigma of [0.1, 0.2, 0.5, 1, 2, 3]) for (const K of [0.01, 1, 100, 5000]) AT_STRIKE.push({ S: K, K, sigma, tau });
}

describe("greeks vs finite differences", () => {
  test("R1 deltaMatchesFiniteDifference", () => {
    let worst = 0;
    for (const p0 of POINTS) {
      const p = awayFromStrike(p0);
      const h = stepS(p);
      const fd = (callValue(p.S + h, p.K, p.sigma, p.tau) - callValue(p.S - h, p.K, p.sigma, p.tau)) / (2 * h);
      const e = relErr(fd, callGreeks(p.S, p.K, p.sigma, p.tau).delta);
      worst = Math.max(worst, e);
      expect(e).toBeLessThan(1e-4);
    }
    // At S = K: second-order one-sided differences from each side against the stated (S <= K) branch.
    for (const p of AT_STRIKE) {
      const h = stepS(p);
      const V = (s: number) => callValue(s, p.K, p.sigma, p.tau);
      const right = (-3 * V(p.K) + 4 * V(p.K + h) - V(p.K + 2 * h)) / (2 * h);
      const left = (3 * V(p.K) - 4 * V(p.K - h) + V(p.K - 2 * h)) / (2 * h);
      const g = callGreeks(p.K, p.K, p.sigma, p.tau).delta;
      expect(relErr(right, g)).toBeLessThan(1e-4);
      expect(relErr(left, g)).toBeLessThan(1e-4);
    }
    expect(worst).toBeLessThan(1e-5);
  });

  test("R2 gammaMatchesFiniteDifference", () => {
    for (const p0 of POINTS) {
      const p = awayFromStrike(p0);
      const h = stepS(p);
      const fd = (tv(p.S + h, p) - 2 * tv(p.S, p) + tv(p.S - h, p)) / (h * h);
      expect(relErr(fd, callGreeks(p.S, p.K, p.sigma, p.tau).gamma)).toBeLessThan(1e-4);
    }
    for (const p of AT_STRIKE) {
      const h = stepS(p);
      const V = (s: number) => callValue(s, p.K, p.sigma, p.tau);
      const right = (2 * V(p.K) - 5 * V(p.K + h) + 4 * V(p.K + 2 * h) - V(p.K + 3 * h)) / (h * h);
      const left = (2 * V(p.K) - 5 * V(p.K - h) + 4 * V(p.K - 2 * h) - V(p.K - 3 * h)) / (h * h);
      const g = callGreeks(p.K, p.K, p.sigma, p.tau).gamma;
      expect(relErr(right, g)).toBeLessThan(1e-4);
      expect(relErr(left, g)).toBeLessThan(1e-4);
    }
  });

  test("R3 vegaMatchesFiniteDifference", () => {
    for (const p of [...POINTS, ...AT_STRIKE]) {
      const h = p.sigma * 1e-5;
      const fd = ((tv(p.S, p, p.sigma + h) - tv(p.S, p, p.sigma - h)) / (2 * h)) * VOL_POINT;
      expect(relErr(fd, callGreeks(p.S, p.K, p.sigma, p.tau).vega)).toBeLessThan(1e-4);
    }
  });

  test("vega is the spec's dV/du * du/dsigma", () => {
    for (const p of [...POINTS.slice(0, 500), ...AT_STRIKE]) {
      const spec = dVdu(p.S, p.K, p.sigma, p.tau) * dudSigma(p.sigma, p.tau) * VOL_POINT;
      expect(relErr(spec, callGreeks(p.S, p.K, p.sigma, p.tau).vega)).toBeLessThan(1e-12);
    }
  });

  test("delta and gamma match the spec table form", () => {
    for (const p of [...POINTS.slice(0, 500), ...AT_STRIKE]) {
      const u = uOf(p.sigma, p.tau);
      const C = callValue(p.S, p.K, p.sigma, p.tau);
      const T = timeValue(p.S, p.K, p.sigma, p.tau); // = C - (S - K)+, taken directly (no cancellation deep in the money)
      const g = callGreeks(p.S, p.K, p.sigma, p.tau);
      const delta = p.S <= p.K ? ((0.5 + u) * C) / p.S : 1 + ((0.5 - u) * T) / p.S;
      const gamma = ((u * u - 0.25) * T) / (p.S * p.S);
      expect(Math.abs(g.delta - delta)).toBeLessThan(1e-12);
      expect(relErr(g.gamma, gamma)).toBeLessThan(1e-9);
    }
  });
});

describe("parity and ranges", () => {
  test("R4 putGreeksFromParity", () => {
    for (const p of [...POINTS, ...AT_STRIKE]) {
      const c = callGreeks(p.S, p.K, p.sigma, p.tau);
      const q = putGreeks(p.S, p.K, p.sigma, p.tau);
      expect(q.delta).toBe(c.delta - 1);
      expect(q.gamma).toBe(c.gamma);
      expect(q.vega).toBe(c.vega);
    }
  });

  test("R5 signsAndRanges", () => {
    // Wider domain than the finite-difference tests, including the underflowing tail.
    const r = rng(0x5349474e);
    for (let i = 0; i < 20_000; i += 1) {
      const K = Math.exp(r() * Math.log(1e6)) / 1e3;
      const S = K * Math.exp((r() * 2 - 1) * Math.log(20));
      const sigma = 0.1 + r() * 2.9;
      const tau = (3600 + r() * (30 * 86_400 - 3600)) / YEAR_S;
      const c = callGreeks(S, K, sigma, tau);
      const q = putGreeks(S, K, sigma, tau);
      expect(c.delta).toBeGreaterThanOrEqual(0);
      expect(c.delta).toBeLessThanOrEqual(1);
      expect(q.delta).toBeGreaterThanOrEqual(-1);
      expect(q.delta).toBeLessThanOrEqual(0);
      expect(c.gamma).toBeGreaterThanOrEqual(0);
      expect(c.vega).toBeGreaterThanOrEqual(0);
      // Open intervals wherever the q term is representable next to 1 (time value at least 1e-12 of K).
      if (timeValue(S, K, sigma, tau) >= 1e-12 * K) {
        expect(c.delta).toBeGreaterThan(0);
        expect(c.delta).toBeLessThan(1);
        expect(q.delta).toBeGreaterThan(-1);
        expect(q.delta).toBeLessThan(0);
        expect(c.gamma).toBeGreaterThan(0);
        expect(c.vega).toBeGreaterThan(0);
      }
      // Continuity at the strike.
      const at = callGreeks(K, K, sigma, tau).delta;
      expect(Math.abs(callGreeks(K * (1 + 1e-13), K, sigma, tau).delta - at)).toBeLessThan(1e-9);
      expect(Math.abs(callGreeks(K * (1 - 1e-13), K, sigma, tau).delta - at)).toBeLessThan(1e-9);
    }
  });

  test("spec 1.2: ATM delta = 1/2 + 1/(4u), V = K/(2u)", () => {
    for (const tau of [DAILY, WEEKLY]) {
      const u = uOf(0.5, tau);
      const g = callGreeks(100, 100, 0.5, tau);
      expect(Math.abs(g.delta - (0.5 + 1 / (4 * u)))).toBeLessThan(1e-15);
      expect(relErr(g.v, 100 / (2 * u))).toBeLessThan(1e-14);
    }
    expect(Math.abs(callGreeks(100, 100, 0.5, DAILY).v - 0.92525)).toBeLessThan(1e-5);
  });

  test("rejects non-positive or non-finite inputs", () => {
    expect(() => callGreeks(0, 100, 0.5, DAILY)).toThrow(RangeError);
    expect(() => putGreeks(100, Number.NaN, 0.5, DAILY)).toThrow(RangeError);
    expect(() => callGreeks(100, 100, 0, DAILY)).toThrow(RangeError);
    expect(() => callGreeks(100, 100, 0.5, Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });
});

describe("vectors", () => {
  test("R6 vectors carry the TS call Greeks (the Solidity side checks 500 of them within 1e-8)", () => {
    const file = JSON.parse(readFileSync(VECTORS_PATH, "utf8")) as { cases: PricingVector[] };
    for (const v of file.cases) {
      for (const f of ["delta", "gamma", "vega"] as const) expect(v[f]).toMatch(/^[0-9]+$/);
      const g = callGreeks(Number(v.S) / 1e18, Number(v.K) / 1e18, Number(v.sigmaBps) / 10_000, Number(v.tauSeconds) / YEAR_S);
      const near = (wad: string, want: number) =>
        expect(Math.abs(Number(wad) / 1e18 - want)).toBeLessThanOrEqual(1e-12 * Math.max(want, 1e-6));
      near(v.delta, g.delta);
      near(v.gamma, g.gamma);
      near(v.vega, g.vega);
    }
  });
});
