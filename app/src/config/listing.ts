import { encodeAbiParameters, keccak256, parseUnits, type Address, type Hex } from "viem";

/** Strike step in USD per launch name (docs/research/launch-names.md): about 1.3 % to 2.8 % of spot (AAPL, about 345 USD: 5, about 1.4 %). A name without an
 * entry is never listed: guessing a step would put strikes on a grid the contract may reject or nobody trades. */
export const STRIKE_STEP_USD: Readonly<Record<string, number>> = Object.freeze({ NVDA: 5, TSLA: 10, SPY: 10, QQQ: 10, AAPL: 5 });

/** Speeds the lister keeps a grid for: tau in seconds (spec: Daily 1 day, Weekly 7 days). */
export const SPEEDS = [
  { speed: 0, name: "DAILY", tauSeconds: 86_400 },
  { speed: 1, name: "WEEKLY", tauSeconds: 604_800 },
] as const;

/** Grid around spot, in basis points: ATM, +-5 %, +-10 %. Calls and puts at every strike. */
export const GRID_OFFSETS_BPS = [-1000, -500, 0, 500, 1000] as const;

/** A series further than this from spot (either side) is archived: not buyable any more, still sellable. */
export const ARCHIVE_MONEYNESS_BPS = 3000;

const WAD = 10n ** 18n;

/** Strike for `offsetBps` from spot, rounded half up to a multiple of the step. Never below one step. */
export function roundedStrike(spotWad: bigint, offsetBps: number, stepUsd: number): bigint {
  const step = parseUnits(String(stepUsd), 18);
  const target = spotWad * BigInt(10_000 + offsetBps) / 10_000n;
  const rounded = (target + step / 2n) / step * step;
  return rounded < step ? step : rounded;
}

/** The distinct strikes of the grid, ascending. Rounding can make neighbouring offsets coincide (a coarse step on a low
 * price), so duplicates are removed rather than listed twice. */
export function gridStrikes(spotWad: bigint, stepUsd: number): bigint[] {
  const strikes = new Set<bigint>(GRID_OFFSETS_BPS.map((offset) => roundedStrike(spotWad, offset, stepUsd)));
  return [...strikes].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** |K / S - 1| in basis points, rounded down. */
export function moneynessBps(strikeWad: bigint, spotWad: bigint): bigint {
  if (spotWad === 0n) return 0n;
  const diff = strikeWad > spotWad ? strikeWad - spotWad : spotWad - strikeWad;
  return diff * 10_000n / spotWad;
}

/** ISeriesRegistry id: keccak256(abi.encode(stock, isCall, strike, tauSeconds)). */
export function seriesId(stock: Address, isCall: boolean, strike: bigint, tauSeconds: number): Hex {
  return keccak256(encodeAbiParameters(
    [{ type: "address" }, { type: "bool" }, { type: "uint128" }, { type: "uint32" }],
    [stock, isCall, strike, tauSeconds],
  ));
}

export { WAD };
