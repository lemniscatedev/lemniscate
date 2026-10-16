import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import {
  GAUSS_KRONROD_15,
  TAU,
  YEAR_S,
  callValue,
  callValueNumeric,
  integrate,
  normCdf,
  putValue,
  timeValue,
  uOf,
} from "./everlasting";
import {
  VECTORS_PATH,
  VECTOR_COUNT,
  buildPricingVectors,
  renderPricingVectors,
  type PricingVector,
} from "../../scripts/gen-pricing-vectors";

const DAILY = TAU.DAILY / YEAR_S;
const WEEKLY = TAU.WEEKLY / YEAR_S;
const K = 100;

function linspace(a: number, b: number, n: number): number[] {
  return Array.from({ length: n }, (_, i) => a + ((b - a) * i) / (n - 1));
}
function geomspace(a: number, b: number, n: number): number[] {
  return linspace(Math.log(a), Math.log(b), n).map(Math.exp);
}

describe("quadrature building blocks", () => {
  test("Gauss-Kronrod nodes integrate polynomials exactly (K15 to degree 22, G7 to degree 13)", () => {
    const { XGK, WGK, WG } = GAUSS_KRONROD_15;
    for (let k = 0; k <= 22; k += 2) {
      let kronrod = k === 0 ? WGK[7] : 0;
      let gauss = k === 0 ? WG[3] : 0;
      for (let j = 0; j < 7; j += 1) {
        kronrod += 2 * WGK[j]! * XGK[j]! ** k;
        if (j % 2 === 1) gauss += 2 * WG[(j - 1) / 2]! * XGK[j]! ** k;
      }
      expect(Math.abs(kronrod - 2 / (k + 1))).toBeLessThan(1e-15);
      if (k <= 12) expect(Math.abs(gauss - 2 / (k + 1))).toBeLessThan(1e-15);
    }
    expect(Math.abs(integrate(Math.exp, 0, 1) - (Math.E - 1))).toBeLessThan(1e-15);
    expect(Math.abs(integrate((x) => Math.exp(-x * x), 0, 12) - Math.sqrt(Math.PI) / 2)).toBeLessThan(1e-15);
  });

  test("normCdf matches high-precision reference values, including the far tail", () => {
    const cases: Array<[number, number]> = [
      [0, 0.5],
      [-1, 0.15865525393145705],
      [-2, 0.022750131948179207],
      [-5, 2.866515718791939e-7],
      [-10, 7.619853024160527e-24],
      [1, 0.8413447460685429],
      [3, 0.9986501019683699],
    ];
    for (const [d, want] of cases) expect(Math.abs(normCdf(d) / want - 1)).toBeLessThan(1e-14);
    // Series and continued fraction agree across their switch point.
    for (const d of linspace(-2.9, -2.75, 31)) {
      expect(Math.abs(normCdf(d - 1e-9) - normCdf(d)) / normCdf(d)).toBeLessThan(1e-7);
    }
  });
});

