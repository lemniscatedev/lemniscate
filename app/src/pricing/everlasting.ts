// Everlasting option pricing, r = 0 (reference implementation in double precision).
//
// An everlasting option whose holder pays funding at rate (V - payoff) / tau is worth a Black-Scholes option with an
// exponentially distributed expiry of mean tau:
//
//   V = integral_0^inf (1/tau) e^(-T/tau) C_BS(S, K, sigma, T) dT
//
// Closed form, with u = sqrt(1/4 + 2/(sigma^2 tau)) and x = S/K:
//   S <= K:  C = K/(2u) x^(1/2 + u)
//   S >= K:  C = (S - K) + K/(2u) x^(1/2 - u)
//   Put by parity: P = C - (S - K)
//
// Units here: plain numbers. S and K in any common currency unit, sigma as a fraction (0.5 = 50%), tau in years
// (Daily = 86400 / YEAR_S, Weekly = 604800 / YEAR_S). This module is the reference the Solidity port, the API quotes and
// the simulator are checked against, so it favours accuracy over speed.

/** Funding periods in seconds. */
export const TAU = { DAILY: 86_400, WEEKLY: 604_800 } as const;
/** One year = 365 calendar days, in seconds (weekends count). */
export const YEAR_S = 31_536_000;

function assertInputs(S: number, K: number, sigma: number, tauYears: number): void {
  if (!(S > 0) || !(K > 0) || !(sigma > 0) || !(tauYears > 0)) {
    throw new RangeError(`pricing inputs must be positive and finite: S=${S} K=${K} sigma=${sigma} tau=${tauYears}`);
  }
  if (!Number.isFinite(S) || !Number.isFinite(K) || !Number.isFinite(sigma) || !Number.isFinite(tauYears)) {
    throw new RangeError(`pricing inputs must be finite: S=${S} K=${K} sigma=${sigma} tau=${tauYears}`);
  }
}

/** u = sqrt(1/4 + 2/(sigma^2 tau)). Always >= 1/2. */
export function uOf(sigma: number, tauYears: number): number {
  if (!(sigma > 0) || !(tauYears > 0)) throw new RangeError(`uOf needs sigma > 0 and tau > 0: ${sigma}, ${tauYears}`);
  return Math.sqrt(0.25 + 2 / (sigma * sigma * tauYears));
}

/**
 * Time value K/(2u) x^(1/2 +/- u), shared by the call and the put (it is the same number for both, which is parity).
 * The power is taken in log space, exp((1/2 +/- u) ln x), so u in the hundreds neither overflows nor loses precision.
 */
export function timeValue(S: number, K: number, sigma: number, tauYears: number): number {
  assertInputs(S, K, sigma, tauYears);
  const u = uOf(sigma, tauYears);
  const lnx = Math.log(S / K);
  const exponent = S <= K ? 0.5 + u : 0.5 - u;
  return (K / (2 * u)) * Math.exp(exponent * lnx);
}

/** Everlasting call value. */
export function callValue(S: number, K: number, sigma: number, tauYears: number): number {
  const tv = timeValue(S, K, sigma, tauYears);
  return S > K ? S - K + tv : tv;
}

/**
 * Everlasting put value. Equal to C - (S - K) (parity); computed as (K - S)+ + time value so a far out-of-the-money put
 * keeps full relative precision instead of being the difference of two nearly equal numbers.
 */
export function putValue(S: number, K: number, sigma: number, tauYears: number): number {
  const tv = timeValue(S, K, sigma, tauYears);
  return S < K ? K - S + tv : tv;
}

// ---------------------------------------------------------------------------------------------------------------------
// Standard normal distribution, built from scratch (no tables of magic coefficients) so its accuracy is checkable.

const SQRT2 = Math.SQRT2;
const SQRT_PI = Math.sqrt(Math.PI);
const INV_SQRT_2PI = 1 / Math.sqrt(2 * Math.PI);

/** erf(z) for 0 <= z <= ~3 by its all-positive series: erf z = 2/sqrt(pi) e^(-z^2) sum 2^n z^(2n+1) / (2n+1)!!. */
function erfSeries(z: number): number {
  let term = z;
  let sum = z;
  const z2 = 2 * z * z;
  for (let n = 1; n < 500; n += 1) {
    term *= z2 / (2 * n + 1);
    sum += term;
    if (term < sum * 1e-17) break;
  }
  return (2 / SQRT_PI) * Math.exp(-z * z) * sum;
}

