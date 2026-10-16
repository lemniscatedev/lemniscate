// Shared helpers for the anvil mainnet-fork scripts (setup, fund, exercise, bundler). Ports and paths follow env.sh.
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  createPublicClient, createTestClient, createWalletClient, getAddress, http, parseAbi, type Address, type Hex,
  type PublicClient, type TestClient, type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { parseOptionDeployment, type OptionDeployment } from "@/chain/deployment";

export const FORK_CHAIN_ID = 31337;
const offset = Number(process.env.PORT_OFFSET ?? "0");
export const APP = resolve(import.meta.dir, "../..");
export const ROOT = resolve(APP, "..");
export const FORK_DIR = process.env.FORK_DIR ?? join(process.env.HOME ?? APP, ".lemniscate", "fork");
export const PORTS = {
  anvil: 8545 + offset, cache: 9545 + offset, pg: 5433 + offset, api: 3101 + offset, mcp: 3102 + offset,
  bundler: 4337 + offset, web: 7200 + offset,
} as const;
export const ANVIL_URL = process.env.ANVIL_URL ?? `http://127.0.0.1:${PORTS.anvil}`;
export const API_URL = process.env.API_URL ?? `http://127.0.0.1:${PORTS.api}`;
export const DATABASE_URL = process.env.DATABASE_URL ?? `postgres://${process.env.USER ?? "postgres"}@127.0.0.1:${PORTS.pg}/lemniscate_fork`;

export const forkChain = {
  id: FORK_CHAIN_ID, name: "Lemniscate fork", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [ANVIL_URL] } },
} as const;

/** anvil's `--config-out` file: the dev accounts and their (public, well-known) keys. Never copied into the repo. */
export interface AnvilAccounts { available_accounts: Address[]; private_keys: Hex[] }
export function anvilAccounts(): AnvilAccounts {
  const file = join(FORK_DIR, "anvil-accounts.json");
  if (!existsSync(file)) throw new Error(`${file} is missing: start the fork with scripts/fork/up.sh`);
  return JSON.parse(readFileSync(file, "utf8")) as AnvilAccounts;
}

/** Who plays which part on the fork (deploy-config.fork.json maps roles to the same indexes). */
export const ROLE_INDEX = {
  deployer: 0, owner: 1, keeper: 2, hedger: 3, volSigner: 4, guardian: 5, treasury: 6, keepersPot: 7, hedgerPot: 8,
  depositor: 9, alice: 10, bob: 11, agentOwner: 12, agent: 13, lp2: 14, bundler: 15, carol: 16, kal: 17, settler: 18, payer: 19,
} as const;
export type Role = keyof typeof ROLE_INDEX;

export type RawDeployment = OptionDeployment & {
  contracts: OptionDeployment["contracts"] & { hedgeAdapter?: string; timelock?: string; priceReference?: string; swapRouter?: string };
};
export function loadDeployment(): RawDeployment {
  const file = join(FORK_DIR, "deployment.json");
  const raw = JSON.parse(readFileSync(file, "utf8")) as { contracts: Record<string, string> };
  const parsed = parseOptionDeployment(raw, file);
  if (parsed.chainId !== FORK_CHAIN_ID) throw new Error(`deployment is chain ${parsed.chainId}, not the fork`);
  return { ...parsed, contracts: { ...parsed.contracts, ...lower(raw.contracts) } } as RawDeployment;
}
const lower = (o: Record<string, string>) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v.toLowerCase()]));

export interface ForkClients { pub: PublicClient; test: TestClient<"anvil">; }
export function forkClients(): ForkClients {
  const transport = http(ANVIL_URL, { timeout: 120_000, retryCount: 3 });
  return {
    pub: createPublicClient({ chain: forkChain, transport, pollingInterval: 250 }) as PublicClient,
    test: createTestClient({ chain: forkChain, mode: "anvil", transport }),
  };
}

/** A wallet for one of anvil's dev accounts (signs locally with its well-known key). */
export function walletFor(role: Role | number): WalletClient {
  const accounts = anvilAccounts();
  const i = typeof role === "number" ? role : ROLE_INDEX[role];
  const key = accounts.private_keys[i];
  if (!key) throw new Error(`anvil account ${i} missing (start anvil with --accounts 20)`);
  return createWalletClient({ chain: forkChain, transport: http(ANVIL_URL, { timeout: 120_000 }), account: privateKeyToAccount(key) });
}
export const addressOf = (role: Role | number): Address => getAddress(anvilAccounts().available_accounts[typeof role === "number" ? role : ROLE_INDEX[role]]!);
export const keyOf = (role: Role | number): Hex => anvilAccounts().private_keys[typeof role === "number" ? role : ROLE_INDEX[role]]!;

/** A wallet that sends as `address` through anvil's impersonation (contracts included). Used for admin (the timelock)
 * and the USDG holder; nothing is written to storage directly. */
export async function impersonated(test: TestClient<"anvil">, address: Address): Promise<WalletClient> {
  await test.impersonateAccount({ address });
  await test.setBalance({ address, value: 10n ** 20n });
  return createWalletClient({ chain: forkChain, transport: http(ANVIL_URL, { timeout: 120_000 }), account: address });
}

export const erc20Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address,uint256) returns (bool)",
  "function approve(address,uint256) returns (bool)",
  "function allowance(address,address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
]);

export function readJson<T>(path: string): T { return JSON.parse(readFileSync(path, "utf8")) as T; }

/** Next instant at or after `from` whose New York wall clock is weekday `dow` (0 Sun..6 Sat) at hh:mm. */
export function nextNy(from: number, dow: number, hh: number, mm = 0): number {
  const parts = (t: number) => {
    const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(new Date(t * 1000)).map((x) => [x.type, x.value]));
    return { dow: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(p.weekday!), h: Number(p.hour), m: Number(p.minute) };
  };
  let t = Math.ceil(from / 60) * 60;
  for (let i = 0; i < 60 * 24 * 8; i++, t += 60) {
    const p = parts(t);
    if (p.dow === dow && p.h === hh && p.m === mm) return t;
  }
  throw new Error("no such time within 8 days");
}
