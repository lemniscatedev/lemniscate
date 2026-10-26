import { AsyncLocalStorage } from "node:async_hooks";
import { createPublicClient, http, parseAbi, type Address, type Hex } from "viem";
import { entryPoint07Abi } from "viem/account-abstraction";
import { kernelFactoryAbi } from "./kernel";

/** Read-only chain access the builder and the sponsorship gate need. Tests replace it; production uses a viem public client. */
export interface AaChain {
  isDeployed(account: Address): Promise<boolean>;
  entryPointNonce(entryPoint: Address, sender: Address, key: bigint): Promise<bigint>;
  predictKernelAddress(factory: Address, initData: Hex, salt: Hex): Promise<Address>;
  /** null when the node cannot say; the builder then uses its configured fallback. */
  feesPerGas(): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint } | null>;
  /** The ECDSA owner the Kernel validator has stored for a deployed account, or null when none is set. */
  kernelOwner(validator: Address, account: Address): Promise<Address | null>;
  /** ERC-20 balance of `owner`. */
  tokenBalance(token: Address, owner: Address): Promise<bigint>;
  /** LemniscatePaymaster.kernelAccount(account): the paymaster saw it deployed through the Kernel factory in a sponsored
   * operation, or the owner registered it (review F26, decision 44). */
  paymasterKnowsAccount(paymaster: Address, account: Address): Promise<boolean>;
  /** The account's ERC-1967 implementation slot, or null when the account has no code. */
  implementationOf(account: Address): Promise<Address | null>;
  /** R3-06 (H1): this API relayed an operation of `sender` with `nonce` and the bundler accepted it (so the owner signed it):
   * the next nonce of that key is nonce + 1. Lets the lane-0 nonce be cached for long without going stale for our own users. */
  noteRelayed?(sender: Address, nonce: bigint): void;
}

/** ERC-1967 implementation slot: bytes32(uint256(keccak256("eip1967.proxy.implementation")) - 1). */
export const ERC1967_IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc" as const; // not-a-key

/** Raised when the API's own outbound RPC budget is spent. Callers answer 503 instead of queueing (F32). */
export class RpcBudgetError extends Error {
  constructor() { super("The API's chain-read budget is spent; try again in a moment."); this.name = "RpcBudgetError"; }
}

/**
 * R12: who is asking. The route runs a build inside `withAaCaller`, so the shared budget can give every client (IPv4 or
 * IPv6 /64) its own small share and keep a reserved lane for the exit that matters most. `sell` marks a sell intent.
 * R3-06: the reserved lane is for HOLDERS only: `holder` is set by the route to the account when Postgres (the indexed
 * balances, no chain read) shows it holds the option it sells. Any deployed Kernel account used to qualify, which made the
 * lane free to drain; now a caller needs a real position, and each holder account draws at most its own small share of the
 * lane, whatever client it comes from.
 */
export interface AaCaller { readonly client: string; readonly sell: boolean; readonly holder?: string | undefined }
const callerStore = new AsyncLocalStorage<AaCaller>();
export function withAaCaller<T>(caller: AaCaller, run: () => Promise<T>): Promise<T> {
  return callerStore.run({ ...caller, ...(caller.holder ? { holder: caller.holder.toLowerCase() } : {}) }, run);
}

export interface RpcBudgetOptions {
  /** Sustained chain reads per second the whole API may make for account abstraction. */
  readonly callsPerSecond: number;
  readonly burst: number;
  readonly now?: () => number;
  /** How long a read stays valid. Deployed-ness of a deployed account never expires. */
  readonly ttlMs?: {
    readonly fees: number; readonly nonce: number; readonly notDeployed: number; readonly owner: number; readonly balance: number;
    /** R3-06 (H1): the lane-0 nonce, the one sponsored and holder sells use. It only moves when the account executes an
     * operation, so it is cached for long: a stranger naming a holder costs at most one read per this long. */
    readonly laneZeroNonce?: number;
  };
  /** R12: one client's own share (reads per second and burst). Default: a fifth of the total, at least 1 per second, and a
   * burst of under half the total so that one client cannot take all of the shared burst. */
  readonly perClient?: { readonly callsPerSecond: number; readonly burst: number };
  /** R12: the part of the total kept for holders' sells. Default 0.4. */
  readonly reservedShare?: number;
  /** R3-06: one holder account's share of the reserved lane. Default a tenth of the lane (0.2 reads/s at the default budget,
   * a warm sell every few seconds) with a burst of 6, enough for a cold sponsored sell (code, owner, implementation,
   * paymaster, nonce, fees). It takes ten accounts holding a position to empty the lane. */
  readonly perHolder?: { readonly callsPerSecond: number; readonly burst: number };
}

