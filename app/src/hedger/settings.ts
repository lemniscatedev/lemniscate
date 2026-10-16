import postgres from "postgres";
import { privateKeyToAccount } from "viem/accounts";
import { ConfigurationError, type RuntimeConfig } from "../config";
import { KEY_ROLES, KeyConfigError, keyVariables, resolveAddress, resolveKey } from "../keys";
import type { HedgerSettings } from "./types";

export function hedgerSettings(config: RuntimeConfig): HedgerSettings {
  return {
    dryRun: config.HEDGER_DRY_RUN,
    bandBps: config.HEDGER_BAND_BPS,
    intervalSeconds: config.HEDGER_INTERVAL_SECONDS,
    cooldownSeconds: config.HEDGER_COOLDOWN_SECONDS,
    minTradeUsdg: config.HEDGER_MIN_TRADE_USDG,
    maxSlippageBps: config.HEDGER_MAX_SLIPPAGE_BPS,
    twapSeconds: config.HEDGER_TWAP_SECONDS,
    maxLiquidityBps: config.HEDGER_MAX_LIQUIDITY_BPS,
    equityIntervalSeconds: config.HEDGER_EQUITY_INTERVAL_SECONDS,
  };
}

/** The hedger signing key: HEDGER_PRIVATE_KEY (development) or HEDGER_KEYSTORE + HEDGER_KEYSTORE_PASSWORD_FILE
 * (the only form NODE_ENV=production accepts). Deliberately not part of the shared schema, like the keeper key. */
export function loadHedgerSigningKey(source: Record<string, string | undefined> = process.env): `0x${string}` | undefined {
  try {
    return resolveKey(KEY_ROLES.hedger, source);
  } catch (error) {
    if (error instanceof KeyConfigError) throw new ConfigurationError(`Invalid service configuration: ${error.message}`);
    throw error;
  }
}

/** R6: the hedger wallet must not be the keeper wallet. Throws when both are set and derive the same address. */
export function assertHedgerKeyDistinct(source: Record<string, string | undefined> = process.env): void {
  const hedger = loadHedgerSigningKey(source);
  if (!hedger) return;
  let keeper: `0x${string}` | undefined;
  try {
    keeper = resolveAddress(KEY_ROLES.keeper, source);
  } catch (error) {
    if (!(error instanceof KeyConfigError)) throw error;
    return; // the keeper reports its own configuration problems
  }
  if (keeper && privateKeyToAccount(hedger).address === keeper) {
    throw new ConfigurationError("HEDGER_PRIVATE_KEY must differ from KEEPER_PRIVATE_KEY; refusing to start");
  }
}

/** Remove hedger-only secrets from a process that must not sign hedges (the keeper). */
export function stripHedgerSecrets(source: Record<string, string | undefined> = process.env): void {
  for (const variable of keyVariables(KEY_ROLES.hedger)) delete source[variable];
  delete source.ARCUS_ED25519_SEED;
}

const LOCK_CLASS = 0x4c454d4e; // "LEMN"
const LOCK_ID = 14;

/** One hedger instance at a time (session advisory lock on a dedicated connection). Returns a release function, or
 * undefined when another instance holds the lock. */
export async function acquireHedgerLock(databaseUrl: string): Promise<(() => Promise<void>) | undefined> {
  const sql = postgres(databaseUrl, { max: 1, idle_timeout: 0, max_lifetime: 0, connect_timeout: 10 });
  const rows = await sql<{ held: boolean }[]>`select pg_try_advisory_lock(${LOCK_CLASS}::int4, ${LOCK_ID}::int4) as held`;
  if (rows[0]?.held !== true) { await sql.end({ timeout: 1 }); return undefined; }
  return async () => { await sql.end({ timeout: 1 }); };
}
