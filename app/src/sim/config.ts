import { ASSUMED_EARNINGS_2026, DEFAULT_NAMES } from "./defaults";
import { BASE_SCENARIO, type Scenario, type SimConfig } from "./types";

export const SENSITIVITY: Scenario[] = [
  BASE_SCENARIO,
  { ...BASE_SCENARIO, label: "floors -20%", floorMult: 0.8 },
  { ...BASE_SCENARIO, label: "posted sigma -20% (floors included)", sigmaMult: 0.8 },
  { ...BASE_SCENARIO, label: "gaps x1.5", gapMult: 1.5 },
  { ...BASE_SCENARIO, label: "no hedge", hedge: false },
  { ...BASE_SCENARIO, label: "hedge pool depth x4", depthMult: 4 },
  { ...BASE_SCENARIO, label: "adversary only (no retail)", retailScale: 0 },
  { ...BASE_SCENARIO, label: "adversary only + gaps x1.5", retailScale: 0, gapMult: 1.5 },
  { ...BASE_SCENARIO, label: "adversary only + floors -20% + gaps x1.5 + no hedge", retailScale: 0, floorMult: 0.8, gapMult: 1.5, hedge: false },
  { ...BASE_SCENARIO, label: "injected weekend gap -15% (ETFs -7.5%)", weekendGap: -0.15, retailScale: 0.25 },
  { ...BASE_SCENARIO, label: "injected weekend gap +15% (ETFs +7.5%)", weekendGap: 0.15, retailScale: 0.25 },
  { ...BASE_SCENARIO, label: "injected gap -15%, no hedge", weekendGap: -0.15, retailScale: 0.25, hedge: false },
  { ...BASE_SCENARIO, label: "injected gap -15%, floors -20%, no hedge", weekendGap: -0.15, retailScale: 0.25, hedge: false, floorMult: 0.8 },
];

/** Decision 16 bands (TSLA 125 bps on its 0.3% pool, 75 bps elsewhere), 30-minute window; the pool leads the feed by
 * 10 minutes (an assumption: the time a 0.5% deviation print takes to land after the market moved). */
export const TWAP_MODEL = { windowS: 1800, leadS: 600, bandBps: { TSLA: 125 }, defaultBandBps: 75 } as const;

/** Review fixes F01/F02 (todo 27): PriceGuard.tradeTwap (5 minutes) worse-of pricing and the engine's 30-minute hold. */
export const TRADE_GUARD = { windowS: 300, holdS: 1800 } as const;

/** The gated pair and the sensitivity rows again with the TWAP cross-check modelled (todo 23). */
export const TWAP_SCENARIOS: Scenario[] = [
  { ...BASE_SCENARIO, label: "base + TWAP check", twap: TWAP_MODEL },
  { ...BASE_SCENARIO, label: "adversary only + TWAP check", retailScale: 0, twap: TWAP_MODEL },
  { ...BASE_SCENARIO, label: "injected weekend gap +15% + TWAP check", weekendGap: 0.15, retailScale: 0.25, twap: TWAP_MODEL },
];

export function makeConfig(startSec: number, days: number, seed: number, scenario: Scenario = BASE_SCENARIO): SimConfig {
  return {
    names: DEFAULT_NAMES, startSec, days, seed, scenario, stepSeconds: 900, initialNavUsd: 1_000_000,
    earnings: ASSUMED_EARNINGS_2026.map((e) => ({ name: e.name, tSec: Date.parse(e.iso) / 1000, assumed: true })),
    retailPerHour: 3, adversaryAccounts: 8, jumpThresholdSingle: 0.012, jumpThresholdEtf: 0.006,
  };
}
