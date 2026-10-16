import type { Speed } from "../api/quote/model";

export interface NameSpec {
  name: string;
  /** Strike grid step, USD (launch-names.md). */
  strikeStep: number;
  /** Two-sided value of the primary Uniswap v3 hedge pool, USD (chain-facts R4, measured 2026-10-16). */
  poolDepthUsd: number;
  /** Primary pool fee, bps. */
  poolFeeBps: number;
  /** vol-engine sigma floor (fraction). */
  sigmaFloor: number;
  /** Typical weekend gap G and earnings move E used for the sigma bumps (vol-engine defaults). */
  weekendMove: number;
  earningsMove: number;
  /** Starting price for fixtures (feed value on 2026-10-16). */
  fixtureSpot: number;
  /** Annual vol of the fixture price process. */
  fixtureVol: number;
}

export interface EarningsEvent {
  name: string;
  /** Report time, unix seconds (after the close). */
  tSec: number;
  assumed: boolean;
}

export interface Scenario {
  label: string;
  /** Multiplies the vol-engine floors. */
  floorMult: number;
  /** Multiplies the final posted sigma (after the floor). */
  sigmaMult: number;
  /** Multiplies every single-print log return of size >= gapThreshold. */
  gapMult: number;
  hedge: boolean;
  /** Multiplies retail arrivals (0 = adversary has the pool to itself, so the caps and the stress budget are the only limit). */
  retailScale: number;
  /** Injected weekend gap at a Monday open about a week into the window: log move for single names (ETFs get half), e.g. -0.15. 0 = none. */
  weekendGap: number;
  /** Multiplies the measured hedge-pool depth (concentrated liquidity is deeper near the price than reserves suggest). */
  depthMult: number;
  /** PriceGuard's Uniswap TWAP cross-check (todo 04b, decisions 11 and 16), modelled: the pool price leads the feed by
   * `leadS` (arbitrage moves the pool before the next 0.5% feed print), the TWAP is the mean pool price over `windowS`,
   * and buys pause while |feed - TWAP| / TWAP exceeds the name's band. Omitted = not modelled (the todo 21 runs). */
  twap?: { windowS: number; leadS: number; bandBps: Readonly<Record<string, number>>; defaultBandBps: number };
}

export const BASE_SCENARIO: Scenario = { label: "base", floorMult: 1, sigmaMult: 1, gapMult: 1, hedge: true, depthMult: 1, weekendGap: 0, retailScale: 1 };

export interface SimConfig {
  names: NameSpec[];
  startSec: number;
  days: number;
  seed: number;
  scenario: Scenario;
  stepSeconds: number;
  initialNavUsd: number;
  earnings: EarningsEvent[];
  /** Retail buy arrivals per name per hour while buys are possible. */
  retailPerHour: number;
  adversaryAccounts: number;
  /** Adversary only plays prints at least this large (|log return|), singles / ETFs. */
  jumpThresholdSingle: number;
  jumpThresholdEtf: number;
}

export const SPEEDS: Speed[] = ["DAILY", "WEEKLY"];
export const ETFS = new Set(["SPY", "QQQ"]);

export type Group = "retail" | "gap" | "earnings";

export interface RunResult {
  scenario: string;
  seed: number;
  source: string;
  startIso: string;
  endIso: string;
  insolvent: boolean;
  insolventAtIso: string | null;
  liquidationInsolvent: boolean;
  minNavUsd: number;
  minNavPerShare: number;
  finalNavUsd: number;
  navPerShareFinal: number;
  maxDrawdownPct: number;
  maxDrawdown30dPct: number;
  pass: boolean;
  failReasons: string[];
  pausedBuys: Record<string, number>;
  capBlocked: Record<string, number>;
  trades: { buys: number; sells: number; hedgeTrades: number; adversaryBuys: number; adversaryJobs: number; adversaryJobsOpened: number };
  pnlByGroup: Record<Group, number>;
  reserve: { peakUsd: number; maxUsedUsd: number; endUsd: number };
  hedgeCostUsd: number;
  spreadIncomeUsd: number;
  feeIncomeUsd: number;
  fundingIncomeUsd: number;
  sellShortfallUsd: number;
  perName: Record<string, {
    maxOptionValuePctNav: number; avgOptionValuePctNav: number; maxUnhedgedDeltaPctNav: number; maxNetDeltaUnits: number; maxStressLossPctNav: number;
  }>;
  maxStressLossPctNav: number;
  dailyNavPerShare: [string, number][];
  dataNotes: string[];
}
