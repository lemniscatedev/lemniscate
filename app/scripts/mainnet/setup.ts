// Called by up.sh (and runnable alone) AFTER the mainnet deploy: checks the chain is 4663, that the contracts in
// app/deployments/4663.json have code, that OWNER accepted every two-step ownership the deployment lists, reports the
// bot wallets' ETH, prepares the lemniscate_mainnet database and writes one env file per service (no keys in them).
// It never deploys and never sends a transaction. The deployment package itself (todo 25) finishes the hand-over checks.
//
//   bun scripts/mainnet/setup.ts [--check-only]
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";
import { createPublicClient, getAddress, http, parseAbi, type Address } from "viem";
import { parseOptionDeployment, type OptionDeployment } from "@/chain/deployment";
import {
  ADDRESSES_FILE, APP, assertMainnet, assertNoRawKeys, DB_NAME, ensureDirs, envFileText, fmtEth, log, MAINNET_CHAIN_ID, MAINNET_DIR, PATHS, PORTS, REQUIRED_ROLES, roleEnv, RPC, SERVICE_KEYS,
} from "./lib";

const ownedAbi = parseAbi(["function owner() view returns (address)", "function pendingOwner() view returns (address)"]);
/** Below this a bot is reported as unfunded (fund before starting the services). */
export const BOT_FLOOR_WEI = 100_000_000_000_000n; // 0.0001 ETH

/** Two-step ownerships OWNER has not accepted yet (empty = handed over). */
export async function pendingAccepts(owner: Address, list: Address[], read: (a: Address, fn: "owner" | "pendingOwner") => Promise<Address>): Promise<Address[]> {
  const out: Address[] = [];
  for (const a of list) if (getAddress(await read(a, "owner")) !== getAddress(owner)) out.push(getAddress(a));
  return out;
}

/** The deployment fields setup reads beyond the typed schema (todo 25 writes them). */
export type DeploymentExtras = { owner?: string; acceptOwnership?: string[]; contracts?: { hedgeAdapter?: string } };

/** The typed schema drops fields it does not know; keep the ones setup needs from the raw file. */
export function withExtras(parsed: OptionDeployment, raw: unknown): OptionDeployment & DeploymentExtras {
  const r = (raw ?? {}) as { owner?: unknown; acceptOwnership?: unknown; contracts?: { hedgeAdapter?: unknown } };
  const adapter = r.contracts?.hedgeAdapter;
  const out: OptionDeployment & DeploymentExtras = { ...parsed, contracts: { ...parsed.contracts, ...(typeof adapter === "string" ? { hedgeAdapter: adapter } : {}) } };
  if (typeof r.owner === "string") out.owner = r.owner;
  if (Array.isArray(r.acceptOwnership)) out.acceptOwnership = r.acceptOwnership.filter((a): a is string => typeof a === "string");
  return out;
}

/**
 * One env file per service. Mainnet only; no key of any kind, only the paths of each role's keystore and password file. The hedger is in
 * dry run and the vol engine does not send until someone changes those two lines on purpose.
 */
export function envFiles(dep: OptionDeployment & DeploymentExtras, db: string, opts: { corsOrigins?: string; deploymentFile?: string; keysDir?: string; keyExists?: (path: string) => boolean } = {}): Record<string, Record<string, string | number>> {
  if (dep.chainId !== MAINNET_CHAIN_ID || dep.network !== "mainnet") throw new Error(`deployment is chain ${dep.chainId} ${dep.network}, not mainnet ${MAINNET_CHAIN_ID}`);
  const adapter = dep.contracts.hedgeAdapter;
  const shared = {
    NODE_ENV: "production",
    NETWORK: "mainnet",
    CHAIN_ID: MAINNET_CHAIN_ID,
    DATABASE_URL: db,
    POSTGRES_PASSWORD: "unused-see-database-url",
    PUBLIC_RPC_URL: RPC,
    DEPLOYMENT_FILE: opts.deploymentFile ?? PATHS.deployment,
    LOG_LEVEL: "info",
  };
  const files: Record<string, Record<string, string | number>> = {
    indexer: { ...shared },
    api: { ...shared, API_PORT: PORTS.api, CORS_ORIGINS: opts.corsOrigins ?? "http://localhost:7200" },
    keeper: { ...shared, KEEPER_DRY_RUN: 0 },
    hedger: { ...shared, HEDGER_DRY_RUN: 1, ...(adapter ? { HEDGER_ADAPTER_ADDRESS: adapter } : {}) },
    "vol-engine": {
      ...shared,
      VOL_SEND: 0,
      VOL_ORACLE_ADDRESS: dep.contracts.volOracle,
      VOL_CHAIN_ID: MAINNET_CHAIN_ID,
      VOL_RPC_URL: RPC,
      VOL_MOVES_FILE: join(APP, "config", "vol-moves.json"),
      VOL_WEEKEND_FILE: join(APP, "config", "vol-weekend.json"),
      VOL_INTERVAL_SECONDS: 300,
    },
  };
  // Each service learns where its own role's keystore is; the two optional roles (the api's) only when the file is there.
  const keysDir = opts.keysDir ?? PATHS.keys;
  const exists = opts.keyExists ?? existsSync;
  for (const [service, roles] of Object.entries(SERVICE_KEYS)) {
    const vars = files[service];
    if (!vars) continue;
    for (const role of roles) {
      if (!(REQUIRED_ROLES as readonly string[]).includes(role) && !exists(join(keysDir, `${role}.json`))) continue;
      Object.assign(vars, roleEnv(role, keysDir));
    }
  }
  for (const [name, vars] of Object.entries(files)) assertNoRawKeys(vars, `${name}.env`);
  return files;
}

