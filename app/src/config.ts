import { z } from "zod";
import { KEY_ROLES, KeyConfigError, keyVariables, resolveAddress, resolveKey } from "./keys";

const routeSchema = z
  .string()
  .default("public,alchemy")
  .transform((value) => value.split(",").map((item) => item.trim().toLowerCase()))
  .pipe(z.array(z.enum(["public", "alchemy"])).min(1));

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  // testnet (46630) behaves like mainnet (wall clock, 20 confirmations, 10-minute snapshots); only "fork" uses the chain clock.
  NETWORK: z.enum(["mainnet", "fork", "testnet"]).default("fork"),
  CHAIN_ID: z.coerce.number().int().positive().default(4663),
  DATABASE_URL: z.string().url(),
  POSTGRES_PASSWORD: z.string().min(1),
  ALPHAVANTAGE_API_KEY: z.string().default(""),
  ALCHEMY_API_KEYS: z.string().default(""),
  ALCHEMY_URL_TEMPLATE: z
    .string()
    .default("https://robinhood-mainnet.g.alchemy.com/v2/{key}"),
  PUBLIC_RPC_URL: z.string().url().default("https://rpc.mainnet.chain.robinhood.com"),
  RPC_URL_OVERRIDE: z.string().default(""),
  RPC_ROUTE_LOGS: routeSchema,
  RPC_ROUTE_STATE: routeSchema,
  RPC_ROUTE_TX: z
    .string()
    .default("alchemy,public")
    .transform((value) => value.split(",").map((item) => item.trim().toLowerCase()))
    .pipe(z.array(z.enum(["public", "alchemy"])).min(1)),
  INDEXER_POLL_ACTIVE_MS: z.coerce.number().int().positive().default(5000),
  INDEXER_POLL_BASE_MS: z.coerce.number().int().positive().default(15000),
  INDEXER_POLL_IDLE_MS: z.coerce.number().int().positive().default(60000),
  // Longest gap between indexer snapshots (ticks), ms. Unset: 10 minutes on mainnet, 60 s on the fork profile, so a warped fork
  // clock does not leave the vol-engine's 25-minute tick-age limit waiting for the next snapshot. Capped at 10 minutes.
  INDEXER_SNAPSHOT_HEARTBEAT_MS: z.coerce.number().int().min(5000).max(600_000).optional(),
  DEPLOYMENT_FILE: z.string().min(1).default("/app/deployments/fork.json"),
  // hedge (todo 14) is opt-in until the hedger lands. receipts and lister are new in todo 13.
  KEEPER_ENABLED_JOBS: z.string().default("sessions,lister,accrue,risk,corp-actions,receipts,reference,earnings,queued-sells,fee-distribute,settle-halted,staking-sync,kernel-register"),
  KEEPER_DRY_RUN: z.enum(["0", "1"]).default("0").transform((value) => value === "1"),
  // Accrue a series once its last accrual is this old and somebody holds it. Spec: at least hourly, so 3600 is the cap.
  KEEPER_ACCRUE_MAX_AGE_SECONDS: z.coerce.number().int().min(300).max(3600).default(3600),
  // F28: a series whose outstanding value (supply x norm x v_mark) is below this many USDG is "dust", like a series the engine retired
  // (R07). Dust is accrued in one dust pass (every dust series together, through accrueMany) once the oldest is
  // KEEPER_ACCRUE_DUST_MAX_AGE_SECONDS old: hourly by default (decision 57: the pass bounds the dust tier's NAV envelope and how long a
  // retired series that regained value waits to be re-listed); up to a week to save gas (ceil(N / batch) transactions per pass).
  KEEPER_ACCRUE_DUST_USDG: z.coerce.number().min(0).default(1),
  KEEPER_ACCRUE_DUST_MAX_AGE_SECONDS: z.coerce.number().int().min(3600).max(7 * 86_400).default(3_600),
  // F29/F36: queued sells worth less than this (USDG) are filled last, at most one per pass; an open ticket older than the alert age
  // (minutes) is logged as a warning every pass.
  KEEPER_QUEUED_DUST_USDG: z.coerce.number().min(0).default(0.01),
  KEEPER_QUEUED_ALERT_MINUTES: z.coerce.number().int().min(1).default(60),
  // Norm (WAD) under which the lister opens the next epoch of a strike. Must match the registry's threshold (default 1e15 = 0.001);
  // set it when the contracts move the norm floor (F06) so the keeper relists before funding stops.
  KEEPER_RELIST_NORM_WAD: z.string().regex(/^\d+$/).default("1000000000000000"),
  // Series per engine.accrueMany transaction (a failing batch is split in half and retried). At most 45 (about half a block, decision 32).
  // 28-merge: transaction gas limit = max(estimate x MULTIPLIER_BPS / 10,000, estimate + HEADROOM), capped at CAP (never below
  // estimate x 1.2): an estimate taken right after a time jump can be under the real cost in the next block. Unused gas is refunded.
  KEEPER_GAS_MULTIPLIER_BPS: z.coerce.number().int().min(12_000).max(40_000).default(15_000),
  KEEPER_GAS_HEADROOM: z.coerce.number().int().min(0).max(5_000_000).default(500_000),
  KEEPER_GAS_CAP: z.coerce.number().int().min(1_000_000).max(64_000_000).default(32_000_000),
  // R17 (decision 62): LemniscatePaymaster, for the keeper's kernel-register job (the same variable the API's sponsorship uses).
  PAYMASTER_ADDRESS: z.preprocess((value) => (value === "" ? undefined : value), z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional()),
  KEEPER_ACCRUE_BATCH: z.coerce.number().int().min(1).max(45).default(40),
  // R13 + R3-01 (decision 67): the 5-minute funding grid takes every live-tier series of a name in session (whole names, largest first),
  // at most MAX_SERIES per slot; a name that does not fit whole keeps only its non-archived series worth MIN_VALUE or more (an ALERT).
  KEEPER_ACCRUE_GRID_MIN_VALUE_USDG: z.coerce.number().min(0).default(100),
  KEEPER_ACCRUE_GRID_MAX_SERIES: z.coerce.number().int().min(0).max(5000).default(450),
  // USDG (whole) the buy-burn job offers LmnsBuyBurn.buyAndBurn per call (the contract also caps it, decision 43).
  KEEPER_BUY_BURN_MAX_USDG: z.coerce.number().min(1).max(1_000_000).default(1_000),
  // The lister sends at most this many listing/archive transactions per run; the rest follows on the next run.
  KEEPER_LISTER_MAX_TX: z.coerce.number().int().min(1).max(500).default(60),
  // Minimum time between two automatic pauses for the same reason (the monitor never unpauses).
  KEEPER_RISK_COOLDOWN_SECONDS: z.coerce.number().int().min(60).default(3600),
  // Hedger (todo 14). Dry run is the default: the hedger simulates and reports, and never trades, until HEDGER_DRY_RUN=0.
  HEDGER_DRY_RUN: z.enum(["0", "1"]).default("1").transform((value) => value === "1"),
  HEDGER_BAND_BPS: z.coerce.number().int().min(1).max(10_000).default(50),
  HEDGER_INTERVAL_SECONDS: z.coerce.number().int().min(60).default(1800),
  HEDGER_COOLDOWN_SECONDS: z.coerce.number().int().min(0).default(120),
  HEDGER_MIN_TRADE_USDG: z.coerce.number().min(0).default(25),
  HEDGER_MAX_SLIPPAGE_BPS: z.coerce.number().int().min(1).max(1000).default(100),
  HEDGER_TWAP_SECONDS: z.coerce.number().int().min(60).default(1800),
  // Each spot trade is capped at this share of the USDG needed to move the pool about 1%.
  HEDGER_MAX_LIQUIDITY_BPS: z.coerce.number().int().min(1).max(10_000).default(2500),
  HEDGER_EQUITY_INTERVAL_SECONDS: z.coerce.number().int().min(60).default(3600),
  HEDGER_CYCLE_SECONDS: z.coerce.number().int().min(10).default(60),
  // Unused since todo 14b/23 (the hedger calls pool.rebalance; the pool holds its own adapter). Kept so old env files parse.
  HEDGER_ADAPTER_ADDRESS: z.string().regex(/^(0x[0-9a-fA-F]{40})?$/).default(""),
  HEDGER_PERP_ENABLED: z.enum(["0", "1"]).default("0").transform((value) => value === "1"),
  ARCUS_API_URL: z.string().url().default("https://api.arcus.xyz"),
  ARCUS_API_KEY_ID: z.string().default(""),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(3101),
  CORS_ORIGINS: z.string().default(""),
  // Per-client-IP requests per minute on the public API (0 disables).
  API_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(0).default(300),
  // Header holding the real client IP set by the fronting proxy.
  API_CLIENT_IP_HEADER: z.string().default("cf-connecting-ip").transform((value) => value.trim().toLowerCase()),
  // Closed beta (todo 33): "1" = a wallet needs a redeemed invite code before the API builds buy or shield intents. Sells are never gated.
  // The app_settings row `invites_required` (set by scripts/invites/switch.ts) overrides this at runtime, no restart needed.
  INVITES_REQUIRED: z.enum(["0", "1"]).default("0").transform((value) => value === "1"),
  // Gas sponsorship policy (F25/F31). The API signs paymaster data only for an account that passed the invite gate (when on)
  // and has a real trade, within these per-UTC-day quotas. Keep the globals well below the paymaster's own globalDailyCap, and
  // keep the exit group separate so a flood of buys can never use up the budget that lets holders sell. Exits are never refused
  // for a quota without a way out: the plain transaction and an unsponsored operation always work.
  SPONSOR_MIN_NOTIONAL_USDG: z.coerce.number().min(0).default(5),
  SPONSOR_MIN_SELL_USDG: z.coerce.number().min(0).default(1),
  SPONSOR_ENTRY_PER_ACCOUNT_DAILY: z.coerce.number().int().min(0).default(10),
  SPONSOR_ENTRY_PER_OWNER_DAILY: z.coerce.number().int().min(0).default(10),
  SPONSOR_ENTRY_PER_IP_DAILY: z.coerce.number().int().min(0).default(30),
  SPONSOR_ENTRY_GLOBAL_DAILY: z.coerce.number().int().min(0).default(1500),
  SPONSOR_EXIT_PER_ACCOUNT_DAILY: z.coerce.number().int().min(0).default(20),
  SPONSOR_EXIT_PER_OWNER_DAILY: z.coerce.number().int().min(0).default(20),
  SPONSOR_EXIT_PER_IP_DAILY: z.coerce.number().int().min(0).default(60),
  SPONSOR_EXIT_GLOBAL_DAILY: z.coerce.number().int().min(0).default(1000),
  // Round-3 skeptic L4: the paymaster's on-chain globalDailyCap (wei). When set, the API warns at startup if the sponsored totals x
  // PAYMASTER_MAX_COST_PER_OP_WEI could exceed it. Empty: no check.
  PAYMASTER_GLOBAL_DAILY_CAP_WEI: z.preprocess((value) => (value === "" ? undefined : value), z.string().regex(/^\d+$/).optional()),
  // Chain reads the account-abstraction routes may make per second in total (F32); beyond it they answer 503.
  AA_RPC_CALLS_PER_SECOND: z.coerce.number().min(1).default(5),
  // R12: the part of that budget one client (IPv4 or IPv6 /64) may use, reads per second; 40 % of the total is kept for sells by holders (R3-06).
  AA_RPC_CLIENT_CALLS_PER_SECOND: z.coerce.number().min(0.1).default(1),
  // R12: ?format=userop builds per client per minute (the plain intent keeps its own, higher limit).
  API_USEROP_BUILD_PER_MINUTE: z.coerce.number().int().min(1).default(30),
  // Dedicated node for those reads (empty = RPC_URL_OVERRIDE, then the public RPC). Keep it apart from the keeper's.
  AA_RPC_URL: z.string().default(""),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
});

