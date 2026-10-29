import { keeperGasLimit } from "../keeper/tx";
import { decodeFunctionData, encodeFunctionData, getAddress, type Address, type Hex } from "viem";
import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount, type LocalAccount } from "viem/accounts";
import { AgentRouterAbi, OptionEngineAbi } from "../abi";
import { ToolError } from "./api-client";
import type { PolicyMirror } from "./config";

/** Mirror of AgentRouter.Policy plus the allowed names (todo 09). The contract is the authority; this only saves a doomed transaction. */
export type PolicyView = PolicyMirror;

export interface PolicyReader {
  read(owner: Address, agent: Address): Promise<PolicyView | null>;
  /** Called after a buy/shield was sent so the mirror tracks spend. */
  recordSpend?(owner: Address, usdg: bigint): void;
}

export type RouterCall =
  | { kind: "buy"; stock: Address; args: readonly [owner: Address, seriesId: Hex, units: bigint, maxCostUsdg: bigint, deadline: bigint]; expectedUsdg: bigint }
  | { kind: "sell"; stock: Address; args: readonly [owner: Address, seriesId: Hex, tokens: bigint, minProceedsUsdg: bigint, deadline: bigint]; expectedUsdg: bigint }
  | { kind: "shield"; stock: Address; args: readonly [owner: Address, stock: Address, tokenUnits: bigint, pctBelowBps: number, maxCostUsdg: bigint, deadline: bigint]; expectedUsdg: bigint };

export function encodeRouterCall(call: RouterCall): Hex {
  switch (call.kind) {
    case "buy": return encodeFunctionData({ abi: AgentRouterAbi, functionName: "buyFor", args: [...call.args] });
    case "sell": return encodeFunctionData({ abi: AgentRouterAbi, functionName: "sellFor", args: [...call.args] });
    case "shield": return encodeFunctionData({ abi: AgentRouterAbi, functionName: "shieldFor", args: [...call.args] });
  }
}

/** Turn an API intent (calldata for the engine) into the matching AgentRouter call with `owner` as the beneficiary.
 * The intent is the single source of truth for units, limits and deadline; only the entry point changes. */
export function routerCallFromIntent(kind: "buy" | "sell" | "shield", intent: { data: Hex; quote: { usdg: string } }, owner: Address, stockOfSeries?: Address): RouterCall {
  const decoded = decodeFunctionData({ abi: OptionEngineAbi, data: intent.data });
  const expectedUsdg = BigInt(intent.quote.usdg);
  const a = decoded.args as readonly unknown[];
  if (kind === "buy" && decoded.functionName === "buy") {
    return { kind, stock: required(stockOfSeries), expectedUsdg, args: [owner, a[0] as Hex, a[1] as bigint, a[2] as bigint, a[3] as bigint] };
  }
  if (kind === "sell" && decoded.functionName === "sell") {
    return { kind, stock: required(stockOfSeries), expectedUsdg, args: [owner, a[0] as Hex, a[1] as bigint, a[2] as bigint, a[3] as bigint] };
  }
  if (kind === "shield" && decoded.functionName === "shield") {
    return { kind, stock: a[0] as Address, expectedUsdg, args: [owner, a[0] as Address, a[1] as bigint, Number(a[2]), a[3] as bigint, a[4] as bigint] };
  }
  throw new ToolError("BAD_INTENT", "The API returned calldata that does not match the requested action.");
}
const required = (stock: Address | undefined): Address => {
  if (!stock) throw new ToolError("BAD_INTENT", "The series has no known stock.");
  return stock;
};

/** The router's own rules (todo 09 R1 to R3), applied before signing. Codes follow the contract's error names. */
export function checkPolicy(policy: PolicyView | null, call: RouterCall, nowSeconds: number): ToolError | null {
  const refuse = (code: string, message: string) => new ToolError(code, message);
  if (!policy) return refuse("NO_POLICY", "No agent policy is set for this owner. The owner sets one on the AgentRouter first.");
  if (policy.revoked) return refuse("POLICY_REVOKED", "The owner revoked this agent.");
  if (nowSeconds >= policy.expiresAt) return refuse("POLICY_EXPIRED", "This agent policy has expired.");
  if (!policy.stocks.some((s) => s.toLowerCase() === call.stock.toLowerCase())) return refuse("STOCK_NOT_ALLOWED", "This name is not in the agent's allowed list.");
  if (call.kind === "sell" && !policy.canSell) return refuse("SELL_NOT_ALLOWED", "This agent may not sell.");
  if (call.kind === "shield" && !policy.canShield) return refuse("SHIELD_NOT_ALLOWED", "This agent may not buy Shield.");
  if (call.kind !== "sell") {
    if (call.expectedUsdg > BigInt(policy.maxPerTradeUsdg)) return refuse("MAX_PER_TRADE", "The cost is above the per-trade limit.");
    if (BigInt(policy.spentUsdg) + call.expectedUsdg > BigInt(policy.budgetUsdg)) return refuse("BUDGET_EXCEEDED", "The cost is above the remaining budget.");
  }
  return null;
}

