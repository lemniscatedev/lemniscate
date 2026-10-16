import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  FUNDING_VECTORS_PATH,
  FUNDING_VECTOR_COUNT,
  MIN_NORM_WAD,
  buildFundingVectors,
  renderFundingVectors,
} from "../../scripts/gen-funding-vectors";

describe("funding vectors", () => {
  test("generator is deterministic and the committed file is current", () => {
    expect(renderFundingVectors()).toBe(renderFundingVectors());
    expect(readFileSync(FUNDING_VECTORS_PATH, "utf8")).toBe(renderFundingVectors());
  });

  test("every case: norm never rises, never below the floor", () => {
    const cases = buildFundingVectors();
    expect(cases.length).toBe(FUNDING_VECTOR_COUNT);
    for (const c of cases) {
      const before = BigInt(c.norm);
      const after = BigInt(c.newNorm);
      expect(after <= before).toBe(true);
      expect(after >= MIN_NORM_WAD).toBe(true);
    }
  });

  test("spec 1.4 examples: Weekly OTM loses 1 - e^(-1/7) per day; deep ITM barely shrinks", () => {
    const [weekly, , deepItm] = buildFundingVectors();
    expect(Number(weekly!.newNorm) / 1e18).toBeCloseTo(Math.exp(-1 / 7), 12);
    expect(1 - Number(deepItm!.newNorm) / 1e18).toBeLessThan(1e-5);
  });
});
