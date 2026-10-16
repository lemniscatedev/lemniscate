// Shared constants and pure helpers for the Robinhood Chain MAINNET (4663) closed beta (app/scripts/mainnet).
// Nothing here deploys or sends: the deploy is a separate package run by the launch team (or by Kal's explicit "go"),
// and the bots are funded by fund-bots.sh from a wallet the funder controls. These scripts only turn the deployment
// file into what the services read and start the services, refusing anything that is not chain 4663.
//
// Keys: encrypted keystore files named <role>.json with <role>.password beside them, in MAINNET_KEYS_DIR. The service
// env files never hold a key, only the locations of a role's keystore and password file; the service that needs the role
// decrypts it in its own process (app/src/keys.ts).
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { KEY_ROLES, type KeyRoleName } from "../../src/keys";

export const APP = join(import.meta.dir, "..", "..");
export const ROOT = join(APP, "..");

export const MAINNET_CHAIN_ID = 4663;
export const TESTNET_CHAIN_ID = 46630;
export const FORK_CHAIN_ID = 31337;
export const RPC = process.env.RHC_MAINNET_RPC_URL || "https://rpc.mainnet.chain.robinhood.com";
export const EXPLORER = "https://robinhoodchain.blockscout.com";
export const DB_NAME = process.env.MAINNET_DB_NAME || "lemniscate_mainnet";
/** Orbit NodeInterface (virtual contract): gasEstimateComponents gives the L1 data part of a transaction. */
export const NODE_INTERFACE = "0x00000000000000000000000000000000000000C8";

/** Gitignored working directory: env files, logs, pid files, local keystore copies. */
export const MAINNET_DIR = process.env.MAINNET_DIR || join(APP, ".mainnet");
export const PATHS = {
  deployments: join(APP, "deployments"),
  deployment: join(APP, "deployments", `${MAINNET_CHAIN_ID}.json`),
  env: join(MAINNET_DIR, "env"),
  logs: join(MAINNET_DIR, "logs"),
  pids: join(MAINNET_DIR, "pids"),
  keys: process.env.MAINNET_KEYS_DIR || join(MAINNET_DIR, "keys"),
};

/** Public addresses written by the wallet pack (docs repo: runbooks/mainnet-addresses.json). Optional here. */
export const ADDRESSES_FILE = process.env.MAINNET_ADDRESSES_FILE || join(homedir(), "Documents", "GitHub", "Lemniscate", "docs", "runbooks", "mainnet-addresses.json");

/** Wallet roles. The owner is a MetaMask / Safe account and never on a server; guardian-hot has no service. */
export const SERVER_ROLES = ["keeper", "hedger", "vol-signer", "paymaster-signer", "x402-settler"] as const;
export const REQUIRED_ROLES = ["keeper", "hedger", "vol-signer"] as const;
export type ServerRole = (typeof SERVER_ROLES)[number];

/** The key role (app/src/keys.ts) behind each wallet role, which fixes the variables that point at its keystore. */
export const ROLE_KEY: Record<ServerRole, KeyRoleName> = {
  keeper: "keeper",
  hedger: "hedger",
  "vol-signer": "volSigner",
  "paymaster-signer": "paymasterSigner",
  "x402-settler": "x402Settler",
};

/** The two variables a service reads to find a role's key: the keystore file and its password file (both paths, no secret). */
export function roleEnv(role: ServerRole, dir = PATHS.keys): Record<string, string> {
  const spec = KEY_ROLES[ROLE_KEY[role]];
  return { [spec.keystore]: join(dir, `${role}.json`), [spec.passwordFile]: join(dir, `${role}.password`) };
}

/** Which service gets which role (the api carries the two optional ones). */
export const SERVICE_KEYS: Record<string, readonly ServerRole[]> = {
  indexer: [],
  api: ["paymaster-signer", "x402-settler"],
  keeper: ["keeper"],
  hedger: ["hedger"],
  "vol-engine": ["vol-signer"],
  mcp: [],
};

export const keystoreFile = (role: ServerRole) => join(PATHS.keys, `${role}.json`);
export const passwordFile = (role: ServerRole) => join(PATHS.keys, `${role}.password`);

/** Service ports on the local stack and on the server (see server/README.md). */
export const PORTS = { api: 3101, mcp: 3102 } as const;

