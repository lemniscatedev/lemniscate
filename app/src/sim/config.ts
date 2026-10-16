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

export function makeConfig(startSec: number, days: number, seed: number, scenario: Scenario = BASE_SCENARIO): SimConfig {
  return {
    names: DEFAULT_NAMES, startSec, days, seed, scenario, stepSeconds: 900, initialNavUsd: 1_000_000,
    earnings: ASSUMED_EARNINGS_2026.map((e) => ({ name: e.name, tSec: Date.parse(e.iso) / 1000, assumed: true })),
    retailPerHour: 3, adversaryAccounts: 8, jumpThresholdSingle: 0.012, jumpThresholdEtf: 0.006,
  };
}