/** erfc(z) for z >= ~2 by the Laplace continued fraction (modified Lentz), relative accuracy ~1e-15 in the far tail. */
function erfcContinuedFraction(z: number): number {
  // erfc z = e^(-z^2)/sqrt(pi) * 1/(z + (1/2)/(z + 1/(z + (3/2)/(z + 2/(z + ...)))))
  const tiny = 1e-300;
  let f = z;
  let C = z;
  let D = 0;
  for (let n = 1; n < 5000; n += 1) {
    const a = n / 2;
    D = z + a * D;
    if (Math.abs(D) < tiny) D = tiny;
    C = z + a / C;
    if (Math.abs(C) < tiny) C = tiny;
    D = 1 / D;
    const delta = C * D;
    f *= delta;
    if (Math.abs(delta - 1) < 1e-16) break;
  }
  return Math.exp(-z * z) / (SQRT_PI * f);
}

/** Standard normal density. */
export function normPdf(d: number): number {
  return INV_SQRT_2PI * Math.exp(-0.5 * d * d);
}

/** Standard normal CDF with good relative accuracy in the lower tail (needed for deep out-of-the-money values). */
export function normCdf(d: number): number {
  if (Number.isNaN(d)) return Number.NaN;
  if (d === Number.POSITIVE_INFINITY) return 1;
  if (d === Number.NEGATIVE_INFINITY) return 0;
  const z = Math.abs(d) / SQRT2;
  const tail = z < 2 ? 1 - erfSeries(z) : erfcContinuedFraction(z); // erfc(z)
  return d < 0 ? 0.5 * tail : 1 - 0.5 * tail;
}

/** Plain Black-Scholes call with r = 0 and expiry T years. Used only by the numeric check. */
export function blackScholesCall(S: number, K: number, sigma: number, T: number): number {
  if (T <= 0) return Math.max(S - K, 0);
  const sd = sigma * Math.sqrt(T);
  const d1 = Math.log(S / K) / sd + sd / 2;
  const d2 = d1 - sd;
  return S * normCdf(d1) - K * normCdf(d2);
}

// ---------------------------------------------------------------------------------------------------------------------
// Adaptive Gauss-Kronrod (7-point Gauss / 15-point Kronrod, QUADPACK nodes). Globally adaptive: the panel with the
// largest error estimate is split until the total error is within tolerance.

const XGK = [
  0.991455371120812639206854697526329, 0.949107912342758524526189684047851, 0.864864423359769072789712788640926,
  0.741531185599394439863864773280788, 0.586087235467691130294144845693013, 0.405845151377397166906606412076961,
  0.207784955007898467600689403773245, 0.0,
] as const;
const WGK = [
  0.02293532201052922496373200805897, 0.063092092629978553290700663189204, 0.104790010322250183839876322541518,
  0.140653259715525918745189590510238, 0.16900472663926790282658342659855, 0.190350578064785409913256402421014,
  0.204432940075298892414161999234649, 0.209482141084727828012999174891714,
] as const;
// Gauss weights for the odd-index Kronrod nodes XGK[1], XGK[3], XGK[5] and the centre XGK[7].
const WG = [0.12948496616886969327061143267908, 0.27970539148927666790146777142378, 0.381830050505118944950369775488975,
  0.417959183673469387755102040816327] as const;

/** Exposed for the quadrature self-test. */
export const GAUSS_KRONROD_15 = { XGK, WGK, WG } as const;

interface Panel {
  a: number;
  b: number;
  value: number;
  error: number;
}

function gk15(f: (x: number) => number, a: number, b: number): Panel {
  const centre = 0.5 * (a + b);
  const half = 0.5 * (b - a);
  const fc = f(centre);
  let kronrod = fc * WGK[7];
  let gauss = fc * WG[3];
  for (let j = 0; j < 7; j += 1) {
    const dx = half * XGK[j]!;
    const sum = f(centre - dx) + f(centre + dx);
    kronrod += WGK[j]! * sum;
    if (j % 2 === 1) gauss += WG[(j - 1) / 2]! * sum;
  }
  return { a, b, value: kronrod * half, error: Math.abs((kronrod - gauss) * half) };
}

