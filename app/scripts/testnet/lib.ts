// Shared helpers for the Robinhood Chain TESTNET (46630) run (app/scripts/testnet). Same shape as the fork stack
// (scripts/fork), with three differences: every wallet is an encrypted keystore (throwaway testnet wallets, never
// mainnet ones), nothing can move the clock, and nothing is impersonated (admin goes through the owner Safe).
//
// Paths (all outside the repository):
//   TESTNET_KEYS_DIR  ~/.lemniscate/testnet-keys   <role>.json keystore + <role>.password (mode 600), addresses.txt
//   TESTNET_DIR       ~/.lemniscate/testnet         deployment, env files, logs, pids, Postgres cluster, ledger, results
// The dry run (dry-run.sh) points TESTNET_DIR at ~/.lemniscate/testnet-dryrun and TESTNET_RPC_URL at a local anvil fork
// of the testnet that answers chain id 46630, so the same scripts run unchanged.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  createPublicClient, createWalletClient, defineChain, getAddress, http, parseAbi, type Address, type Hex, type PublicClient, type WalletClient,
} from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { parseOptionDeployment, type OptionDeployment } from "@/chain/deployment";
import { decryptKeystore } from "@/keys";

export const TESTNET_CHAIN_ID = 46630;
export const PUBLIC_RPC = "https://rpc.testnet.chain.robinhood.com";
export const EXPLORER = "https://explorer.testnet.chain.robinhood.com";
export const APP = resolve(import.meta.dir, "../..");
export const ROOT = resolve(APP, "..");
export const RPC = process.env.TESTNET_RPC_URL || PUBLIC_RPC;
export const TESTNET_DIR = process.env.TESTNET_DIR || join(homedir(), ".lemniscate", "testnet");
export const KEYS_DIR = process.env.TESTNET_KEYS_DIR || join(homedir(), ".lemniscate", "testnet-keys");
const offset = Number(process.env.PORT_OFFSET ?? "70");
export const PORTS = {
  anvil: 8545 + offset, cache: 9545 + offset, pg: 5433 + offset, api: 3101 + offset, mcp: 3102 + offset,
  bundler: 4337 + offset, x402: 3121 + offset, web: 7200 + offset,
} as const;
export const API_URL = process.env.API_URL ?? `http://127.0.0.1:${PORTS.api}`;
export const DATABASE_URL = process.env.DATABASE_URL ?? `postgres://${process.env.USER ?? "postgres"}@127.0.0.1:${PORTS.pg}/lemniscate_testnet`;
/** Orbit NodeInterface (virtual contract): gasEstimateComponents gives the L1 data part of a transaction. */
export const NODE_INTERFACE = "0x00000000000000000000000000000000000000C8" as const;

export const testnetChain = defineChain({
  id: TESTNET_CHAIN_ID, name: "Robinhood Chain Testnet", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
});

/** True for a node on this machine (the dry run's anvil fork). Everything else is the real testnet. */
export function isLocalRpc(url = RPC): boolean {
  const host = new URL(url).hostname;
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

/** Every throwaway testnet wallet, by role. `owner-*` sign for the owner Safe; the rest send their own transactions. */
export const ROLES = [
  "deployer", "owner-1", "owner-2", "owner-3", "guardian", "keeper", "hedger", "vol-signer", "paymaster-signer", "x402-settler",
  "bundler", "feed-mirror", "treasury", "keepers-pot", "hedger-pot", "agent", "depositor", "alice", "bob", "carol", "agent-owner",
  "lp2", "payer",
] as const;
export type TestnetRole = (typeof ROLES)[number];

export const keystorePath = (role: TestnetRole) => join(KEYS_DIR, `${role}.json`);
export const passwordPath = (role: TestnetRole) => join(KEYS_DIR, `${role}.password`);

/** Public addresses from addresses.txt ("<role> <address>" lines; written when the keystores were made). */
export function addresses(): Record<TestnetRole, Address> {
  const file = join(KEYS_DIR, "addresses.txt");
  if (!existsSync(file)) throw new Error(`${file} is missing: create the testnet keystores first (docs/runbooks/testnet-run.md)`);
  const out: Partial<Record<TestnetRole, Address>> = {};
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const [role, address] = line.trim().split(/\s+/);
    if (role && address && (ROLES as readonly string[]).includes(role)) out[role as TestnetRole] = getAddress(address);
  }
  for (const r of ROLES) if (!out[r]) throw new Error(`${file} has no address for ${r}`);
  return out as Record<TestnetRole, Address>;
}
export const addressOf = (role: TestnetRole): Address => addresses()[role];