/** Variables that must never appear in a service env file: keys come from keystores. */
export const RAW_KEY_VARIABLES = ["KEEPER_PRIVATE_KEY", "HEDGER_PRIVATE_KEY", "VOL_SIGNER_KEY", "VOL_SENDER_KEY", "PAYMASTER_SIGNER_KEY", "X402_SETTLER_KEY", "AGENT_KEY"] as const;

export class WrongChainError extends Error {}

/** Throws unless `id` is Robinhood Chain mainnet. */
export function assertMainnetChainId(id: number | bigint | string, where = RPC): void {
  const n = typeof id === "string" ? Number(BigInt(id)) : Number(id);
  if (n !== MAINNET_CHAIN_ID) throw new WrongChainError(`${where} answered chain id ${n}, expected Robinhood Chain mainnet ${MAINNET_CHAIN_ID}: refusing`);
}

/** Asks the RPC directly and throws unless it is chain 4663. */
export async function assertMainnet(rpc = RPC): Promise<void> {
  const res = await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }) });
  const body = (await res.json()) as { result?: string; error?: unknown };
  if (!body.result) throw new WrongChainError(`${rpc} did not answer eth_chainId: ${JSON.stringify(body.error ?? body)}`);
  assertMainnetChainId(body.result, rpc);
}

/** Formats wei as ETH with up to `digits` decimals ("0.001234"). */
export function fmtEth(wei: bigint, digits = 6): string {
  const neg = wei < 0n;
  const v = neg ? -wei : wei;
  const s = v.toString().padStart(19, "0");
  const frac = s.slice(-18).slice(0, digits).replace(/0+$/, "");
  return `${neg ? "-" : ""}${s.slice(0, -18)}${frac ? `.${frac}` : ""}`;
}

// ---------------------------------------------------------------- cost model (unit-tested)

export type CostTx = { gasUsed: bigint; l1Gas: bigint };

/**
 * Orbit charges (L2 gas used + L1 data gas expressed in L2 gas) x the L2 base fee. The L1 part comes from
 * NodeInterface.gasEstimateComponents, already converted to L2 gas at the base fee it reports.
 */
export function txCostWei(t: CostTx, baseFee: bigint): bigint {
  return (t.gasUsed + t.l1Gas) * baseFee;
}

/** `wei` plus `marginBps` (5000 = +50%), rounded up. */
export function withMargin(wei: bigint, marginBps: bigint): bigint {
  return (wei * (10_000n + marginBps) + 9_999n) / 10_000n;
}

export type BotDay = { role: string; txs: number; l2Gas: bigint; l1Gas: bigint };

/**
 * Bot gas for `days` days: each role's gas per window measured on the fork run (`windows` = how many days of activity
 * the run covered) x `days`, never rounding a day down.
 */
export function botBudget(rows: BotDay[], windows: number, days: number, baseFee: bigint): { role: string; perDayWei: bigint; totalWei: bigint; txsPerDay: number }[] {
  if (windows <= 0) throw new Error("windows must be > 0");
  return rows.map((r) => {
    const perDayGas = (r.l2Gas + r.l1Gas + BigInt(windows) - 1n) / BigInt(windows);
    const perDayWei = perDayGas * baseFee;
    return { role: r.role, perDayWei, totalWei: perDayWei * BigInt(days), txsPerDay: r.txs / windows };
  });
}

/** KEY=value lines; empty values dropped. */
export function envFileText(vars: Record<string, string | number | undefined>): string {
  const lines = Object.entries(vars)
    .filter(([, v]) => v !== undefined && v !== "")
    .map(([k, v]) => `${k}=${v}`);
  return `${lines.join("\n")}\n`;
}

/** Throws if `vars` carries a raw key variable (a key never goes in an env file). */
export function assertNoRawKeys(vars: Record<string, unknown>, where = "env file"): void {
  for (const k of RAW_KEY_VARIABLES) {
    if (k in vars) throw new Error(`${where} must not hold ${k}: keys come from keystores (point at them with the *_KEYSTORE and *_KEYSTORE_PASSWORD_FILE variables)`);
  }
}

export function ensureDirs() {
  for (const d of [MAINNET_DIR, PATHS.env, PATHS.logs, PATHS.pids]) mkdirSync(d, { recursive: true });
  if (!existsSync(PATHS.keys)) mkdirSync(PATHS.keys, { recursive: true, mode: 0o700 });
}

export function log(m: string) {
  console.log(`[mainnet ${new Date().toISOString().slice(11, 19)}] ${m}`);
}