/** Creates the database on the server behind `adminUrl` when it is missing. Returns true when it was created. */
async function createDatabaseIfMissing(adminUrl: string, name: string): Promise<boolean> {
  const sql = postgres(adminUrl, { max: 1 });
  try {
    const rows = await sql`select 1 from pg_database where datname = ${name}`;
    if (rows.length) return false;
    await sql.unsafe(`create database "${name.replace(/"/g, "")}"`);
    return true;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function main() {
  const checkOnly = process.argv.includes("--check-only");
  ensureDirs();
  await assertMainnet();
  if (!existsSync(PATHS.deployment)) throw new Error(`no ${PATHS.deployment}: the deploy package (todo 25) writes it after the mainnet deploy`);
  const raw = JSON.parse(readFileSync(PATHS.deployment, "utf8")) as unknown;
  const dep = withExtras(parseOptionDeployment(raw, PATHS.deployment), raw);
  if (dep.network !== "mainnet" || dep.forkProof) throw new Error("deployment file comes from a fork run, not the mainnet deploy");
  const p = createPublicClient({ transport: http(RPC, { timeout: 60_000, retryCount: 6, retryDelay: 750 }) });
  if ((await p.getChainId()) !== MAINNET_CHAIN_ID) throw new Error("RPC is not chain 4663");
  for (const [name, address] of Object.entries(dep.contracts)) {
    if (typeof address !== "string") continue;
    const code = await p.getCode({ address: getAddress(address) });
    if (!code || code === "0x") throw new Error(`${name} ${address} has no code on 4663: wrong deployment file`);
  }
  log(`all ${Object.keys(dep.contracts).length} contracts have code on 4663`);
  if (dep.owner && dep.acceptOwnership?.length) {
    const left = await pendingAccepts(getAddress(dep.owner), dep.acceptOwnership.map((a) => getAddress(a)), (a, fn) => p.readContract({ address: a, abi: ownedAbi, functionName: fn }) as Promise<Address>);
    if (left.length) throw new Error(`OWNER ${dep.owner} has not accepted ownership of ${left.length} contract(s) yet: call acceptOwnership() from OWNER on ${left.join(", ")}`);
    log("OWNER holds every two-step ownership");
  } else {
    log("deployment lists no owner / acceptOwnership: ownership not checked (the deploy package fills these in)");
  }
  if (existsSync(ADDRESSES_FILE)) {
    const roles = JSON.parse(readFileSync(ADDRESSES_FILE, "utf8")) as Record<string, string>;
    for (const role of ["keeper", "hedger", "vol-signer", "paymaster-signer"]) {
      const a = roles[role];
      if (!a) continue;
      const bal = await p.getBalance({ address: getAddress(a) });
      log(`${role.padEnd(17)} ${a} ${fmtEth(bal)} ETH${bal < BOT_FLOOR_WEI ? "  <- UNFUNDED (fund-bots.sh)" : ""}`);
    }
  }
  if (checkOnly) return;
  const admin = process.env.DATABASE_ADMIN_URL || `postgres://${process.env.USER ?? "postgres"}@127.0.0.1:5432/postgres`;
  if (await createDatabaseIfMissing(admin, DB_NAME)) log(`created database ${DB_NAME} (needs the timescaledb extension: see server/README.md)`);
  const db = new URL(admin);
  db.pathname = `/${DB_NAME}`;
  const files = envFiles(dep, db.toString());
  for (const [name, vars] of Object.entries(files)) writeFileSync(join(PATHS.env, `${name}.env`), envFileText(vars), { mode: 0o600 });
  log(`env files in ${PATHS.env} (dir ${MAINNET_DIR}); migrations run when up.sh starts the stack`);
}

if (import.meta.main) {
  try {
    await main();
    process.exit(0);
  } catch (e) {
    console.error(`[mainnet setup] ${(e as Error).stack ?? e}`);
    process.exit(1);
  }
}
