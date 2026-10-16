// In-kind funding: each series has a normalization factor n (starts at 1, or 1e18 on-chain) that only falls.
// Holder units = token balance x n, so funding is paid by holding fewer units, never by a transfer or a bill.
//
// The spec's linear step n <- n (1 - (V - payoff)/(V tau) dt) goes negative once dt >= tau. The reference uses the
// continuous form (docs decision "Funding correction"):
//
//   n <- n * exp(-((V - payoff) / V) * dt / tau)
//
// with V evaluated at the start of the step. A gap longer than tau is applied in tau-sized chunks with V frozen at the
// start value, the same way the on-chain accrual does it (one fixed-point exp per chunk), so the two can be compared
// step for step. For constant V the chunks multiply to exactly the single-step factor.

/**
 * Fraction of the option's mark that funding charges: (V - payoff) / V, clamped to [0, 1].
 * V <= 0 (a value that rounded to zero far out of the money) counts as pure time value: rate 1.
 */
export function fundingRate(V: number, payoff: number): number {
  if (!(V > 0)) return 1;
  const r = (V - payoff) / V;
  if (r <= 0) return 0;
  return r >= 1 ? 1 : r;
}

/** Shrink factor for one step of at most tau seconds. */
function stepFactor(rate: number, dtSeconds: number, tauSeconds: number): number {
  return Math.exp(-rate * (dtSeconds / tauSeconds));
}

/**
 * Apply funding to a normalization factor over dtSeconds.
 * @param norm current normalization factor (any scale; 1 or 1e18)
 * @param V option value per unit at the start of the step (mark)
 * @param payoff intrinsic value per unit at the start of the step, (S-K)+ for a call, (K-S)+ for a put
 * @param dtSeconds elapsed time, >= 0
 * @param tauSeconds the series funding period (TAU.DAILY or TAU.WEEKLY)
 * @returns the new normalization factor, always > 0 when norm > 0 (it may underflow to 0 only after thousands of tau)
 */
export function fundingStep(norm: number, V: number, payoff: number, dtSeconds: number, tauSeconds: number): number {
  if (!(norm >= 0) || !Number.isFinite(norm)) throw new RangeError(`fundingStep: bad norm ${norm}`);
  if (!(dtSeconds >= 0) || !Number.isFinite(dtSeconds)) throw new RangeError(`fundingStep: bad dt ${dtSeconds}`);
  if (!(tauSeconds > 0)) throw new RangeError(`fundingStep: bad tau ${tauSeconds}`);
  const rate = fundingRate(V, payoff);
  if (rate === 0 || dtSeconds === 0) return norm;
  let n = norm;
  let remaining = dtSeconds;
  while (remaining > tauSeconds) {
    n *= stepFactor(rate, tauSeconds, tauSeconds);
    remaining -= tauSeconds;
  }
  return n * stepFactor(rate, remaining, tauSeconds);
}
