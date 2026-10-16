import type { NameSpec } from "./types";

/** Per-name parameters. Pool depths are the two-sided primary-pool values measured on 2026-10-16
 * (docs/research/chain-facts.md R4, launch-names.md); strike steps from launch-names.md; floors and bump sizes are the
 * vol-engine's (config.py). AAPL is not in the vol-engine mega-cap list, so it takes the 45% floor. No addresses here. */
export const DEFAULT_NAMES: NameSpec[] = [
  { name: "NVDA", strikeStep: 5, poolDepthUsd: 3_000_000, poolFeeBps: 5, sigmaFloor: 0.30, weekendMove: 0.04, earningsMove: 0.07, fixtureSpot: 217.99, fixtureVol: 0.45 },
  { name: "TSLA", strikeStep: 10, poolDepthUsd: 460_000, poolFeeBps: 30, sigmaFloor: 0.30, weekendMove: 0.04, earningsMove: 0.08, fixtureSpot: 358.23, fixtureVol: 0.6 },
  { name: "SPY", strikeStep: 10, poolDepthUsd: 250_000, poolFeeBps: 5, sigmaFloor: 0.30, weekendMove: 0.02, earningsMove: 0, fixtureSpot: 770.75, fixtureVol: 0.16 },
  { name: "QQQ", strikeStep: 10, poolDepthUsd: 1_100_000, poolFeeBps: 5, sigmaFloor: 0.30, weekendMove: 0.025, earningsMove: 0, fixtureSpot: 716.25, fixtureVol: 0.21 },
  { name: "AAPL", strikeStep: 5, poolDepthUsd: 250_000, poolFeeBps: 5, sigmaFloor: 0.45, weekendMove: 0.04, earningsMove: 0.06, fixtureSpot: 344.78, fixtureVol: 0.28 },
];

/** Hedger settings, the defaults of src/config.ts HEDGER_*. */
export const HEDGER_DEFAULTS = { bandBps: 50, intervalSeconds: 1800, cooldownSeconds: 120, minTradeUsdg: 25, maxLiquidityBps: 2500, maxSlippageBps: 100 } as const;

/** Risk limits (spec 4.2 / 2.5 / 10; the published values live in api/caps.ts LAUNCH_CAPS). */
export const LIMITS = {
  poolNavCapUsd: 2_000_000,
  perSeriesUsd: 40_000,
  perSeriesPctNav: 2,
  perAccountSeriesUsd: 25_000,
  totalOptionValuePctNav: 35,
  perNamePctNav: 8,
  vegaPctNavPerVolPoint: 0.6,
  gammaPctNavPer1PctMove: 0.4,
  stressBudgetPctNav: 20,
  stressGap: 0.25,
  stressOthers: 0.10,
  drawdownPausePct: 15,
  extendedCapScale: 0.5,
  reserveSpreadShare: 0.15,
  reserveTargetPctNav: 5,
  depositEntryBps: 10,
} as const;

/** Earnings dates for Jul to Sep 2026 are NOT in the repo (only upcoming ones are). These are the usual cadence, flagged
 * `assumed` in every report; replace with sourced dates when available. After-close reports, 20:15 UTC. */
export const ASSUMED_EARNINGS_2026 = [
  { name: "TSLA", iso: "2026-07-22T20:15:00Z" },
  { name: "AAPL", iso: "2026-07-30T20:15:00Z" },
  { name: "NVDA", iso: "2026-08-26T20:15:00Z" },
] as const;