type ParsedConfig = z.infer<typeof envSchema>;

export type RuntimeConfig = Omit<ParsedConfig, "ALCHEMY_API_KEYS" | "CORS_ORIGINS"> & {
  readonly ALCHEMY_API_KEYS: readonly string[];
  readonly CORS_ORIGINS: readonly string[];
};

// The local fork mines empty blocks every 3s and transactions immediately.
// Two local blocks give ~6s confirmation latency; real RHC retains 20 blocks.
export function confirmationBlocks(config: Pick<RuntimeConfig, "NETWORK">): number {
  return config.NETWORK === "fork" ? 2 : 20;
}

/** Snapshot heartbeat of the indexer: the override, else 60 s on the fork profile and 10 minutes (the production value the
 * vol-engine's 25-minute tick-age limit is sized for) elsewhere. */
export function snapshotHeartbeatMs(config: Pick<RuntimeConfig, "NETWORK" | "INDEXER_SNAPSHOT_HEARTBEAT_MS">): number {
  return config.INDEXER_SNAPSHOT_HEARTBEAT_MS ?? (config.NETWORK === "fork" ? 60_000 : 600_000);
}

export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigurationError";
  }
}

export function loadConfig(source: Record<string, string | undefined> = process.env): RuntimeConfig {
  const result = envSchema.safeParse(source);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join(".") || "environment"}: ${issue.message}`)
      .join("; ");
    throw new ConfigurationError(`Invalid service configuration: ${details}`);
  }

  if (!result.data.ALCHEMY_URL_TEMPLATE.includes("{key}")) {
    throw new ConfigurationError("ALCHEMY_URL_TEMPLATE must include the {key} placeholder");
  }

  return Object.freeze({
    ...result.data,
    ALCHEMY_API_KEYS: Object.freeze(
      result.data.ALCHEMY_API_KEYS.split(",").map((key) => key.trim()).filter(Boolean),
    ),
    CORS_ORIGINS: Object.freeze(
      result.data.CORS_ORIGINS.split(",").map((origin) => origin.trim()).filter(Boolean),
    ),
  });
}

/** Runs a key lookup and reports a KeyConfigError as a ConfigurationError (a key or password never appears in it). */
function keyConfig<T>(fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    if (error instanceof KeyConfigError) throw new ConfigurationError(`Invalid service configuration: ${error.message}`);
    throw error;
  }
}

/** The keeper signing key is deliberately not part of the shared schema: only the keeper entry point reads it, so other
 * services never load a signer even when they share an env file. KEEPER_PRIVATE_KEY (development) or
 * KEEPER_KEYSTORE + KEEPER_KEYSTORE_PASSWORD_FILE; NODE_ENV=production accepts the keystore form only. */
export function loadKeeperSigningKey(source: Record<string, string | undefined> = process.env): `0x${string}` | undefined {
  return keyConfig(() => {
    const key = resolveKey(KEY_ROLES.keeper, source);
    if (!key) return undefined;
    assertKeysSeparated(source);
    return key;
  });
}

/** The roles that must never share a key: the keeper (sessions, listing, accrual, pauses), the hedger (trades the
 * pool's delta) and the vol signer (signs the sigma posts). One leaked key must not carry more than one role.
 * VOL_SENDER pays gas for the vol posts; it may equal the vol signer (its default) but not the keeper or hedger. */
const SEPARATED_KEYS = [KEY_ROLES.keeper, KEY_ROLES.hedger, KEY_ROLES.volSigner, KEY_ROLES.volSender] as const;

/** Throws ConfigurationError when two of the keeper, hedger and vol signer keys are the same key, whether each one is a
 * raw key or a keystore (compared by the address they control, so case and a 0x prefix do not hide a duplicate). Names
 * the roles, never prints a key. */
export function assertKeysSeparated(source: Record<string, string | undefined> = process.env): void {
  keyConfig(() => {
    const present = SEPARATED_KEYS.flatMap((spec) => {
      const address = resolveAddress(spec, source);
      return address ? [{ spec, address }] : [];
    });
    for (let i = 0; i < present.length; i++) {
      for (let j = i + 1; j < present.length; j++) {
        const a = present[i]!;
        const b = present[j]!;
        if (a.address !== b.address) continue;
        if (a.spec === KEY_ROLES.volSigner && b.spec === KEY_ROLES.volSender) continue;
        throw new KeyConfigError(`the ${a.spec.label} and ${b.spec.label} keys must be different keys`);
      }
    }
  });
}

/** Remove keeper-only secrets (the raw key, or the keystore and password file locations) from a non-keeper process. */
export function stripKeeperSecrets(source: Record<string, string | undefined> = process.env): void {
  for (const variable of keyVariables(KEY_ROLES.keeper)) delete source[variable];
}

export function safeConfigSummary(config: RuntimeConfig): Record<string, string | number | boolean> {
  return {
    network: config.NETWORK,
    chainId: config.CHAIN_ID,
    databaseConfigured: Boolean(config.DATABASE_URL),
    alphaVantageKeyConfigured: Boolean(config.ALPHAVANTAGE_API_KEY),
    publicRpcHost: new URL(config.PUBLIC_RPC_URL).host,
    rpcOverrideEnabled: Boolean(config.RPC_URL_OVERRIDE.trim()),
    alchemyKeyCount: config.ALCHEMY_API_KEYS.length,
    apiPort: config.API_PORT,
    logLevel: config.LOG_LEVEL,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Optional variables read outside the service schemas above. Every environment read in app/src goes through this file
// (house layout rule), so the full list of variables a process can see is here.
// ---------------------------------------------------------------------------------------------------------------

export type OptionalEnvName =
  | "ARCUS_ED25519_SEED"
  | "AA_KERNEL_IMPLEMENTATION"
  | "TEST_DATABASE_URL"
  | "PG_BIN"
  | "PATH"
  | "LOG_LEVEL"
  | "ALCHEMY_API_KEYS"
  | "DATABASE_URL"
  | "KEEPER_PRIVATE_KEY"
  | "FORK_RPC_URL"
  | "RPC_URL_OVERRIDE";

/** The trimmed value of an optional variable, or undefined when it is unset or blank. */
export function optionalEnv(name: OptionalEnvName): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

/** The exact (untrimmed) value, for log redaction that must match what a library echoes back. */
export function rawEnv(name: OptionalEnvName): string | undefined {
  return process.env[name];
}

/** Test preload only: points the database tests at a throwaway Postgres. */
export function setTestDatabaseEnv(url: string): void {
  process.env.TEST_DATABASE_URL = url;
  process.env.TEST_DATABASE_EPHEMERAL = "1";
}
