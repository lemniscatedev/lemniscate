// Early-writer $LMNS rewards: the ONE config the API, the payout export and (through web/dist/writer-rewards.json, which
// a test keeps equal) the website read. See writer-rewards.json `_notes` for what each value means.
import { getAddress, isAddress } from "viem";
import { z } from "zod";
import source from "./writer-rewards.json";

const address = z.string().refine((value) => isAddress(value, { strict: false }), "Invalid EVM address");
const emptyOr = <T extends z.ZodType>(schema: T) => z.union([z.literal(""), schema]);

export const writerRewardsSchema = z.object({
  _notes: z.array(z.string()).optional(),
  enabled: z.boolean(),
  tokenSymbol: z.string().regex(/^[A-Z][A-Z0-9]{1,10}$/),
  tokenAddress: emptyOr(address),
  tokenDecimals: z.number().int().min(0).max(36),
  /** Whole tokens, as a decimal integer string. */
  tokenTotalSupply: z.string().regex(/^[1-9]\d{0,30}$/),
  /** The weekly pool as basis points of the total supply (10 = 0.1%). */
  weeklyPoolBpsOfSupply: z.number().int().min(1).max(10_000),
  weeks: z.number().int().min(1).max(520),
  startAt: emptyOr(z.string().datetime({ offset: false })),
  perWalletCapBps: z.number().int().min(1).max(10_000),
  minTimeWeightedUsdg: z.number().min(0),
  redistributeOverCap: z.boolean(),
  excludeContractWallets: z.boolean(),
  projectWallets: z.record(z.string(), address),
  EXCLUDED_WALLETS: z.array(address),
}).strict().superRefine((value, context) => {
  if (value.tokenAddress && !value.startAt) {
    context.addIssue({ code: "custom", message: "startAt is required once tokenAddress is set", path: ["startAt"] });
  }
});

export type WriterRewardsConfig = z.infer<typeof writerRewardsSchema>;

export const WEEK_SECONDS = 7 * 86_400;

export const writerRewards: WriterRewardsConfig = writerRewardsSchema.parse(source);

/** The weekly pool in the token's base units: totalSupply x 10^decimals x bps / 10,000 (exact). */
export function weeklyPoolUnits(config: WriterRewardsConfig = writerRewards): bigint {
  return BigInt(config.tokenTotalSupply) * 10n ** BigInt(config.tokenDecimals) * BigInt(config.weeklyPoolBpsOfSupply) / 10_000n;
}

/** Whole tokens for display (the pool is a whole number of tokens at the defaults). */
export function unitsText(units: bigint, decimals: number): string {
  const base = 10n ** BigInt(decimals);
  const whole = units / base;
  const frac = units % base;
  if (frac === 0n) return whole.toString();
  return `${whole}.${frac.toString().padStart(decimals, "0").replace(/0+$/, "")}`;
}

export type ProgramStatus = "off" | "awaiting_token" | "scheduled" | "active" | "ended";

export function programStatus(nowMs: number, config: WriterRewardsConfig = writerRewards): ProgramStatus {
  if (!config.enabled) return "off";
  if (!config.tokenAddress || !config.startAt) return "awaiting_token";
  const start = Date.parse(config.startAt);
  if (nowMs < start) return "scheduled";
  if (nowMs >= start + config.weeks * WEEK_SECONDS * 1_000) return "ended";
  return "active";
}

/** [start, end) of reward week `n` (1-based), unix ms; null before the token launches or outside the program. */
export function weekBounds(n: number, config: WriterRewardsConfig = writerRewards): { startMs: number; endMs: number } | null {
  if (!config.startAt || !Number.isInteger(n) || n < 1 || n > config.weeks) return null;
  const startMs = Date.parse(config.startAt) + (n - 1) * WEEK_SECONDS * 1_000;
  return { startMs, endMs: startMs + WEEK_SECONDS * 1_000 };
}

/** The week that contains `nowMs` (clamped to the program: the last week once it has ended), or null before week 1. */
export function currentWeek(nowMs: number, config: WriterRewardsConfig = writerRewards): number | null {
  if (!config.startAt) return null;
  const elapsed = nowMs - Date.parse(config.startAt);
  if (elapsed < 0) return null;
  return Math.min(config.weeks, Math.floor(elapsed / (WEEK_SECONDS * 1_000)) + 1);
}

/** Wallets that never receive rewards, lower case, with the reason: project wallets, EXCLUDED_WALLETS, the zero address
 * and every Lemniscate contract in the deployment file. Contract wallets in general are found by the payout export
 * (eth_getCode), which the API cannot do (it reads Postgres only). */
export function excludedWallets(contracts: Readonly<Record<string, string | undefined>>, config: WriterRewardsConfig = writerRewards): Map<string, string> {
  const out = new Map<string, string>();
  out.set("0x0000000000000000000000000000000000000000", "zero address");
  for (const [name, value] of Object.entries(contracts)) {
    if (value && isAddress(value, { strict: false })) out.set(value.toLowerCase(), `Lemniscate contract (${name})`);
  }
  for (const [role, value] of Object.entries(config.projectWallets)) out.set(value.toLowerCase(), `project wallet (${role})`);
  for (const value of config.EXCLUDED_WALLETS) out.set(value.toLowerCase(), "excluded by the owner");
  return out;
}

export const checksum = (value: string): string => getAddress(value);
