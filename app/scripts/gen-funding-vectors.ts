// Writes contracts/test/vectors/funding-vectors.json: fixed-seed funding (norm shrink) vectors from the TypeScript
// reference fundingStep, for the Solidity Funding library to be checked against. Deterministic: running it twice gives
// identical bytes.
//
//   bun run scripts/gen-funding-vectors.ts
//
// Every number is a decimal string. norm, V, payoff and newNorm are WAD (value x 1e18, rounded to the nearest integer);
// dtSeconds and tauSeconds are seconds. V and payoff come from the pricing reference (a real option mark and its
// intrinsic value) except for the fixed edge cases. newNorm applies the on-chain floor MIN_NORM = 1e6 to the
// reference result, so the Solidity side can compare directly with a relative tolerance.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { TAU, YEAR_S, callValue, fundingStep, putValue } from "../src/pricing";

export const FUNDING_VECTOR_SEED = 0x4c4d4e53; // "LMNS", the same seed rule as the pricing vectors
export const FUNDING_VECTOR_COUNT = 200;
export const FUNDING_VECTORS_PATH = fileURLToPath(
  new URL("../../contracts/test/vectors/funding-vectors.json", import.meta.url),
);
/** On-chain floor of the normalization factor (contracts/src/libs/Funding.sol MIN_NORM). */
export const MIN_NORM_WAD = 10n ** 6n;

export interface FundingVector {
  norm: string;
  V: string;
  payoff: string;
  dtSeconds: string;
  tauSeconds: string;
  newNorm: string;
}

/** mulberry32: small, fixed, platform-independent 32-bit PRNG (same as gen-pricing-vectors.ts). */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function wad(value: number): bigint {
  if (!Number.isFinite(value) || value < 0) throw new RangeError(`wad: ${value}`);
  return BigInt(Math.round(value * 1e18));
}

/** One vector from WAD inputs. The reference runs on the WAD integers converted to doubles, scale 1e18 kept for norm. */
function vector(norm: bigint, V: bigint, payoff: bigint, dtSeconds: number, tauSeconds: number): FundingVector {
  const raw = fundingStep(Number(norm), Number(V) / 1e18, Number(payoff) / 1e18, dtSeconds, tauSeconds);
  let next = BigInt(Math.round(raw));
  if (next < MIN_NORM_WAD) next = norm < MIN_NORM_WAD ? norm : MIN_NORM_WAD;
  if (next > norm) next = norm;
  return {
    norm: norm.toString(),
    V: V.toString(),
    payoff: payoff.toString(),
    dtSeconds: String(dtSeconds),
    tauSeconds: String(tauSeconds),
    newNorm: next.toString(),
  };
}

const ONE = 10n ** 18n;
const DAY = 86_400;

/** Fixed edge cases first (spec 1.4 examples, zero/one rates, chunk boundaries, the floor), then random cases. */
export function buildFundingVectors(seed = FUNDING_VECTOR_SEED, count = FUNDING_VECTOR_COUNT): FundingVector[] {
  const hundred = 100n * ONE;
  const out: FundingVector[] = [
    vector(ONE, 2n * ONE, 0n, DAY, TAU.WEEKLY), // Weekly far OTM: loses 1 - e^(-1/7) of units per day
    vector(ONE, 2n * ONE, 0n, DAY, TAU.DAILY), // Daily far OTM: 1 - e^(-1) per day
    vector(ONE, hundred + 10n ** 12n, hundred, DAY, TAU.WEEKLY), // deep ITM, V = payoff + 1e-6: barely shrinks
    vector(ONE, 0n, 0n, DAY, TAU.WEEKLY), // V rounded to 0: rate 1
    vector(ONE, ONE, 2n * ONE, DAY, TAU.WEEKLY), // payoff above V: rate 0, no shrink
    vector(ONE, 2n * ONE, 0n, 0, TAU.WEEKLY), // dt = 0
    vector(ONE, 2n * ONE, ONE, TAU.WEEKLY, TAU.WEEKLY), // exactly one tau at rate 1/2
    vector(ONE, 2n * ONE, ONE, 3 * TAU.WEEKLY + 1234, TAU.WEEKLY), // three chunks and a remainder
    vector(ONE, 2n * ONE, 0n, 3650 * DAY, TAU.DAILY), // ten years far OTM: hits the floor
    vector(MIN_NORM_WAD, 2n * ONE, 0n, DAY, TAU.DAILY), // already at the floor: stays there
    vector(ONE, 5n * ONE, 4n * ONE, 30 * DAY, TAU.DAILY), // rate 1/5 over 30 days
  ];
  const rand = mulberry32(seed);
  const lnHalf = Math.log(0.5);
  while (out.length < count) {
    const kCents = 100 + Math.floor(rand() * 199_901); // K in [1.00, 2000.00]
    const ratio = Math.exp(lnHalf + rand() * -2 * lnHalf); // S/K in [0.5, 2], log-uniform
    const sCents = Math.max(1, Math.round(kCents * ratio));
    const sigmaBps = 2000 + Math.floor(rand() * 18_001); // [20%, 200%]
    const tauSeconds = rand() < 0.5 ? TAU.DAILY : TAU.WEEKLY;
    const isCall = rand() < 0.5;
    // norm in [1e-5, 1], log-uniform (an aged series); dt in [1 s, 60 days], log-uniform, 1 case in 10 exactly zero.
    const normWad = wad(Math.exp(Math.log(1e-5) * rand()));
    const dtRoll = rand();
    const dtSeconds = dtRoll < 0.1 ? 0 : Math.round(Math.exp(Math.log(60 * DAY) * rand()));
    const S = sCents / 100;
    const K = kCents / 100;
    const sigma = sigmaBps / 10_000;
    const tau = tauSeconds / YEAR_S;
    const V = wad(isCall ? callValue(S, K, sigma, tau) : putValue(S, K, sigma, tau));
    const sWad = BigInt(sCents) * 10n ** 16n;
    const kWad = BigInt(kCents) * 10n ** 16n;
    const payoff = isCall ? (sWad > kWad ? sWad - kWad : 0n) : kWad > sWad ? kWad - sWad : 0n;
    out.push(vector(normWad, V, payoff, dtSeconds, tauSeconds));
  }
  return out.slice(0, count);
}

/** The exact file contents: one case per line so diffs stay readable. */
export function renderFundingVectors(seed = FUNDING_VECTOR_SEED, count = FUNDING_VECTOR_COUNT): string {
  const cases = buildFundingVectors(seed, count).map((v) => `    ${JSON.stringify(v)}`);
  return [
    "{",
    `  "description": "In-kind funding steps from app/src/pricing/funding.ts: newNorm = norm * exp(-((V - payoff) / V) * dt / tau), rate clamped to [0, 1], V = 0 counts as rate 1, floored at MIN_NORM = 1e6. norm, V, payoff, newNorm are WAD decimal strings; dtSeconds and tauSeconds in seconds. Double-precision reference: compare with a relative tolerance.",`,
    `  "generator": "app/scripts/gen-funding-vectors.ts",`,
    `  "seed": ${seed},`,
    `  "count": ${count},`,
    `  "cases": [`,
    cases.join(",\n"),
    "  ]",
    "}",
    "",
  ].join("\n");
}

if (import.meta.main) {
  const text = renderFundingVectors();
  mkdirSync(dirname(FUNDING_VECTORS_PATH), { recursive: true });
  writeFileSync(FUNDING_VECTORS_PATH, text);
  console.log(`wrote ${FUNDING_VECTOR_COUNT} funding vectors to ${FUNDING_VECTORS_PATH} (${text.length} bytes)`);
}
