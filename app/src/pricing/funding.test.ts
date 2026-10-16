import { expect, test } from "bun:test";
import { TAU, YEAR_S, callValue } from "./everlasting";
import { fundingRate, fundingStep } from "./funding";

const DAY = 86_400;

test("R6 fundingStepShapes", () => {
  // Far out of the money (payoff 0): rate 1, so Weekly loses 1/7 of units per day to first order, exp(-1/7) over a day.
  const otmV = callValue(80, 100, 0.5, TAU.WEEKLY / YEAR_S);
  expect(Math.abs(fundingStep(1, otmV, 0, DAY, TAU.WEEKLY) - Math.exp(-1 / 7))).toBeLessThan(1e-6);
  const oneSecond = 1 - fundingStep(1, otmV, 0, 1, TAU.WEEKLY);
  expect(Math.abs(oneSecond * DAY - 1 / 7)).toBeLessThan(1e-6);
  expect(Math.abs(fundingStep(1, otmV, 0, DAY, TAU.DAILY) - Math.exp(-1))).toBeLessThan(1e-12);

  // Deep in the money (V ~ payoff): almost nothing is charged.
  const S = 200;
  const itmV = callValue(S, 100, 0.5, TAU.WEEKLY / YEAR_S);
  expect(1 - fundingStep(1, itmV, S - 100, DAY, TAU.WEEKLY)).toBeLessThan(1e-8);

  // Never negative for gaps up to 400 days, at any moneyness and either speed (the linear spec form fails here).
  for (const tau of [TAU.DAILY, TAU.WEEKLY]) {
    for (const spot of [50, 90, 100, 110, 200]) {
      const V = callValue(spot, 100, 0.5, tau / YEAR_S);
      const payoff = Math.max(spot - 100, 0);
      for (const days of [0, 0.5, 1, 6.9, 7, 7.1, 30, 365, 400]) {
        const n = fundingStep(1e18, V, payoff, days * DAY, tau);
        expect(n).toBeGreaterThanOrEqual(0);
        expect(n).toBeLessThanOrEqual(1e18);
        expect(Number.isFinite(n)).toBe(true);
        if (days <= 400 && tau === TAU.WEEKLY) expect(n).toBeGreaterThan(0);
      }
    }
  }
  expect(fundingStep(1e18, otmV, 0, 400 * DAY, TAU.DAILY)).toBeGreaterThan(0);

  // Chunked stepping equals one step for constant V (hourly keeper vs one late accrual, and gaps longer than tau).
  for (const tau of [TAU.DAILY, TAU.WEEKLY]) {
    for (const [V, payoff] of [
      [otmV, 0],
      [3, 1],
      [itmV, S - 100],
    ] as const) {
      const total = 400 * DAY;
      const single = fundingStep(1e18, V, payoff, total, tau);
      let hourly = 1e18;
      for (let t = 0; t < total; t += 3600) hourly = fundingStep(hourly, V, payoff, 3600, tau);
      const irregular = [1, 59, 3600, 7 * DAY + 13, 86_399, 2 * tau + 1];
      let chunked = 1e18;
      let elapsed = 0;
      for (let i = 0; elapsed < total; i += 1) {
        const dt = Math.min(irregular[i % irregular.length]!, total - elapsed);
        chunked = fundingStep(chunked, V, payoff, dt, tau);
        elapsed += dt;
      }
      expect(Math.abs(hourly / single - 1)).toBeLessThan(1e-9);
      expect(Math.abs(chunked / single - 1)).toBeLessThan(1e-9);
    }
  }
});

test("fundingRate clamps to [0, 1] and treats a zero value as pure time value", () => {
  expect(fundingRate(2, 0)).toBe(1);
  expect(fundingRate(2, 1)).toBe(0.5);
  expect(fundingRate(1, 2)).toBe(0); // mark below payoff never grows the norm
  expect(fundingRate(0, 0)).toBe(1);
  expect(fundingStep(5, 1, 2, DAY, TAU.DAILY)).toBe(5);
  expect(fundingStep(5, 1, 0, 0, TAU.DAILY)).toBe(5);
  expect(() => fundingStep(-1, 1, 0, DAY, TAU.DAILY)).toThrow(RangeError);
  expect(() => fundingStep(1, 1, 0, -1, TAU.DAILY)).toThrow(RangeError);
  expect(() => fundingStep(1, 1, 0, DAY, 0)).toThrow(RangeError);
});
