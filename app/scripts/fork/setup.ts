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
//   2. anvil's 20 dev accounts (well-known keys) carry EIP-7702 delegations on Robinhood Chain mainnet (code 0xef0100 +
//      a sweeper contract, seen at the fork block). On the fork they would run that code: Permit2 treats a delegated
//      payer as a contract and asks it for an ERC-1271 signature (x402 settlement reverted), and ETH sent to them is
//      forwarded. The delegation code is cleared (anvil_setCode "0x") so they act as the plain test EOAs they are.
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAddress, type Address } from "viem";
import { PriceGuardAbi } from "@/abi/PriceGuard";
import {
  addressOf, ANVIL_URL, anvilAccounts, API_URL, DATABASE_URL, FORK_DIR, forkClients, impersonated, keyOf, loadDeployment, PORTS,
} from "./lib";

export const FORK_MAX_AGE = 30 * 86_400;

export async function clearDevDelegations(): Promise<number> {
  const { pub, test } = forkClients();
  let cleared = 0;
  for (const address of anvilAccounts().available_accounts) {
    const code = await pub.getCode({ address });
    if (code && code !== "0x") { await test.setCode({ address, bytecode: "0x" }); cleared++; }
  }
  return cleared;
}

async function relax(): Promise<void> {
  console.log(`setup: fork relaxation cleared EIP-7702 delegation code on ${await clearDevDelegations()} anvil dev accounts`);
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

/** DeploySystem's fork profile writes no `forkProof`, but the keeper refuses a fork deployment without one (it checks the
 * node it talks to is the fork the system was deployed on). The proof is the deploy block's number and hash on this node. */
export function withForkProof<T extends { deployBlock: number | string }>(raw: T, blockHash: string): T & { forkProof: { blockNumber: number; blockHash: string } } {
  if (!/^0x[0-9a-fA-F]{64}$/.test(blockHash)) throw new Error(`not a block hash: ${blockHash}`);
  return { ...raw, forkProof: { blockNumber: Number(raw.deployBlock), blockHash: blockHash.toLowerCase() } };
}

async function addProof(): Promise<void> {
  const file = join(FORK_DIR, "deployment.json");
  const raw = JSON.parse(readFileSync(file, "utf8")) as { deployBlock: number };
  const block = await forkClients().pub.getBlock({ blockNumber: BigInt(raw.deployBlock) });
  writeFileSync(file, `${JSON.stringify(withForkProof(raw, block.hash!), null, 1)}\n`);
  console.log(`setup: forkProof = block ${raw.deployBlock} ${block.hash}`);
}

export function envText(vars: Record<string, string | number>): string {
  return `${Object.entries(vars).map(([k, v]) => `${k}=${String(v).includes(" ") ? JSON.stringify(String(v)) : v}`).join("\n")}\n`;
}

/** The MCP bearer token of an existing env file: up.sh rewrites the env files on every start, and a running MCP server
 * keeps the token it started with, so the token must not change under it. */
function existingMcpToken(): string | undefined {
  const file = join(FORK_DIR, "env", "mcp.env");
  if (!existsSync(file)) return undefined;
  return /^MCP_HTTP_TOKEN=([0-9a-f]{32})$/m.exec(readFileSync(file, "utf8"))?.[1];
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
      // The website's fork profile: `npm run fork` in the frontend repo (port 4189) or the Playwright fork check (7200+O).
      CORS_ORIGINS: [PORTS.web, 4189].flatMap((p) => [`http://localhost:${p}`, `http://127.0.0.1:${p}`]).join(","),
      BUNDLER_URL: `http://127.0.0.1:${PORTS.bundler}`,
    },
    keeper: { ...shared, KEEPER_PRIVATE_KEY: keyOf("keeper"), KEEPER_DRY_RUN: 0, KEEPER_ACCRUE_MAX_AGE_SECONDS: 300, KEEPER_LISTER_MAX_TX: 250 },
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
      MCP_HTTP_HOST: "127.0.0.1", MCP_HTTP_PORT: PORTS.mcp, MCP_HTTP_TOKEN: existingMcpToken() ?? randomBytes(16).toString("hex"), MCP_RATE_LIMIT_PER_MINUTE: 600,
    },
    bundler: { BUNDLER_PORT: PORTS.bundler, ANVIL_URL, FORK_DIR },
  };
}

if (import.meta.main) {
  if (process.argv.includes("--proof")) await addProof();
  if (process.argv.includes("--relax")) await relax();
  if (process.argv.includes("--clear-delegations")) console.log(`setup: cleared ${await clearDevDelegations()} delegations`);
  if (process.argv.includes("--env")) {
    mkdirSync(join(FORK_DIR, "env"), { recursive: true });
    for (const [name, vars] of Object.entries(serviceEnv())) writeFileSync(join(FORK_DIR, "env", `${name}.env`), envText(vars), { mode: 0o600 });
    console.log(`setup: env files in ${join(FORK_DIR, "env")}`);
  }
}
