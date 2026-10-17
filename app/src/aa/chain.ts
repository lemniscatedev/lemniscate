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
}

/** Raised when the API's own outbound RPC budget is spent. Callers answer 503 instead of queueing (F32). */
export class RpcBudgetError extends Error {
  constructor() { super("The API's chain-read budget is spent; try again in a moment."); this.name = "RpcBudgetError"; }
}

export interface RpcBudgetOptions {
  /** Sustained chain reads per second the whole API may make for account abstraction. */
  readonly callsPerSecond: number;
  readonly burst: number;
  readonly now?: () => number;
  /** How long a read stays valid. Deployed-ness of a deployed account never expires. */
  readonly ttlMs?: { readonly fees: number; readonly nonce: number; readonly notDeployed: number; readonly owner: number; readonly balance: number };
}

const DEFAULT_TTL = { fees: 5_000, nonce: 1_000, notDeployed: 3_000, owner: 300_000, balance: 5_000 } as const;

/**
 * F32: puts a hard cap and short caches in front of an AaChain. Every real read spends one token of a bucket that
 * refills at `callsPerSecond`; with the bucket empty a read throws RpcBudgetError at once, so a flood of
 * `?format=userop` requests costs the shared public RPC at most the budget and never starves the keeper or the indexer.
 * Reads that cannot change quickly are cached (a deployed account stays deployed; fees move slowly).
 */
export function withRpcBudget(inner: AaChain, options: RpcBudgetOptions): AaChain & { readonly stats: { reads: number; refused: number } } {
  const now = options.now ?? Date.now;
  const ttl = options.ttlMs ?? DEFAULT_TTL;
  let tokens = options.burst;
  let last = now();
  const stats = { reads: 0, refused: 0 };
  const spend = () => {
    const at = now();
    tokens = Math.min(options.burst, tokens + ((at - last) / 1000) * options.callsPerSecond);
    last = at;
    if (tokens < 1) { stats.refused += 1; throw new RpcBudgetError(); }
    tokens -= 1;
    stats.reads += 1;
  };
  const cache = new Map<string, { until: number; value: unknown }>();
  async function cached<T>(key: string, ttlMs: number, read: () => Promise<T>, keepWhen?: (value: T) => boolean): Promise<T> {
    const hit = cache.get(key);
    const at = now();
    if (hit && hit.until > at) return hit.value as T;
    spend();
    const value = await read();
    const lifetime = keepWhen && keepWhen(value) ? Number.POSITIVE_INFINITY : ttlMs;
    if (cache.size > 5_000) cache.clear();
    cache.set(key, { until: at + lifetime, value });
    return value;
  }
  return {
    stats,
    isDeployed: (account) => cached(`code:${account.toLowerCase()}`, ttl.notDeployed, () => inner.isDeployed(account), (deployed) => deployed),
    entryPointNonce: (entryPoint, sender, key) => cached(`nonce:${sender.toLowerCase()}:${key}`, ttl.nonce, () => inner.entryPointNonce(entryPoint, sender, key)),
    predictKernelAddress: (factory, initData, salt) => cached(`predict:${factory}:${initData}:${salt}`, 3_600_000, () => inner.predictKernelAddress(factory, initData, salt)),
    feesPerGas: () => cached("fees", ttl.fees, () => inner.feesPerGas()),
    kernelOwner: (validator, account) => cached(`owner:${account.toLowerCase()}`, ttl.owner, () => inner.kernelOwner(validator, account)),
    tokenBalance: (token, owner) => cached(`bal:${token.toLowerCase()}:${owner.toLowerCase()}`, ttl.balance, () => inner.tokenBalance(token, owner)),
  };
}

const validatorAbi = parseAbi(["function ecdsaValidatorStorage(address kernel) view returns (address owner)"]);
const erc20BalanceAbi = parseAbi(["function balanceOf(address owner) view returns (uint256)"]);

export interface ViemAaChainOptions {
  readonly callsPerSecond?: number;
  readonly burst?: number;
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
  };
  return withRpcBudget(raw, { callsPerSecond: options.callsPerSecond ?? 5, burst: options.burst ?? 10 });
}
