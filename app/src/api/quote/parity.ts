// Quote parity harness (todo 15 R2, re-run on anvil by todo 23). It compares the API's quote with the engine's own
// `quote(id, units, isBuy)` field by field. The chain side is injected as a function, so this module needs no RPC
// client: the unit test passes an independent integer-math mock, and todo 23 passes a function that calls
// `IOptionEngine.quote` on an anvil deployment (viem `readContract` with OptionEngineAbi, mapping the returned struct
// through `fromEngineStruct`).
import type { EngineQuote, SessionName } from "./model";

export interface RawEngineQuote {
  readonly usdg: bigint;
  readonly vMarkWad: bigint;
  readonly spreadBps: bigint;
  readonly feeUsdg: bigint;
  readonly dailyCostUsdg: bigint;
  readonly breakevenWad: bigint;
  readonly sigmaBps: bigint;
  readonly session: number;
  readonly buyable: boolean;
}

export type ChainQuoter = (input: { id: string; unitsWad: bigint; isBuy: boolean }) => Promise<RawEngineQuote>;

const SESSION_INDEX: Record<SessionName, number> = { REGULAR: 0, EXTENDED: 1, CLOSED: 2, UNKNOWN: 3, HALTED: 4 };

export function toRaw(quote: EngineQuote): RawEngineQuote {
  return {
    usdg: quote.usdg, vMarkWad: quote.vMarkWad, spreadBps: BigInt(quote.spreadBps), feeUsdg: quote.feeUsdg,
    dailyCostUsdg: quote.dailyCostUsdg, breakevenWad: quote.breakevenWad, sigmaBps: BigInt(quote.sigmaBps),
    session: SESSION_INDEX[quote.session], buyable: quote.buyable,
  };
}

/** Map the struct viem returns for `IOptionEngine.quote` to the raw shape. */
export function fromEngineStruct(value: {
  usdg: bigint; vMarkWad: bigint; spreadBps: bigint; feeUsdg: bigint; dailyCostUsdg: bigint; breakevenWad: bigint;
  sigmaBps: bigint; session: number; buyable: boolean;
}): RawEngineQuote {
  return { ...value };
}

export interface ParityOptions {
  /** Relative tolerance on money fields (0.005 = 0.5%). */
  readonly relative?: number;
  /** Absolute slack in the last digit, so one-micro-USDG rounding never fails a tiny quote. */
  readonly absoluteMicro?: bigint;
}

const abs = (value: bigint): bigint => (value < 0n ? -value : value);

function close(api: bigint, chain: bigint, relative: number, slack: bigint): boolean {
  const diff = abs(api - chain);
  if (diff <= slack) return true;
  const base = abs(chain) > abs(api) ? abs(chain) : abs(api);
  return Number(diff) / Number(base) <= relative;
}

/** The fields that differ by more than the tolerance; an empty list means parity. */
export function parityFailures(api: RawEngineQuote, chain: RawEngineQuote, options: ParityOptions = {}): string[] {
  const relative = options.relative ?? 0.005;
  const micro = options.absoluteMicro ?? 2n;
  const failures: string[] = [];
  const money: [keyof RawEngineQuote, bigint][] = [["usdg", micro], ["feeUsdg", micro], ["dailyCostUsdg", micro]];
  for (const [key, slack] of money) {
    if (!close(api[key] as bigint, chain[key] as bigint, relative, slack)) failures.push(`${key}: api ${api[key]} chain ${chain[key]}`);
  }
  // WAD fields: slack of 1e9 wei (1e-9 of a dollar).
  for (const key of ["vMarkWad", "breakevenWad"] as const) {
    if (!close(api[key], chain[key], relative, 1_000_000_000n)) failures.push(`${key}: api ${api[key]} chain ${chain[key]}`);
  }
  if (!close(api.spreadBps, chain.spreadBps, relative, 1n)) failures.push(`spreadBps: api ${api.spreadBps} chain ${chain.spreadBps}`);
  if (api.sigmaBps !== chain.sigmaBps) failures.push(`sigmaBps: api ${api.sigmaBps} chain ${chain.sigmaBps}`);
  if (api.session !== chain.session) failures.push(`session: api ${api.session} chain ${chain.session}`);
  if (api.buyable !== chain.buyable) failures.push(`buyable: api ${api.buyable} chain ${chain.buyable}`);
  return failures;
}