describe("everlasting closed form", () => {
  test("R1 closedFormMatchesQuadratureOnGrid", () => {
    let points = 0;
    let worstRel = 0;
    for (const tau of [DAILY, WEEKLY]) {
      for (const x of geomspace(0.5, 2, 50)) {
        for (const sigma of linspace(0.2, 2, 100)) {
          const S = x * K;
          const closed = callValue(S, K, sigma, tau);
          const numeric = callValueNumeric(S, K, sigma, tau);
          if (closed < 1e-9) {
            expect(Math.abs(numeric - closed)).toBeLessThan(1e-12);
          } else {
            const rel = Math.abs(numeric / closed - 1);
            worstRel = Math.max(worstRel, rel);
            expect(rel).toBeLessThan(1e-6);
          }
          points += 1;
        }
      }
    }
    expect(points).toBe(10_000);
    expect(worstRel).toBeLessThan(1e-6);
  });

  test("R1b the spec's integral as written (Black-Scholes integrand) agrees with the theta form and the closed form", () => {
    for (const tau of [DAILY, WEEKLY]) {
      for (const x of geomspace(0.5, 2, 9)) {
        for (const sigma of [0.2, 0.5, 1, 2]) {
          const S = x * K;
          const closed = callValue(S, K, sigma, tau);
          const literal = callValueNumeric(S, K, sigma, tau, { integrand: "blackScholes", relTol: 1e-10 });
          if (closed < 1e-9) expect(Math.abs(literal - closed)).toBeLessThan(1e-12);
          else expect(Math.abs(literal / closed - 1)).toBeLessThan(1e-6);
        }
      }
    }
  });

  test("R2 putCallParityExact", () => {
    for (const tau of [DAILY, WEEKLY]) {
      for (const x of [...geomspace(0.5, 2, 41), 1, 1 - 1e-9, 1 + 1e-9]) {
        for (const sigma of linspace(0.2, 2, 19)) {
          const S = x * K;
          const C = callValue(S, K, sigma, tau);
          const P = putValue(S, K, sigma, tau);
          const scale = Math.max(Math.abs(S - K), C, P);
          expect(Math.abs(C - P - (S - K))).toBeLessThanOrEqual(1e-12 * scale);
        }
      }
    }
  });

  test("R3 knownValues", () => {
    expect(Math.abs(callValue(100, 100, 0.5, 1 / 365) - 0.92525)).toBeLessThan(1e-5);
    expect(Math.abs(callValue(100, 100, 0.5, DAILY) - 0.92525)).toBeLessThan(1e-5);
    expect(Math.abs(callValue(120, 100, 0.4, 7 / 365) - 20.0204)).toBeLessThan(5e-5);
    expect(Math.abs(callValue(100, 100, 0.5, WEEKLY) - 2.447)).toBeLessThan(1e-3);
    expect(Math.abs(callValue(115, 100, 0.5, WEEKLY) - 15.15)).toBeLessThan(1e-2);
    // At the money both branches give K/(2u); put equals call there.
    expect(callValue(100, 100, 0.5, DAILY)).toBe(100 / (2 * uOf(0.5, DAILY)));
    expect(putValue(100, 100, 0.5, DAILY)).toBe(callValue(100, 100, 0.5, DAILY));
    // u in the hundreds (sigma 10%, Daily: u ~ 270) stays finite and positive in log space.
    expect(uOf(0.1, DAILY)).toBeGreaterThan(200);
    const deep = callValue(50, 100, 0.1, DAILY);
    expect(Number.isFinite(deep) && deep >= 0).toBe(true);
    expect(Number.isFinite(callValue(200, 100, 0.1, DAILY))).toBe(true);
  });

  test("R4 boundsAndMonotone", () => {
    const spots = linspace(50, 200, 301);
    const sigmas = linspace(0.2, 2, 37);
    for (const tau of [DAILY, WEEKLY]) {
      for (const sigma of sigmas) {
        let prevC = -1;
        let prevP = Number.POSITIVE_INFINITY;
        for (const S of spots) {
          const C = callValue(S, K, sigma, tau);
          const P = putValue(S, K, sigma, tau);
          expect(C).toBeGreaterThanOrEqual(Math.max(S - K, 0));
          expect(P).toBeGreaterThanOrEqual(Math.max(K - S, 0));
          expect(C).toBeLessThanOrEqual(S);
          expect(P).toBeLessThanOrEqual(K);
          if (prevC > 0) expect(C).toBeGreaterThan(prevC);
          else expect(C).toBeGreaterThanOrEqual(prevC);
          if (P > 0) expect(P).toBeLessThan(prevP);
          prevC = C;
          prevP = P;
        }
      }
      for (const S of linspace(50, 200, 61)) {
        let prevC = -1;
        let prevTV = -1;
        for (const sigma of sigmas) {
          // The call never falls as sigma rises; its time value strictly rises (deep in the money the call itself can
          // equal S - K to the last bit, so strictness is checked on the time value).
          const C = callValue(S, K, sigma, tau);
          const tv = timeValue(S, K, sigma, tau);
          expect(C).toBeGreaterThanOrEqual(prevC);
          if (prevTV > 0) expect(tv).toBeGreaterThan(prevTV);
          else expect(tv).toBeGreaterThanOrEqual(prevTV);
          prevC = C;
          prevTV = tv;
        }
      }
    }
    // Continuous across the S = K branch switch.
    const atm = timeValue(K, K, 0.5, DAILY);
    expect(Math.abs(callValue(K * (1 + 1e-12), K, 0.5, DAILY) - atm)).toBeLessThan(1e-9);
    expect(Math.abs(callValue(K * (1 - 1e-12), K, 0.5, DAILY) - atm)).toBeLessThan(1e-9);
  });

  test("R5 atmApproximation", () => {
    let checked = 0;
    for (const tau of [DAILY, WEEKLY]) {
      for (const sigma of linspace(0.05, 3, 60)) {
        const sst = sigma * Math.sqrt(tau);
        if (sst >= 0.2) continue;
        const V = callValue(K, K, sigma, tau);
        expect(Math.abs(V / (0.354 * K * sst) - 1)).toBeLessThan(0.01);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(80);
  });

  test("rejects non-positive or non-finite inputs", () => {
    expect(() => callValue(0, 100, 0.5, DAILY)).toThrow(RangeError);
    expect(() => callValue(100, 100, 0, DAILY)).toThrow(RangeError);
    expect(() => putValue(100, 100, 0.5, 0)).toThrow(RangeError);
    expect(() => callValue(Number.POSITIVE_INFINITY, 100, 0.5, DAILY)).toThrow(RangeError);
  });
});

describe("pricing vectors", () => {
  test("R7 vectorsDeterministic", () => {
    const a = renderPricingVectors();
    const b = renderPricingVectors();
    expect(a).toBe(b);
    expect(buildPricingVectors()).toHaveLength(VECTOR_COUNT);

    expect(existsSync(VECTORS_PATH)).toBe(true);
    const file = JSON.parse(readFileSync(VECTORS_PATH, "utf8")) as { count: number; cases: PricingVector[] };
    expect(file.count).toBe(VECTOR_COUNT);
    expect(file.cases).toHaveLength(VECTOR_COUNT);
    const fields = ["S", "K", "sigmaBps", "tauSeconds", "call", "put", "u"] as const;
    for (const v of file.cases) {
      for (const field of fields) expect(v[field]).toMatch(/^[0-9]+$/);
      const S = Number(v.S) / 1e18;
      const k = Number(v.K) / 1e18;
      const sigma = Number(v.sigmaBps) / 10_000;
      const tau = Number(v.tauSeconds) / YEAR_S;
      expect([TAU.DAILY, TAU.WEEKLY] as number[]).toContain(Number(v.tauSeconds));
      const call = callValue(S, k, sigma, tau);
      const put = putValue(S, k, sigma, tau);
      const near = (wad: string, want: number) =>
        expect(Math.abs(Number(wad) / 1e18 - want)).toBeLessThanOrEqual(1e-12 * Math.max(want, 1e-6));
      near(v.call, call);
      near(v.put, put);
      near(v.u, uOf(sigma, tau));
    }
    const first = file.cases[0]!;
    expect(first.S).toBe("100000000000000000000");
    expect(Math.abs(Number(first.call) / 1e18 - 0.92525)).toBeLessThan(1e-5);
  });
});
