// Writes contracts/test/vectors/pricing-vectors.json: fixed-seed test vectors from the TypeScript pricing reference, for
// the Solidity port to be checked against. Deterministic: running it twice gives identical bytes.
//
//   bun run scripts/gen-pricing-vectors.ts
//
// Every number is a decimal string. S, K, call, put and u are WAD (value x 1e18, rounded to the nearest integer);
// sigmaBps is basis points (5000 = 50%); tauSeconds is 86400 (Daily) or 604800 (Weekly). The reference runs in double
// precision, so each WAD value carries about 15 significant digits; compare with a relative tolerance, not exactly.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { TAU, YEAR_S, callValue, putValue, uOf } from "../src/pricing";

export const VECTOR_SEED = 0x4c4d4e53; // "LMNS"
export const VECTOR_COUNT = 2000;
export const VECTORS_PATH = fileURLToPath(new URL("../../contracts/test/vectors/pricing-vectors.json", import.meta.url));

export interface PricingVector {
  S: string;
  K: string;
  sigmaBps: string;
  tauSeconds: string;
  call: string;
  put: string;
  u: string;
}

/** mulberry32: small, fixed, platform-independent 32-bit PRNG. */
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

/** Value to a WAD decimal string. Values below 0.5e-18 become "0". */
export function toWad(value: number): string {
  if (!Number.isFinite(value) || value < 0) throw new RangeError(`toWad: ${value}`);
  return BigInt(Math.round(value * 1e18)).toString();
}

const CENT_WAD = 10n ** 16n;

function vector(sCents: number, kCents: number, sigmaBps: number, tauSeconds: number): PricingVector {
  const S = sCents / 100;
  const K = kCents / 100;
  const sigma = sigmaBps / 10_000;
  const tau = tauSeconds / YEAR_S;
  return {
    S: (BigInt(sCents) * CENT_WAD).toString(),
    K: (BigInt(kCents) * CENT_WAD).toString(),
    sigmaBps: String(sigmaBps),
    tauSeconds: String(tauSeconds),
    call: toWad(callValue(S, K, sigma, tau)),
    put: toWad(putValue(S, K, sigma, tau)),
    u: toWad(uOf(sigma, tau)),
  };
}

/** Fixed edge cases first (spec examples, at the money, the ends of the moneyness and sigma ranges), then random cases. */
export function buildPricingVectors(seed = VECTOR_SEED, count = VECTOR_COUNT): PricingVector[] {
  const out: PricingVector[] = [
    vector(10_000, 10_000, 5000, TAU.DAILY), // spec 1.2: 0.92525
    vector(12_000, 10_000, 4000, TAU.WEEKLY), // spec 1.2: 20.0204
    vector(10_000, 10_000, 5000, TAU.WEEKLY), // 2.447
    vector(11_500, 10_000, 5000, TAU.WEEKLY), // 15.15
  ];
  for (const tau of [TAU.DAILY, TAU.WEEKLY]) {
    for (const sigmaBps of [1500, 2000, 5000, 10_000, 20_000]) {
      for (const sCents of [5_000, 9_000, 9_999, 10_000, 10_001, 11_000, 20_000]) out.push(vector(sCents, 10_000, sigmaBps, tau));
    }
  }
  const rand = mulberry32(seed);
  const lnHalf = Math.log(0.5);
  while (out.length < count) {
    const kCents = 100 + Math.floor(rand() * 199_901); // K in [1.00, 2000.00]
    const ratio = Math.exp(lnHalf + rand() * -2 * lnHalf); // S/K in [0.5, 2], log-uniform
    const sCents = Math.max(1, Math.round(kCents * ratio));
    const sigmaBps = 2000 + Math.floor(rand() * 18_001); // [20%, 200%]
    const tau = rand() < 0.5 ? TAU.DAILY : TAU.WEEKLY;
    out.push(vector(sCents, kCents, sigmaBps, tau));
  }
  return out.slice(0, count);
}

/** The exact file contents: one case per line so diffs stay readable. */
export function renderPricingVectors(seed = VECTOR_SEED, count = VECTOR_COUNT): string {
  const cases = buildPricingVectors(seed, count).map((v) => `    ${JSON.stringify(v)}`);
  return [
    "{",
    `  "description": "Everlasting option values (r = 0) from app/src/pricing. S, K, call, put, u are WAD decimal strings; sigmaBps in bps; tauSeconds 86400 or 604800. Double-precision reference: compare with a relative tolerance.",`,
    `  "generator": "app/scripts/gen-pricing-vectors.ts",`,
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
  const text = renderPricingVectors();
  mkdirSync(dirname(VECTORS_PATH), { recursive: true });
  writeFileSync(VECTORS_PATH, text);
  console.log(`wrote ${VECTOR_COUNT} pricing vectors to ${VECTORS_PATH} (${text.length} bytes)`);
}
