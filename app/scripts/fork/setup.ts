// Fork stack setup, called by up.sh.
//   bun scripts/fork/setup.ts --relax   once after the deploy: the documented fork-only relaxations (below)
//   bun scripts/fork/setup.ts --env     writes one env file per service into $FORK_DIR/env (dev keys from anvil's
//                                       --config-out file; the folder is git-ignored and never leaves this machine)
//
// Fork-only relaxations (written here and in the fork report; never part of DeploySystem):
//   1. PriceGuard maxAgeRegular/maxAgeExtended = 30 days for every launch name, set by the TimelockController through
//      anvil impersonation. Reason: the fork never sees a new Chainlink print, so after any time warp the real feeds age
//      past the 26 h production limit and every name would read HALTED. Freshness flows (HALTED, stale feed) are still
//      exercised with a mock feed swapped in for one name.
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAddress, type Address } from "viem";
import { PriceGuardAbi } from "@/abi/PriceGuard";
import {
  addressOf, ANVIL_URL, API_URL, DATABASE_URL, FORK_DIR, forkClients, impersonated, keyOf, loadDeployment, PORTS,
} from "./lib";

export const FORK_MAX_AGE = 30 * 86_400;

async function relax(): Promise<void> {
  const dep = loadDeployment();
  const { pub, test } = forkClients();
  const timelock = getAddress(dep.contracts.timelock ?? "");
  const admin = await impersonated(test, timelock);
  for (const s of dep.stocks) {
    const cfg = await pub.readContract({ address: dep.contracts.priceGuard, abi: PriceGuardAbi, functionName: "config", args: [s.stock] });
    const hash = await admin.writeContract({
      address: dep.contracts.priceGuard, abi: PriceGuardAbi, functionName: "setStock", chain: null, account: timelock,
      args: [s.stock, { ...cfg, maxAgeRegular: FORK_MAX_AGE, maxAgeExtended: FORK_MAX_AGE }],
    });
    const r = await pub.waitForTransactionReceipt({ hash });
    if (r.status !== "success") throw new Error(`relax ${s.name}: ${hash} reverted`);
    console.log(`setup: fork relaxation PriceGuard maxAge 30 days for ${s.name} (${hash})`);
  }
  await test.stopImpersonatingAccount({ address: timelock });
}

export function envText(vars: Record<string, string | number>): string {
  return `${Object.entries(vars).map(([k, v]) => `${k}=${String(v).includes(" ") ? JSON.stringify(String(v)) : v}`).join("\n")}\n`;
}

export function serviceEnv(): Record<string, Record<string, string | number>> {
  const dep = loadDeployment();
  const deploymentFile = join(FORK_DIR, "deployment.json");
  const shared = {
    NODE_ENV: "development", NETWORK: "fork", CHAIN_ID: 31337, DATABASE_URL, POSTGRES_PASSWORD: "unused-trust-auth",
    PUBLIC_RPC_URL: ANVIL_URL, RPC_URL_OVERRIDE: ANVIL_URL, DEPLOYMENT_FILE: deploymentFile, LOG_LEVEL: "info",
    INDEXER_POLL_ACTIVE_MS: 1000, INDEXER_POLL_BASE_MS: 2000, INDEXER_POLL_IDLE_MS: 5000,
  };
  const stocks = dep.stocks.map((s) => `${s.name}=${s.stock}`).join(",");
  return {
    indexer: { ...shared },
    api: {
      ...shared, API_PORT: PORTS.api, API_RATE_LIMIT_PER_MINUTE: 0, INVITES_REQUIRED: 0,
      CORS_ORIGINS: [`http://localhost:${PORTS.web}`, `http://127.0.0.1:${PORTS.web}`].join(","),
      BUNDLER_URL: `http://127.0.0.1:${PORTS.bundler}`,
    },
    keeper: { ...shared, KEEPER_PRIVATE_KEY: keyOf("keeper"), KEEPER_DRY_RUN: 0, KEEPER_ACCRUE_MAX_AGE_SECONDS: 300 },
    hedger: {
      ...shared, HEDGER_PRIVATE_KEY: keyOf("hedger"), HEDGER_DRY_RUN: 0, HEDGER_CYCLE_SECONDS: 20, HEDGER_INTERVAL_SECONDS: 60,
      HEDGER_COOLDOWN_SECONDS: 0,
    },
    "vol-engine": {
      DATABASE_URL, VOL_SIGNER_KEY: keyOf("volSigner"), VOL_SEND: 1, VOL_CLOCK: "chain", VOL_ORACLE_ADDRESS: getAddress(dep.contracts.volOracle),
      VOL_CHAIN_ID: 31337, VOL_RPC_URL: ANVIL_URL, VOL_STOCKS: stocks, VOL_NAMES: dep.stocks.map((s) => s.name).join(","),
      VOL_MOVES_FILE: join(import.meta.dir, "../../config/vol-moves.json"), VOL_WEEKEND_FILE: join(import.meta.dir, "../../config/vol-weekend.json"),
    },
    mcp: {
      LMNS_API_URL: API_URL, AGENT_KEY: keyOf("agent"), AGENT_OWNER: addressOf("agentOwner"), AGENT_RPC_URL: ANVIL_URL, AGENT_CHAIN_ID: 31337,
      ...(dep.contracts.agentRouter ? { AGENT_ROUTER: getAddress(dep.contracts.agentRouter as Address) } : {}),
      MCP_HTTP_HOST: "127.0.0.1", MCP_HTTP_PORT: PORTS.mcp, MCP_HTTP_TOKEN: randomBytes(16).toString("hex"), MCP_RATE_LIMIT_PER_MINUTE: 600,
    },
    bundler: { BUNDLER_PORT: PORTS.bundler, ANVIL_URL, FORK_DIR },
  };
}

if (import.meta.main) {
  if (process.argv.includes("--relax")) await relax();
  if (process.argv.includes("--env")) {
    mkdirSync(join(FORK_DIR, "env"), { recursive: true });
    for (const [name, vars] of Object.entries(serviceEnv())) writeFileSync(join(FORK_DIR, "env", `${name}.env`), envText(vars), { mode: 0o600 });
    console.log(`setup: env files in ${join(FORK_DIR, "env")}`);
  }
}