/** The one read call the chain reader needs; a viem PublicClient satisfies it and tests pass a mock. */
export interface ChainReader {
  readContract(args: { address: Address; abi: typeof AgentRouterAbi; functionName: string; args: readonly unknown[] }): Promise<unknown>;
}

/** The policy as the AgentRouter holds it (policyOf, allowedStocks, remainingBudget): the owner's on-chain word, not a copy. */
export function chainPolicyReader(chain: ChainReader, router: Address): PolicyReader {
  const read = (functionName: string, args: readonly unknown[]) => chain.readContract({ address: router, abi: AgentRouterAbi, functionName, args });
  return {
    async read(owner, agent) {
      let raw: { agent: Address; budgetUsdg: bigint; spentUsdg: bigint; maxPerTradeUsdg: bigint; expiresAt: bigint; canSell: boolean; canShield: boolean; revoked: boolean };
      let stocks: readonly Address[];
      let remaining: bigint;
      try {
        [raw, stocks, remaining] = await Promise.all([
          read("policyOf", [owner, agent]), read("allowedStocks", [owner, agent]), read("remainingBudget", [owner, agent]),
        ]) as [typeof raw, readonly Address[], bigint];
      } catch {
        // Never echo the underlying message: viem errors can embed the RPC URL.
        throw new ToolError("POLICY_READ_FAILED", "The agent policy could not be read from the AgentRouter. Try again shortly.");
      }
      // An unset policy comes back as the zero struct.
      if (raw.agent === "0x0000000000000000000000000000000000000000") return null;
      return {
        owner, budgetUsdg: raw.budgetUsdg.toString(), spentUsdg: (raw.budgetUsdg - remaining).toString(), maxPerTradeUsdg: raw.maxPerTradeUsdg.toString(),
        expiresAt: Number(raw.expiresAt), canSell: raw.canSell, canShield: raw.canShield, revoked: raw.revoked, stocks: [...stocks],
      };
    },
  };
}

/** Dev fallback only (AGENT_POLICY_FROM_ENV=1): policy kept in the environment (AGENT_POLICY). Spend is tracked in memory; restart resets it, so keep spentUsdg current. */
export function envPolicyReader(mirror: PolicyView | undefined): PolicyReader {
  let current = mirror ? { ...mirror } : undefined;
  return {
    async read(owner) {
      return current && current.owner.toLowerCase() === owner.toLowerCase() ? { ...current } : null;
    },
    recordSpend(_owner, usdg) {
      if (current) current = { ...current, spentUsdg: (BigInt(current.spentUsdg) + usdg).toString() };
    },
  };
}

export interface Executor {
  send(call: { to: Address; data: Hex }): Promise<{ txHash: Hex }>;
}

/** Signs with the agent key and broadcasts through the configured RPC. */
export function viemExecutor(args: { rpcUrl: string; chainId: number; account: LocalAccount }): Executor {
  const chain = { id: args.chainId, name: `chain-${args.chainId}`, nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [args.rpcUrl] } } } as const;
  const wallet = createWalletClient({ account: args.account, chain, transport: http(args.rpcUrl) });
  const client = createPublicClient({ chain, transport: http(args.rpcUrl) });
  return {
    async send({ to, data }) {
      try {
        // An explicit limit with the keeper's headroom: a bare estimate trips the engine's out-of-gas guard.
        const estimate = await client.estimateGas({ to, data, account: args.account });
        const txHash = await wallet.sendTransaction({ to, data, account: args.account, chain, gas: keeperGasLimit(estimate) });
        const receipt = await client.waitForTransactionReceipt({ hash: txHash, timeout: 60_000 });
        if (receipt.status !== "success") throw new ToolError("TX_REVERTED", "The AgentRouter refused the transaction.", { txHash });
        return { txHash };
      } catch (error) {
        if (error instanceof ToolError) throw error;
        // Never echo the underlying message: viem errors can embed the RPC URL.
        throw new ToolError("TX_FAILED", "The transaction could not be sent or was refused by the AgentRouter.");
      }
    },
  };
}

export interface AgentRuntime {
  readonly account: LocalAccount;
  readonly owner: Address | undefined;
  readonly router: Address | undefined;
  readonly policy: PolicyReader;
  readonly executor: Executor;
  /** Set false only in tests that must reach the chain-side rules. */
  readonly clientSideChecks: boolean;
  readonly now: () => number;
}

export function createAgentRuntime(args: {
  key: Hex; owner?: Address | undefined; router?: Address | undefined; policy: PolicyReader; executor: (account: LocalAccount) => Executor;
  clientSideChecks?: boolean; now?: () => number;
}): AgentRuntime {
  const account = privateKeyToAccount(args.key);
  return {
    account, owner: args.owner ? getAddress(args.owner) : undefined, router: args.router ? getAddress(args.router) : undefined,
    policy: args.policy, executor: args.executor(account), clientSideChecks: args.clientSideChecks ?? true, now: args.now ?? Date.now,
  };
}
