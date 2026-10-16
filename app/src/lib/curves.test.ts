import { expect, test } from "bun:test";
import { curvePayoffPct, fairCarryAnnual, fairCarryDailyPct, sigmaFromCarry } from "./curves";

test("power curve payoffs match the documented instant moves", () => {
  expect(curvePayoffPct(2, 10)).toBeCloseTo(21, 3);
  expect(curvePayoffPct(2, -10)).toBeCloseTo(-19, 3);
  expect(curvePayoffPct(3, 10)).toBeCloseTo(33.1, 3);
  expect(curvePayoffPct(3, -10)).toBeCloseTo(-27.1, 3);
  expect(curvePayoffPct(0.5, 10)).toBeCloseTo(4.8809, 3);
  expect(curvePayoffPct(0.5, -10)).toBeCloseTo(-5.1317, 3);
  expect(curvePayoffPct(-1, 10)).toBeCloseTo(-9.0909, 3);
  expect(curvePayoffPct(-1, -10)).toBeCloseTo(11.1111, 3);
});

test("payoffs reject moves that cross the underlying floor", () => {
  expect(curvePayoffPct(2, -100)).toBeNull();
  expect(curvePayoffPct(0.5, -101)).toBeNull();
  expect(curvePayoffPct(Number.NaN, 10)).toBeNull();
  expect(curvePayoffPct(1, 1e305)).toBeNull();
});

test("fair carry uses only the volatility term", () => {
  expect(fairCarryAnnual(2, 0.5)).toBeCloseTo(0.25, 8);
  expect(fairCarryAnnual(3, 0.5)).toBeCloseTo(0.75, 8);
  expect(fairCarryAnnual(0.5, 0.5)).toBeCloseTo(-0.03125, 8);
  expect(fairCarryAnnual(-1, 0.5)).toBeCloseTo(0.25, 8);
  expect(fairCarryDailyPct(2, 0.5)).toBeCloseTo(0.06849, 5);
  expect(fairCarryDailyPct(0.5, 0.5)).toBeCloseTo(-0.00856, 5);
  expect(fairCarryAnnual(2, -0.1)).toBeNull();
  expect(fairCarryAnnual(2, Number.POSITIVE_INFINITY)).toBeNull();
  expect(fairCarryAnnual(2, 1e308)).toBeNull();
  expect(fairCarryDailyPct(2, 1e152)).toBeNull();
});

test("sigmaFromCarry inverts convex curves and rejects impossible root carry", () => {
  for (const exponent of [2, 3, -1]) {
    const carry = fairCarryAnnual(exponent, 0.4);
    expect(carry).not.toBeNull();
    expect(sigmaFromCarry(exponent, carry!)).toBeCloseTo(0.4, 8);
  }
  expect(sigmaFromCarry(0.5, 0.01)).toBeNull();
  expect(sigmaFromCarry(1, 0)).toBeNull();
  expect(sigmaFromCarry(1 - 1e-12, Number.MAX_VALUE)).toBeNull();
  expect(sigmaFromCarry(1e308, 1)).toBeNull();
});