const DEFAULT_TTL = { fees: 5_000, nonce: 1_000, notDeployed: 3_000, owner: 300_000, balance: 5_000, laneZeroNonce: 120_000 } as const;
/** After our relay accepted an operation, the next nonce is known: kept this long, then read again (it is included by then). */
const RELAYED_NONCE_TTL_MS = 60_000;
/** R3-06 (H1): distinct non-zero nonce lanes one account may have read per minute; each is a cache miss anyone can cause. */
const MAX_LANES_PER_ACCOUNT_PER_MINUTE = 4;
/** A paymaster that does not know an account yet may learn it (owner registration): re-read after this long. */
const UNKNOWN_ACCOUNT_TTL_MS = 30_000;
const MAX_TEMP_ENTRIES = 5_000;
const MAX_KEPT_ENTRIES = 20_000;
const MAX_CLIENTS = 10_000;

class Bucket {
  tokens: number;
  last: number;
  constructor(readonly rate: number, readonly burst: number, at: number) { this.tokens = burst; this.last = at; }
  refill(at: number): void {
    this.tokens = Math.min(this.burst, this.tokens + ((at - this.last) / 1000) * this.rate);
    this.last = at;
  }
  has(at: number): boolean { this.refill(at); return this.tokens >= 1; }
  take(): void { this.tokens -= 1; }
}

/**
 * F32/R12: puts a hard cap and short caches in front of an AaChain. Every real read spends one token; with the budget
 * empty a read throws RpcBudgetError at once, so a flood of `?format=userop` requests costs the shared public RPC at most
 * the budget and never starves the keeper or the indexer. The budget is not one bucket any client can empty:
 *  - every client (the caller set by `withAaCaller`) has its own small bucket, so one IP can use up only its own share;
 *  - a reserved bucket (40 % of the rate) is open only to sells of accounts that hold the option (R3-06), each account with its own share;
 *  - the rest is shared by everything else.
 * Reads that cannot change quickly are cached. Entries that never expire (a deployed account stays deployed) live in
 * their own map, so a flood of throw-away keys evicts other throw-away keys, never a known account.
 */
