// Greeks of the everlasting option (r = 0), spec 1.3. Reference implementation in double precision; the Solidity port
// contracts/src/libs/EverlastingGreeks.sol is checked against it through the shared vectors file.
//
// With u = sqrt(1/4 + 2/(sigma^2 tau)), x = S/K and TV the time value (C if S <= K, else C - (S - K)):
//
//   Greek      S <= K                     S >= K
//   delta      (1/2 + u) C / S            1 + (1/2 - u) TV / S
//   gamma      (u^2 - 1/4) C / S^2        (u^2 - 1/4) TV / S^2
//   dV/du      C (ln x - 1/u)             TV (-ln x - 1/u)
//   vega       dV/du * du/dsigma,  du/dsigma = -2 / (sigma^3 tau u) = -(u^2 - 1/4) / (sigma u)
//
// Put Greeks follow from parity: put delta = call delta - 1, same gamma and vega.
//
// Computed form (algebraically the same, no cancellation): with q = x^(u - 1/2) when S <= K and q = x^(-(u + 1/2))
// when S > K (both exponents make q <= 1, taken in log space), C = TV = S q / (2u) on either side, so
//   delta = (u + 1/2)/(2u) q            (S <= K)      delta = 1 - (u - 1/2)/(2u) q     (S > K)
//   gamma = (u^2 - 1/4) q / (2u S)
//   vega  = S q (1/u + |ln x|) (u^2 - 1/4) / (2 u^2 sigma) * 0.01      (per vol point, 1% = 100 bps)
//
// Units: S, K in any common currency unit; sigma as a fraction; tau in years. delta per option unit, gamma per one
// currency unit move per option unit, vega per vol point per option unit, v the option value.
import { callValue, putValue, timeValue, uOf } from "./everlasting";

export interface Greeks {
  /** dV/dS per option unit. Call in (0, 1), put in (-1, 0). */
  delta: number;
  /** d2V/dS2: change of delta per one currency unit move of S. */
  gamma: number;
  /** dV/dsigma per vol point (sigma + 0.01). */
  vega: number;
  /** The option value itself (C for the call, P for the put). */
  v: number;
}

/** One vol point = 1% = 0.01 of sigma. */
export const VOL_POINT = 0.01;

function assertInputs(S: number, K: number, sigma: number, tauYears: number): void {
  for (const [name, value] of [["S", S], ["K", K], ["sigma", sigma], ["tau", tauYears]] as const) {
    if (!(value > 0) || !Number.isFinite(value)) throw new RangeError(`greeks: ${name} must be positive and finite: ${value}`);
  }
}

/** dV/du of the time value (shared by call and put). Negative: a larger u (lower vol) lowers the value. */
export function dVdu(S: number, K: number, sigma: number, tauYears: number): number {
  assertInputs(S, K, sigma, tauYears);
  const u = uOf(sigma, tauYears);
  const lnx = Math.log(S / K);
  const tv = timeValue(S, K, sigma, tauYears); // C below the strike, C - (S - K) above, without the cancellation
  return S <= K ? tv * (lnx - 1 / u) : tv * (-lnx - 1 / u);
}

/** du/dsigma = -2 / (sigma^3 tau u). */
export function dudSigma(sigma: number, tauYears: number): number {
  const u = uOf(sigma, tauYears);
  return -2 / (sigma * sigma * sigma * tauYears * u);
}

interface Core {
  delta: number;
  gamma: number;
  vega: number;
}

function core(S: number, K: number, sigma: number, tauYears: number): Core {
  assertInputs(S, K, sigma, tauYears);
  const u = uOf(sigma, tauYears);
  const a = 2 / (sigma * sigma * tauYears); // u^2 - 1/4, without the cancellation of forming it from u
  const lnx = Math.log(S / K);
  const below = S <= K;
  const q = Math.exp(below ? (u - 0.5) * lnx : -(u + 0.5) * lnx);
  const delta = below ? ((u + 0.5) / (2 * u)) * q : 1 - ((u - 0.5) / (2 * u)) * q;
  const gamma = (a * q) / (2 * u * S);
  const vega = ((S * q * (1 / u + Math.abs(lnx)) * a) / (2 * u * u * sigma)) * VOL_POINT;
  return { delta, gamma, vega };
}

/** Call Greeks. */
export function callGreeks(S: number, K: number, sigma: number, tauYears: number): Greeks {
  const g = core(S, K, sigma, tauYears);
  return { delta: g.delta, gamma: g.gamma, vega: g.vega, v: callValue(S, K, sigma, tauYears) };
}

/** Put Greeks by parity: delta = call delta - 1, same gamma and vega. */
export function putGreeks(S: number, K: number, sigma: number, tauYears: number): Greeks {
  const g = core(S, K, sigma, tauYears);
  return { delta: g.delta - 1, gamma: g.gamma, vega: g.vega, v: putValue(S, K, sigma, tauYears) };
}
