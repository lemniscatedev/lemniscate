import { expect, test } from "bun:test";
import { isLaunched, launchConfigSchema } from "./launch";

test("keeps the seven current markets launched by default", () => {
  for (const symbol of ["NVDA", "TSLA", "SPY", "AAPL", "PLTR", "AMD", "QQQ"]) {
    expect(isLaunched(symbol, undefined)).toBe(true);
  }
  expect(isLaunched("SPCX", undefined)).toBe(false);
});

test("launch overrides win and the config rejects malformed symbols", () => {
  expect(isLaunched("SPY", false)).toBe(false);
  expect(isLaunched("SPCX", true)).toBe(true);
  expect(launchConfigSchema.safeParse({ launchedByDefault: ["NVDA", "spcx"] }).success).toBe(false);
  expect(launchConfigSchema.safeParse({ launchedByDefault: ["NVDA"], extra: true }).success).toBe(false);
});