export function withRpcBudget(inner: AaChain, options: RpcBudgetOptions): AaChain & { readonly stats: { reads: number; refused: number } } {
  const now = options.now ?? Date.now;
  const ttl = options.ttlMs ?? DEFAULT_TTL;
  const reservedShare = Math.min(Math.max(options.reservedShare ?? 0.4, 0), 0.9);
  const start = now();
  const shared = new Bucket(options.callsPerSecond * (1 - reservedShare), Math.max(1, Math.round(options.burst * (1 - reservedShare))), start);
  const reserved = new Bucket(options.callsPerSecond * reservedShare, Math.max(1, Math.round(options.burst * reservedShare)), start);
  const per = options.perClient ?? { callsPerSecond: Math.max(1, options.callsPerSecond / 5), burst: Math.max(4, Math.round(options.burst * 0.45)) };
  const perHolder = options.perHolder ?? { callsPerSecond: reserved.rate / 10, burst: 6 };
  const clients = new Map<string, Bucket>();
  const holders = new Map<string, Bucket>();
  const bucketOf = (map: Map<string, Bucket>, key: string, rate: number, burst: number, at: number): Bucket => {
    let bucket = map.get(key);
    if (!bucket) {
      if (map.size >= MAX_CLIENTS) for (const old of [...map.keys()].slice(0, MAX_CLIENTS / 10)) map.delete(old);
      bucket = new Bucket(rate, burst, at);
      map.set(key, bucket);
    }
    return bucket;
  };
  const stats = { reads: 0, refused: 0 };
  const refuse = (): never => { stats.refused += 1; throw new RpcBudgetError(); };
  /** `sharedKey`: one cache key for everybody (the fee read), so it is bounded by its own TTL and needs no holder share.
   * `noHolder`: a read the reserved lane never pays for (a non-zero nonce lane: a fresh lane is a miss anyone can cause). */
  const spend = (mode: "normal" | "sharedKey" | "noHolder" = "normal") => {
    const sharedKey = mode === "sharedKey";
    const at = now();
    const caller = callerStore.getStore();
    // R3-06: a holder's sell reads from the reserved lane, charged to the holder account's own share of it and not to the
    // client's: no number of /64s or position-less accounts can empty it, and one position takes at most its own part.
    if (caller?.sell && caller.holder && mode !== "noHolder") {
      const share = bucketOf(holders, caller.holder, perHolder.callsPerSecond, perHolder.burst, at);
      if ((sharedKey || share.has(at)) && reserved.has(at)) {
        if (!sharedKey) share.take();
        reserved.take();
        stats.reads += 1;
        return;
      }
    }
    let mine: Bucket | undefined;
    if (caller) {
      mine = bucketOf(clients, caller.client, per.callsPerSecond, per.burst, at);
      if (!mine.has(at)) refuse();
    }
    if (!shared.has(at)) refuse();
    shared.take();
    mine?.take();
    stats.reads += 1;
  };
  const temp = new Map<string, { until: number; value: unknown }>();
  const kept = new Map<string, unknown>();
  const trim = (map: Map<string, unknown>, limit: number) => {
    if (map.size <= limit) return;
    for (const key of [...map.keys()].slice(0, Math.ceil(limit / 10))) map.delete(key); // oldest first
  };
  async function cached<T>(key: string, ttlMs: number, read: () => Promise<T>, keepWhen?: (value: T) => boolean,
    mode: "normal" | "sharedKey" | "noHolder" = "normal", beforeSpend?: () => void): Promise<T> {
    if (kept.has(key)) return kept.get(key) as T;
    const hit = temp.get(key);
    const at = now();
    if (hit && hit.until > at) return hit.value as T;
    beforeSpend?.();
    spend(mode);
    const value = await read();
    if (keepWhen && keepWhen(value)) {
      kept.set(key, value);
      trim(kept, MAX_KEPT_ENTRIES);
    } else {
      temp.set(key, { until: at + ttlMs, value });
      trim(temp as Map<string, unknown>, MAX_TEMP_ENTRIES);
    }
    return value;
  }
  // R3-06 (H1): non-zero nonce lanes read per account in the current minute.
  const lanesRead = new Map<string, { start: number; lanes: Set<string> }>();
  const capLanes = (sender: string, key: bigint) => () => {
    const at = now();
    let entry = lanesRead.get(sender);
    if (!entry || at - entry.start >= 60_000) {
      if (lanesRead.size >= MAX_CLIENTS) for (const old of [...lanesRead.keys()].slice(0, MAX_CLIENTS / 10)) lanesRead.delete(old);
      entry = { start: at, lanes: new Set() };
      lanesRead.set(sender, entry);
    }
    const lane = key.toString();
    if (!entry.lanes.has(lane) && entry.lanes.size >= MAX_LANES_PER_ACCOUNT_PER_MINUTE) refuse();
    entry.lanes.add(lane);
  };
  const laneZeroTtl = ttl.laneZeroNonce ?? DEFAULT_TTL.laneZeroNonce;
  return {
    stats,
    noteRelayed: (sender, nonce) => {
      const key = nonce >> 64n;
      temp.set(`nonce:${sender.toLowerCase()}:${key}`, { until: now() + RELAYED_NONCE_TTL_MS, value: nonce + 1n });
      trim(temp as Map<string, unknown>, MAX_TEMP_ENTRIES);
    },
    isDeployed: (account) => cached(`code:${account.toLowerCase()}`, ttl.notDeployed, () => inner.isDeployed(account), (deployed) => deployed),
    // R3-06 (H1): lane 0 is cached for long (it moves only when the account executes, and our relay tells us when it does);
    // any other lane is a miss anyone can cause, so it is capped per account and never paid for by the reserved lane.
    entryPointNonce: (entryPoint, sender, key) => key === 0n
      ? cached(`nonce:${sender.toLowerCase()}:${key}`, laneZeroTtl, () => inner.entryPointNonce(entryPoint, sender, key))
      : cached(`nonce:${sender.toLowerCase()}:${key}`, ttl.nonce, () => inner.entryPointNonce(entryPoint, sender, key), undefined, "noHolder",
        capLanes(sender.toLowerCase(), key)),
    predictKernelAddress: (factory, initData, salt) => cached(`predict:${factory}:${initData}:${salt}`, 3_600_000, () => inner.predictKernelAddress(factory, initData, salt)),
    feesPerGas: () => cached("fees", ttl.fees, () => inner.feesPerGas(), undefined, "sharedKey"),
    kernelOwner: (validator, account) => cached(`owner:${account.toLowerCase()}`, ttl.owner, () => inner.kernelOwner(validator, account)),
    tokenBalance: (token, owner) => cached(`bal:${token.toLowerCase()}:${owner.toLowerCase()}`, ttl.balance, () => inner.tokenBalance(token, owner)),
    // The paymaster never forgets a known account; an unknown one is re-read after a short while.
    paymasterKnowsAccount: (paymaster, account) => cached(`known:${paymaster.toLowerCase()}:${account.toLowerCase()}`, UNKNOWN_ACCOUNT_TTL_MS,
      () => inner.paymasterKnowsAccount(paymaster, account), (known) => known),
    // An account can upgrade itself: cached like the owner, not forever.
    implementationOf: (account) => cached(`impl:${account.toLowerCase()}`, ttl.owner, () => inner.implementationOf(account)),
  };
}

