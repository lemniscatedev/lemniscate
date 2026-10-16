// A TypeScript port of the vol-engine's posting rule (vol-engine/src/vol_engine: realized.py, surface.py, guard.py),
// fed by the feed prints the pool would see. Differences from the Python service, all listed in the replay report:
// hourly samples stand in for 5-minute bars, and the feed is a step function (prints only on a 0.5% move), which
// understates realized vol; the floors usually decide anyway.
import { TAU, YEAR_S } from "../pricing";
import type { Speed } from "../api/quote/model";
import { sessionAt } from "./sessions";
import type { EarningsEvent, NameSpec, Scenario } from "./types";

const HALF_LIFE_DAYS: Record<Speed, number> = { DAILY: 1, WEEKLY: 5 };
const BARS_PER_DAY = 6.5; // hourly samples across a 6.5 h regular session
const RV_MARKUP = 1.15;
export const K_PUT = 1.2;
export const K_CALL = 0.4;
const MAX_STEP = 0.25;

const decay = (halfLifeBars: number): number => 0.5 ** (1 / halfLifeBars);

export class VolState {
  private lastRegular: { p: number; day: string } | null = null;
  private barVar: Record<Speed, number> = { DAILY: 0, WEEKLY: 0 };
  private gapVar: Record<Speed, number> = { DAILY: 0, WEEKLY: 0 };
  private bars = 0;
  private gaps = 0;
  private prior: Partial<Record<Speed, number>> = {};

  constructor(private readonly spec: NameSpec, private readonly scenario: Scenario, private readonly events: readonly EarningsEvent[]) {}

  /** Hourly observation of the feed price. */
  observe(tSec: number, price: number): void {
    if (sessionAt(tSec) !== "REGULAR") return;
    const day = new Date(tSec * 1000).toISOString().slice(0, 10);
    const prev = this.lastRegular;
    this.lastRegular = { p: price, day };
    if (!prev) return;
    const r = Math.log(price / prev.p);
    for (const speed of ["DAILY", "WEEKLY"] as const) {
      if (prev.day === day) {
        const lam = decay(HALF_LIFE_DAYS[speed] * BARS_PER_DAY);
        this.barVar[speed] = this.bars === 0 ? r * r : lam * this.barVar[speed] + (1 - lam) * r * r;
      } else {
        const lam = decay(HALF_LIFE_DAYS[speed]);
        this.gapVar[speed] = this.gaps === 0 ? r * r : lam * this.gapVar[speed] + (1 - lam) * r * r;
      }
    }
    if (prev.day === day) this.bars++; else this.gaps++;
  }

  private realized(speed: Speed): number {
    if (this.bars < 7) return 0;
    return Math.sqrt(252 * (BARS_PER_DAY * this.barVar[speed] + this.gapVar[speed]));
  }

  /** The sigma the oracle would post now (fraction), after the step guard. */
  post(tSec: number, speed: Speed): number {
    const floor = this.spec.sigmaFloor * this.scenario.floorMult;
    let sigma = Math.max(this.realized(speed) * RV_MARKUP, floor);
    const tauYears = TAU[speed] / YEAR_S;
    const session = sessionAt(tSec);
    if (session === "CLOSED" && this.spec.weekendMove > 0) sigma = Math.sqrt(sigma * sigma + (this.spec.weekendMove ** 2) / tauYears);
    const event = this.events.find((e) => e.name === this.spec.name && tSec >= e.tSec - TAU[speed] && tSec <= e.tSec + 86400);
    if (event && this.spec.earningsMove > 0) sigma = Math.sqrt(sigma * sigma + (this.spec.earningsMove ** 2) / tauYears);
    sigma *= this.scenario.sigmaMult;
    const prior = this.prior[speed];
    if (prior !== undefined) {
      const ref = Math.max(prior, floor);
      sigma = Math.min(Math.max(sigma, ref * (1 - MAX_STEP)), ref * (1 + MAX_STEP));
      sigma = Math.max(sigma, floor * this.scenario.sigmaMult);
    }
    this.prior[speed] = sigma;
    return sigma;
  }
}

/** sigma(K) = base * (1 + k_put max(0, -ln(K/S)) + k_call max(0, ln(K/S))) (design decision 17). */
export function skewedSigma(base: number, strike: number, spot: number): number {
  const m = Math.log(strike / spot);
  return base * (1 + K_PUT * Math.max(0, -m) + K_CALL * Math.max(0, m));
}
