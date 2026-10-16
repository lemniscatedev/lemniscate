import { formatUnits, parseUnits } from "viem";

export const WAD = 10n ** 18n;

export function toDecimalString(value: bigint, decimals: number): string {
  return formatUnits(value, decimals);
}

export function fromDecimalString(value: string, decimals: number): bigint {
  return parseUnits(value, decimals);
}

export function wadMul(left: bigint, right: bigint): bigint {
  return (left * right) / WAD;
}

export function wadDiv(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) throw new RangeError("Cannot divide by zero");
  return (numerator * WAD) / denominator;
}

export function toHumanUsd6(value: bigint): string {
  return toDecimalString(value, 6);
}

export function toHumanPower18(value: bigint): string {
  return toDecimalString(value, 18);
}

export function toHumanWriterPool12(value: bigint): string {
  return toDecimalString(value, 12);
}
