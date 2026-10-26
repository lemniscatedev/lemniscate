// Writes one env file per testnet service into $TESTNET_DIR/env (mode 600). Called by up.sh after deploy.sh.
// No key of any kind goes into a file: each service gets only the PATHS of its own role's keystore and password file
// (app/src/keys.ts and vol-engine/keystore.py decrypt them in their own process). NODE_ENV=production, so the services
// refuse a raw key even if one were set.
//
//   bun scripts/testnet/setup.ts --env
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { getAddress } from "viem";
import {
  addressOf, APP, API_URL, DATABASE_URL, deploymentFile, keystorePath, KEYS_DIR, loadConfig, loadDeployment, passwordPath, PORTS, RPC,
  TESTNET_CHAIN_ID, TESTNET_DIR, type TestnetRole,
} from "./lib";

const RAW_KEY_VARIABLES = ["KEEPER_PRIVATE_KEY", "HEDGER_PRIVATE_KEY", "VOL_SIGNER_KEY", "VOL_SENDER_KEY", "PAYMASTER_SIGNER_KEY", "X402_SETTLER_KEY", "AGENT_KEY"];

/** <PREFIX>_KEYSTORE and <PREFIX>_KEYSTORE_PASSWORD_FILE for one role (paths only). */
export function keyEnv(prefix: string, role: TestnetRole, dir = KEYS_DIR): Record<string, string> {
  return { [`${prefix}_KEYSTORE`]: join(dir, `${role}.json`), [`${prefix}_KEYSTORE_PASSWORD_FILE`]: join(dir, `${role}.password`) };
}

export function envText(vars: Record<string, string | number>): string {
  return `${Object.entries(vars).map(([k, v]) => `${k}=${String(v).includes(" ") ? JSON.stringify(String(v)) : v}`).join("\n")}\n`;
}

function existingMcpToken(): string | undefined {
  const file = join(TESTNET_DIR, "env", "mcp.env");
  if (!existsSync(file)) return undefined;
  return /^MCP_HTTP_TOKEN=([0-9a-f]{32})$/m.exec(readFileSync(file, "utf8"))?.[1];
}

export function serviceEnv(): Record<string, Record<string, string | number>> {
  const dep = loadDeployment();
  const cfg = loadConfig();
  const shared = {
    NODE_ENV: "production", NETWORK: "testnet", CHAIN_ID: TESTNET_CHAIN_ID, DATABASE_URL, POSTGRES_PASSWORD: "unused-trust-auth",
    PUBLIC_RPC_URL: RPC, RPC_URL_OVERRIDE: RPC, RPC_ROUTE_TX: "public", RPC_ROUTE_STATE: "public", RPC_ROUTE_LOGS: "public",
    DEPLOYMENT_FILE: deploymentFile(), LOG_LEVEL: "info", INDEXER_POLL_ACTIVE_MS: 2000, INDEXER_POLL_BASE_MS: 5000, INDEXER_POLL_IDLE_MS: 15000,
  };
  const stocks = dep.stocks.map((s) => `${s.name}=${getAddress(s.stock)}`).join(",");
  const web = [PORTS.web, 4189].flatMap((p) => [`http://localhost:${p}`, `http://127.0.0.1:${p}`]).join(",");
  const files: Record<string, Record<string, string | number>> = {
    indexer: { ...shared },
    api: {
      ...shared, API_PORT: PORTS.api, API_RATE_LIMIT_PER_MINUTE: 1200, INVITES_REQUIRED: 0, CORS_ORIGINS: web,
      BUNDLER_URL: `http://127.0.0.1:${PORTS.bundler}`, AA_BUNDLER_TIMEOUT_MS: "30000", AA_RPC_CALLS_PER_SECOND: 20, AA_RPC_CLIENT_CALLS_PER_SECOND: 10,
    },
    keeper: { ...shared, ...keyEnv("KEEPER", "keeper"), KEEPER_DRY_RUN: 0, KEEPER_LISTER_MAX_TX: 250 },
    hedger: { ...shared, ...keyEnv("HEDGER", "hedger"), HEDGER_DRY_RUN: 0, HEDGER_CYCLE_SECONDS: 60, HEDGER_INTERVAL_SECONDS: 600, HEDGER_COOLDOWN_SECONDS: 60 },
    "vol-engine": {
      NODE_ENV: "production", DATABASE_URL, ...keyEnv("VOL_SIGNER", "vol-signer"), VOL_SEND: 1, VOL_CLOCK: "wall",
      VOL_ORACLE_ADDRESS: getAddress(dep.contracts.volOracle), VOL_CHAIN_ID: TESTNET_CHAIN_ID, VOL_RPC_URL: RPC, VOL_STOCKS: stocks,
      VOL_NAMES: dep.stocks.map((s) => s.name).join(","),
      VOL_MOVES_FILE: join(APP, "config", "vol-moves.json"), VOL_WEEKEND_FILE: join(APP, "config", "vol-weekend.json"),
    },
    mcp: {
      NODE_ENV: "production", LMNS_API_URL: API_URL, ...keyEnv("AGENT", "agent"), AGENT_OWNER: addressOf("agent-owner"), AGENT_RPC_URL: RPC,
      AGENT_CHAIN_ID: TESTNET_CHAIN_ID, ...(dep.contracts.agentRouter ? { AGENT_ROUTER: getAddress(dep.contracts.agentRouter) } : {}),
      MCP_HTTP_HOST: "127.0.0.1", MCP_HTTP_PORT: PORTS.mcp, MCP_HTTP_TOKEN: existingMcpToken() ?? randomBytes(16).toString("hex"), MCP_RATE_LIMIT_PER_MINUTE: 600,
    },
    bundler: { BUNDLER_PORT: PORTS.bundler, TESTNET_RPC_URL: RPC, TESTNET_KEYS_DIR: KEYS_DIR, TESTNET_DIR },
    "feed-mirror": {
      TESTNET_RPC_URL: RPC, TESTNET_KEYS_DIR: KEYS_DIR, TESTNET_DIR, MIRROR_SOURCE_RPC: cfg.mirror?.sourceRpc ?? "",
      MIRROR_SOURCES: Object.entries(cfg.mirror?.feeds ?? {}).map(([n, a]) => `${n}=${a}`).join(","), MIRROR_INTERVAL_SECONDS: 120,
    },
  };
  for (const [name, vars] of Object.entries(files)) {
    for (const k of RAW_KEY_VARIABLES) if (k in vars) throw new Error(`${name}.env must not hold ${k}`);
  }
  for (const role of ["keeper", "hedger", "vol-signer", "agent", "bundler", "feed-mirror"] as const) {
    if (!existsSync(keystorePath(role)) || !existsSync(passwordPath(role))) throw new Error(`missing keystore or password file for ${role} in ${KEYS_DIR}`);
  }
  return files;
}

if (import.meta.main) {
  if (process.argv.includes("--env")) {
    mkdirSync(join(TESTNET_DIR, "env"), { recursive: true });
    for (const [name, vars] of Object.entries(serviceEnv())) writeFileSync(join(TESTNET_DIR, "env", `${name}.env`), envText(vars), { mode: 0o600 });
    console.log(`setup: env files in ${join(TESTNET_DIR, "env")} (keystore paths only)`);
  }
}
