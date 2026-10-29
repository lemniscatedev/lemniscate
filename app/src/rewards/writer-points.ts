// Early-writer points and the weekly $LMNS split (zero-seed launch). A pure function of the indexed Writer Pool events,
// their block times and the config (crypto-token-utility section 4): same input, same table, same digest.
//
// Per wallet, in event order (block, log index):
//   deposit   (WriterPool Deposit)              shares += shares, basis += USDG paid
//   share out (a pool-share Transfer FROM it:   requestWithdraw escrow to the pool, or a transfer to anyone)
//             basis -= basis x moved / shares, shares -= moved (at most what it deposited)
//   share in  (a transfer TO it)                 ignored: only USDG a wallet deposited itself counts
// Points over the week = the time integral of the basis (USDG still deposited, valued at what was paid) inside the week,
// shown as USDG-days. A wallet qualifies when that averages at least `minTimeWeightedUsdg` over the whole week.
// Asking to withdraw stops the clock for those shares at once (they are leaving), even before the claim.
// Split: pool x points / all qualifying points, at most perWalletCapBps of the pool per wallet. With redistributeOverCap
// off (the default) a capped wallet's excess is not paid and stays with the owner; on, it is water-filled over the rest.
import { createHash } from "node:crypto";

export type FlowKind = "deposit" | "out";

export interface PoolFlow {
  readonly kind: FlowKind;
  /** Lower-case wallet address. */
  readonly account: string;
  readonly block: bigint;
  readonly logIndex: number;
  /** Block time, unix seconds. */
  readonly ts: number;
  /** Pool shares moved, 18-decimal fixed point (exact for the pool's 12-decimal shares). */
  readonly shares18: bigint;
  /** USDG paid, micro-USDG (6 dp). Deposits only; 0 for "out". */
  readonly assetsMicro: bigint;
}

export interface WeekInput {
  readonly flows: readonly PoolFlow[];
  readonly startSec: number;
  readonly endSec: number;
  /** Pool in token base units. */
  readonly poolUnits: bigint;
  readonly perWalletCapBps: number;
  readonly minTimeWeightedUsdg: number;
  readonly redistributeOverCap: boolean;
  /** Lower-case address -> reason. Excluded wallets are listed with 0 tokens and never take part in the split. */
  readonly excluded: ReadonlyMap<string, string>;
}

export interface WalletRow {
  readonly address: string;
  /** Integral of the basis over the week, micro-USDG x seconds. */
  readonly weightMicroSec: bigint;
  /** weight / week length, micro-USDG. */
  readonly avgMicro: bigint;
  /** Basis at the end of the window, micro-USDG. */
  readonly basisEndMicro: bigint;
  readonly eligible: boolean;
  /** Why it is not eligible ("" when eligible). */
  readonly reason: string;
  readonly units: bigint;
  /** True when the per-wallet cap cut this wallet's share. */
  readonly capped: boolean;
}

export interface WeekTable {
  readonly startSec: number;
  readonly endSec: number;
  readonly poolUnits: bigint;
  readonly capUnits: bigint;
  readonly rows: readonly WalletRow[];
  readonly eligibleWallets: number;
  readonly totalEligibleWeight: bigint;
  readonly allocatedUnits: bigint;
  readonly unallocatedUnits: bigint;
  readonly digest: string;
}

const MICRO = 1_000_000n;

export const usdgDays = (weightMicroSec: bigint): string => {
  const hundredths = weightMicroSec * 100n / (MICRO * 86_400n);
  return `${hundredths / 100n}.${(hundredths % 100n).toString().padStart(2, "0")}`;
};
export const microText = (micro: bigint): string => {
  const sign = micro < 0n ? "-" : "";
  const abs = micro < 0n ? -micro : micro;
  return `${sign}${abs / MICRO}.${(abs % MICRO).toString().padStart(6, "0")}`;
};

/** Orders flows as the chain did. */
export function sortFlows(flows: readonly PoolFlow[]): PoolFlow[] {
  return [...flows].sort((x, y) => (x.block === y.block ? x.logIndex - y.logIndex : x.block < y.block ? -1 : 1));
}

/** Per-wallet basis over time and its integral inside [startSec, endSec). */
export function walletWeights(flows: readonly PoolFlow[], startSec: number, endSec: number): Map<string, { weight: bigint; basisEnd: bigint }> {
  const state = new Map<string, { shares: bigint; basis: bigint; since: number; weight: bigint }>();
  const accrue = (s: { basis: bigint; since: number; weight: bigint }, until: number) => {
    const from = Math.max(s.since, startSec);
    const to = Math.min(until, endSec);
    if (to > from && s.basis > 0n) s.weight += s.basis * BigInt(to - from);
    s.since = Math.max(s.since, until);
  };
  for (const flow of sortFlows(flows)) {
    if (flow.ts >= endSec) continue; // the next week's (block times only grow, so nothing later counts either)
    let s = state.get(flow.account);
    if (!s) {
      s = { shares: 0n, basis: 0n, since: flow.ts, weight: 0n };
      state.set(flow.account, s);
    }
    accrue(s, flow.ts);
    if (flow.kind === "deposit") {
      s.shares += flow.shares18;
      s.basis += flow.assetsMicro;
    } else if (s.shares > 0n) {
      const moved = flow.shares18 < s.shares ? flow.shares18 : s.shares;
      s.basis -= s.basis * moved / s.shares;
      s.shares -= moved;
      if (s.shares === 0n) s.basis = 0n;
    }
  }
  const out = new Map<string, { weight: bigint; basisEnd: bigint }>();
  for (const [account, s] of state) {
    accrue(s, endSec);
    out.set(account, { weight: s.weight, basisEnd: s.basis });
  }
  return out;
}