const validatorAbi = parseAbi(["function ecdsaValidatorStorage(address kernel) view returns (address owner)"]);
const erc20BalanceAbi = parseAbi(["function balanceOf(address owner) view returns (uint256)"]);
const paymasterAccountsAbi = parseAbi(["function kernelAccount(address account) view returns (bool)"]);

export interface ViemAaChainOptions {
  readonly callsPerSecond?: number;
  readonly burst?: number;
  /** One client's share of the budget (R12). */
  readonly clientCallsPerSecond?: number;
}

/** The only module of the API side that talks to a node. No retries: a failed read is reported, never repeated (F32). */
export function createViemAaChain(rpcUrl: string, options: ViemAaChainOptions = {}): AaChain {
  const client = createPublicClient({ transport: http(rpcUrl, { retryCount: 0, timeout: 8_000 }) });
  const raw: AaChain = {
    async isDeployed(account) {
      const code = await client.getCode({ address: account });
      return code !== undefined && code !== "0x";
    },
    async entryPointNonce(entryPoint, sender, key) {
      return await client.readContract({ address: entryPoint, abi: entryPoint07Abi, functionName: "getNonce", args: [sender, key] });
    },
    async predictKernelAddress(factory, initData, salt) {
      return await client.readContract({ address: factory, abi: kernelFactoryAbi, functionName: "getAddress", args: [initData, salt] });
    },
    async feesPerGas() {
      try {
        const fees = await client.estimateFeesPerGas();
        if (fees.maxFeePerGas === undefined || fees.maxPriorityFeePerGas === undefined) return null;
        return { maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas };
      } catch {
        return null;
      }
    },
    async kernelOwner(validator, account) {
      const owner = await client.readContract({ address: validator, abi: validatorAbi, functionName: "ecdsaValidatorStorage", args: [account] });
      return /^0x0{40}$/.test(owner) ? null : owner.toLowerCase() as Address;
    },
    async tokenBalance(token, owner) {
      return await client.readContract({ address: token, abi: erc20BalanceAbi, functionName: "balanceOf", args: [owner] });
    },
    async paymasterKnowsAccount(paymaster, account) {
      return await client.readContract({ address: paymaster, abi: paymasterAccountsAbi, functionName: "kernelAccount", args: [account] });
    },
    async implementationOf(account) {
      const word = await client.getStorageAt({ address: account, slot: ERC1967_IMPLEMENTATION_SLOT });
      if (!word || /^0x0*$/.test(word)) return null;
      return `0x${word.slice(-40)}`.toLowerCase() as Address;
    },
  };
  return withRpcBudget(raw, {
    callsPerSecond: options.callsPerSecond ?? 5, burst: options.burst ?? 14,
    ...(options.clientCallsPerSecond ? { perClient: { callsPerSecond: options.clientCallsPerSecond, burst: Math.max(4, Math.round((options.burst ?? 14) * 0.45)) } } : {}),
  });
}