const accounts = new Map<TestnetRole, PrivateKeyAccount>();
/** Decrypts one role's keystore in this process (never printed, never written). */
export function accountOf(role: TestnetRole): PrivateKeyAccount {
  let a = accounts.get(role);
  if (!a) {
    const key = decryptKeystore(readFileSync(keystorePath(role), "utf8"), readFileSync(passwordPath(role), "utf8").trim());
    a = privateKeyToAccount(key);
    if (getAddress(a.address) !== addressOf(role)) throw new Error(`keystore ${role} does not match addresses.txt`);
    accounts.set(role, a);
  }
  return a;
}

export function publicClient(): PublicClient {
  return createPublicClient({ chain: testnetChain, transport: http(RPC, { timeout: 120_000, retryCount: 6, retryDelay: 750 }), pollingInterval: isLocalRpc() ? 250 : 1000 }) as PublicClient;
}
export function walletFor(role: TestnetRole): WalletClient {
  return createWalletClient({ chain: testnetChain, transport: http(RPC, { timeout: 120_000, retryCount: 3 }), account: accountOf(role) });
}

export class WrongChainError extends Error {}
/** Throws unless the RPC answers 46630 (the real testnet, or the dry run's fork of it). */
export async function assertTestnet(rpc = RPC): Promise<void> {
  const res = await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }) });
  const body = (await res.json()) as { result?: string };
  const id = body.result ? Number(BigInt(body.result)) : NaN;
  if (id !== TESTNET_CHAIN_ID) throw new WrongChainError(`${rpc} answered chain id ${id}, not Robinhood Chain testnet ${TESTNET_CHAIN_ID}: refusing`);
}

export type RawDeployment = OptionDeployment & {
  contracts: OptionDeployment["contracts"] & { hedgeAdapter?: string; swapRouter?: string; owner?: string };
  feeds?: string[];
};
export const deploymentFile = () => join(TESTNET_DIR, "deployment.json");
export function loadDeployment(): RawDeployment {
  const file = deploymentFile();
  const raw = JSON.parse(readFileSync(file, "utf8")) as { contracts: Record<string, string> };
  const parsed = parseOptionDeployment(raw, file);
  if (parsed.chainId !== TESTNET_CHAIN_ID || parsed.network !== "testnet") throw new Error(`deployment is chain ${parsed.chainId} ${parsed.network}, not testnet`);
  return { ...(raw as object), ...parsed, contracts: { ...parsed.contracts, ...raw.contracts } } as RawDeployment;
}

/** The deploy config (docs/runbooks/deploy/deploy-config.testnet.json, copied into TESTNET_DIR by deploy.sh). */
export interface TestnetConfig {
  roles: { owner: Address; depositors?: Address[] };
  testnetOwnerSafe: { factory: Address; singleton: Address; fallbackHandler: Address; owners: Address[]; threshold: number; saltNonce: string };
  mirror?: { sourceRpc: string; feeds: Record<string, Address> };
  stocks: { name: string; mockPriceUsdE8: number }[];
}
export function loadConfig(path = join(TESTNET_DIR, "deploy-config.json")): TestnetConfig {
  return JSON.parse(readFileSync(path, "utf8")) as TestnetConfig;
}

export const erc20Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address,uint256) returns (bool)",
  "function approve(address,uint256) returns (bool)",
  "function allowance(address,address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function mint(address,uint256)",
]);
export const testnetFeedAbi = parseAbi([
  "function push(int256 answer)",
  "function setUpdater(address updater)",
  "function updater() view returns (address)",
  "function owner() view returns (address)",
  "function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)",
]);
export const testnetStockAbi = parseAbi([
  "function mint(address to, uint256 amount)",
  "function scheduleMultiplier(uint256 pending, uint256 effectiveAt)",
  "function uiMultiplier() view returns (uint256)",
]);

/** Explorer link for a transaction or an address (the dry run has no explorer: the link is still printed for the report). */
export const txLink = (hash: Hex) => (isLocalRpc() ? `dry-run tx ${hash}` : `${EXPLORER}/tx/${hash}`);
export const addressLink = (a: Address) => (isLocalRpc() ? `dry-run ${a}` : `${EXPLORER}/address/${a}`);

/** Formats wei as ETH with up to `digits` decimals ("0.001234"). */
export function fmtEth(wei: bigint, digits = 6): string {
  const neg = wei < 0n;
  const v = neg ? -wei : wei;
  const s = v.toString().padStart(19, "0");
  const frac = s.slice(-18).slice(0, digits).replace(/0+$/, "");
  return `${neg ? "-" : ""}${s.slice(0, -18)}${frac ? `.${frac}` : ""}`;
}

export function log(m: string) {
  console.log(`[testnet ${new Date().toISOString().slice(11, 19)}] ${m}`);
}

export type { Hex };