export interface QuadratureOptions {
  /** Relative tolerance on the integral (default 1e-12). */
  relTol?: number;
  /** Absolute tolerance on the integral (default 0). */
  absTol?: number;
  /** Initial number of equal panels (default 32). */
  panels?: number;
  /** Maximum number of panel splits (default 4000). */
  maxSplits?: number;
}

/** Integrate f over [a, b] adaptively. */
export function integrate(f: (x: number) => number, a: number, b: number, opts: QuadratureOptions = {}): number {
  const relTol = opts.relTol ?? 1e-12;
  const absTol = opts.absTol ?? 0;
  const n0 = opts.panels ?? 32;
  const maxSplits = opts.maxSplits ?? 4000;
  const panels: Panel[] = [];
  const width = (b - a) / n0;
  for (let i = 0; i < n0; i += 1) panels.push(gk15(f, a + i * width, i === n0 - 1 ? b : a + (i + 1) * width));
  for (let split = 0; split < maxSplits; split += 1) {
    let total = 0;
    let totalError = 0;
    let worst = 0;
    for (let i = 0; i < panels.length; i += 1) {
      const p = panels[i]!;
      total += p.value;
      totalError += p.error;
      if (p.error > panels[worst]!.error) worst = i;
    }
    if (totalError <= Math.max(absTol, relTol * Math.abs(total))) return total;
    const p = panels[worst]!;
    const mid = 0.5 * (p.a + p.b);
    panels.splice(worst, 1, gk15(f, p.a, mid), gk15(f, mid, p.b));
  }
  throw new Error("integrate: tolerance not reached within maxSplits");
}

export interface NumericOptions extends QuadratureOptions {
  /**
   * Which form of the expiry integral to integrate.
   * - "theta" (default): V = (S-K)+ + integral_0^inf e^(-T/tau) dC_BS/dT dT, with dC_BS/dT = S sigma phi(d1) / (2 sqrt T).
   *   This is the spec's integral after one integration by parts; the integrand is positive and needs only exp(), so it
   *   keeps full relative precision for deep out-of-the-money values.
   * - "blackScholes": the spec's integral exactly as written, (1/tau) e^(-T/tau) C_BS(T). C_BS for short expiries is a
   *   difference of two tiny numbers, so expect only ~1e-10 relative accuracy far out of the money.
   */
  integrand?: "theta" | "blackScholes";
}

/**
 * Everlasting call by numeric quadrature of the expiry integral (independent check of the closed form).
 * Substitutes T = tau w^2 (removes the 1/sqrt(T) singularity at T = 0 and makes the weight Gaussian in w) and
 * integrates w over [0, w* + 10], where w* = (|ln x| / (sigma sqrt(2 tau)))^(1/2) is where the integrand peaks.
 */
export function callValueNumeric(S: number, K: number, sigma: number, tauYears: number, opts: NumericOptions = {}): number {
  assertInputs(S, K, sigma, tauYears);
  const lnx = Math.log(S / K);
  const sqrtTau = Math.sqrt(tauYears);
  const wPeak = Math.sqrt(Math.abs(lnx) / (sigma * SQRT2 * sqrtTau));
  const upper = wPeak + 10;
  if ((opts.integrand ?? "theta") === "theta") {
    // e^(-T/tau) S sigma phi(d1) / (2 sqrt T) dT  with  T = tau w^2, dT = 2 tau w dw  ->  S sigma sqrt(tau) phi(d1) e^(-w^2) dw
    const scale = S * sigma * sqrtTau * INV_SQRT_2PI;
    const f = (w: number): number => {
      if (w <= 0) return lnx === 0 ? scale : 0;
      const sd = sigma * sqrtTau * w;
      const d1 = lnx / sd + sd / 2;
      return scale * Math.exp(-w * w - 0.5 * d1 * d1);
    };
    return Math.max(S - K, 0) + integrate(f, 0, upper, opts);
  }
  // (1/tau) e^(-T/tau) C_BS(T) dT  with  T = tau w^2  ->  2 w e^(-w^2) C_BS(tau w^2) dw
  const f = (w: number): number => (w <= 0 ? 0 : 2 * w * Math.exp(-w * w) * blackScholesCall(S, K, sigma, tauYears * w * w));
  return integrate(f, 0, upper, opts);
}