/** Splits `pool` by weight with a per-wallet cap; integer maths, rounding down, so the sum never exceeds the pool. */
export function split(weights: ReadonlyMap<string, bigint>, pool: bigint, cap: bigint, redistribute: boolean): Map<string, { units: bigint; capped: boolean }> {
  const out = new Map<string, { units: bigint; capped: boolean }>();
  let open = [...weights].filter(([, w]) => w > 0n);
  let remaining = pool;
  for (;;) {
    const total = open.reduce((sum, [, w]) => sum + w, 0n);
    if (total === 0n || remaining <= 0n) break;
    const over = open.filter(([, w]) => remaining * w / total > cap);
    if (over.length === 0 || !redistribute) {
      for (const [account, w] of open) {
        const share = remaining * w / total;
        out.set(account, share > cap ? { units: cap, capped: true } : { units: share, capped: false });
      }
      break;
    }
    // Water-filling: pay the capped wallets their cap, then split what is left over the others.
    for (const [account] of over) {
      out.set(account, { units: cap, capped: true });
      remaining -= cap;
    }
    const capped = new Set(over.map(([account]) => account));
    open = open.filter(([account]) => !capped.has(account));
  }
  return out;
}

export function weekTable(input: WeekInput): WeekTable {
  if (!(input.endSec > input.startSec)) throw new Error("week end must be after its start");
  const length = BigInt(input.endSec - input.startSec);
  const minMicro = BigInt(Math.round(input.minTimeWeightedUsdg * 1e6));
  const weights = walletWeights(input.flows, input.startSec, input.endSec);
  const capUnits = input.poolUnits * BigInt(input.perWalletCapBps) / 10_000n;

  const draft = [...weights].map(([address, { weight, basisEnd }]) => {
    const avgMicro = weight / length;
    const excludedReason = input.excluded.get(address);
    const reason = excludedReason ? `excluded: ${excludedReason}`
      : weight === 0n ? "no deposit held during the week"
        : avgMicro < minMicro ? `time-weighted deposit under ${input.minTimeWeightedUsdg} USDG` : "";
    return { address, weightMicroSec: weight, avgMicro, basisEndMicro: basisEnd, eligible: reason === "", reason };
  });
  const eligibleWeights = new Map(draft.filter((row) => row.eligible).map((row) => [row.address, row.weightMicroSec]));
  const shares = split(eligibleWeights, input.poolUnits, capUnits, input.redistributeOverCap);
  const rows: WalletRow[] = draft
    .map((row) => ({ ...row, units: shares.get(row.address)?.units ?? 0n, capped: shares.get(row.address)?.capped ?? false }))
    .sort((x, y) => (x.weightMicroSec === y.weightMicroSec ? (x.address < y.address ? -1 : 1) : x.weightMicroSec > y.weightMicroSec ? -1 : 1));
  const allocatedUnits = rows.reduce((sum, row) => sum + row.units, 0n);
  const unallocatedUnits = input.poolUnits - allocatedUnits;
  if (unallocatedUnits < 0n || allocatedUnits + unallocatedUnits !== input.poolUnits) throw new Error("allocation exceeds the pool");
  const totalEligibleWeight = [...eligibleWeights.values()].reduce((sum, w) => sum + w, 0n);
  const digest = createHash("sha256").update(JSON.stringify({
    startSec: input.startSec, endSec: input.endSec, pool: input.poolUnits.toString(), cap: capUnits.toString(),
    min: minMicro.toString(), redistribute: input.redistributeOverCap,
    rows: rows.map((row) => [row.address, row.weightMicroSec.toString(), row.eligible, row.units.toString()]),
  })).digest("hex");
  return {
    startSec: input.startSec, endSec: input.endSec, poolUnits: input.poolUnits, capUnits, rows,
    eligibleWallets: eligibleWeights.size, totalEligibleWeight, allocatedUnits, unallocatedUnits, digest,
  };
}

/** A decimal string ("12.5", "0.000001") as a fixed-point bigint with `scale` decimals, rounded down. */
export function fixed(text: string, scale: number): bigint {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(String(text).trim());
  if (!match) throw new Error(`not a decimal: ${text}`);
  const frac = (match[3] ?? "").padEnd(scale, "0").slice(0, scale);
  const value = BigInt(match[2]!) * 10n ** BigInt(scale) + BigInt(frac || "0");
  return match[1] ? -value : value;
}
