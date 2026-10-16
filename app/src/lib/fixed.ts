import { formatUnits, parseUnits } from "viem";

export const WAD = 10n ** 18n;
export const MIN_NORM_FACTOR = 10n ** 12n;
const MAX_PROJECTION_SECONDS = 7 * 24 * 60 * 60;

export function fixed(value: string | number | bigint | null | undefined): bigint {
  if (typeof value === "bigint") return value;
  if (value === null || value === undefined || value === "") return 0n;
  return parseUnits(String(value), 18);
}

export function decimal(value: bigint): string {
  return formatUnits(value, 18);
}

export function multiply(left: bigint, right: bigint): bigint {
  return (left * right) / WAD;
}

export function divide(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) return 0n;
  return (numerator * WAD) / denominator;
}

export function fromBps(value: bigint, bps: number | bigint): bigint {
  return (value * BigInt(bps)) / 10_000n;
}

export function ratioPercent(numerator: bigint, denominator: bigint): number {
  if (denominator <= 0n) return 0;
  const roundedTenThousandths = (numerator * 1_000_000n + denominator / 2n) / denominator;
  return Number(roundedTenThousandths) / 10_000;
}

export function fractionPercent(value: bigint): number {
  const roundedTenThousandths = (value * 1_000_000n + (value >= 0n ? WAD / 2n : -(WAD / 2n))) / WAD;
  return Number(roundedTenThousandths) / 10_000;
}

export function roundedPercent(value: number): number {
  return Number.isFinite(value) ? Math.round(value * 10_000) / 10_000 : 0;
}

export function projectNormFactor(
  normFactor: string | number | bigint,
  carryWad: string | number | bigint,
  elapsedSeconds: number,
): bigint {
  const elapsed = Math.max(0, Math.min(MAX_PROJECTION_SECONDS, Math.floor(elapsedSeconds)));
  const factor = fixed(normFactor);
  const carry = fixed(carryWad);
  const decay = (carry * BigInt(elapsed)) / 86_400n;
  const projected = factor - multiply(factor, decay);
  return projected < MIN_NORM_FACTOR ? MIN_NORM_FACTOR : projected;
}

export function priceAtNormFactor(
  tickPrice: string | number,
  tickNormFactor: string | number,
  projectedNormFactor: bigint,
): bigint {
  const norm = fixed(tickNormFactor);
  if (norm === 0n) return fixed(tickPrice);
  return (fixed(tickPrice) * projectedNormFactor) / norm;
}

export function changePercent(current: bigint, previous: bigint): number {
  if (previous <= 0n) return 0;
  return ratioPercent(current - previous, previous);
}

