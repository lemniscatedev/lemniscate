import { z } from "zod";
import type { Address, Hex } from "viem";
import { ToolError, type ApiClient } from "./api-client";
import { checkPolicy, encodeRouterCall, routerCallFromIntent, type AgentRuntime, type RouterCall } from "./agent";

export interface ToolContext {
  readonly api: ApiClient;
  /** Absent when AGENT_KEY is not configured: execution tools then answer READ_ONLY. */
  readonly agent: AgentRuntime | undefined;
  readonly defaultOwner: Address | undefined;
  readonly router: Address | undefined;
}

export interface ToolDefinition<T extends z.ZodObject = z.ZodObject> {
  readonly name: string;
  readonly description: string;
  readonly input: T;
  readonly execution: boolean;
  run(context: ToolContext, args: z.infer<T>): Promise<unknown>;
}

const defineTool = <T extends z.ZodObject>(tool: ToolDefinition<T>): ToolDefinition<T> => tool;

const hex32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/).describe("Series id (bytes32 hex) from lmns_chain.");
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const units = z.string().regex(/^\d{1,18}(\.\d{1,18})?$/).describe("Option units as a decimal string, for example \"2.5\".");
const name = z.string().regex(/^[A-Za-z0-9.]{1,12}$/).describe("Ticker such as NVDA, TSLA, SPY or QQQ.");
const slippageBps = z.number().int().min(0).max(1_000).optional().describe("Allowed price move in basis points. Default 50.");
const deadlineSeconds = z.number().int().min(30).max(3_600).optional().describe("Seconds the order stays valid. Default 300.");
const owner = address.optional().describe("Account the position belongs to. Defaults to the configured owner.");

const defined = <T extends Record<string, unknown>>(value: T): Record<string, unknown> =>
  Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined));

function requireAgent(context: ToolContext): AgentRuntime {
  if (!context.agent) {
    throw new ToolError("READ_ONLY", "This server has no agent key, so it can quote and read but not trade. Set AGENT_KEY and an owner policy to enable trading.");
  }
  return context.agent;
}

async function resolveRouter(context: ToolContext, agent: AgentRuntime): Promise<Address> {
  if (agent.router ?? context.router) return (agent.router ?? context.router) as Address;
  const config = await context.api.get("/v1/config") as { contracts?: Record<string, string> };
  const found = config.contracts?.agentRouter;
  if (!found) throw new ToolError("NO_ROUTER", "No AgentRouter address is configured for this deployment.");
  return found as Address;
}

interface Intent { data: Hex; quote: { usdg: string }; maxCostUsdg?: string; minProceedsUsdg?: string; deadline: number; series: string; display?: unknown; note?: string | null; queued?: boolean }

async function execute(
  context: ToolContext, kind: "buy" | "sell" | "shield", path: string, body: Record<string, unknown>, ownerArg: string | undefined,
): Promise<unknown> {
  const agent = requireAgent(context);
  const ownerAddress = (ownerArg ?? agent.owner ?? context.defaultOwner) as Address | undefined;
  if (!ownerAddress) throw new ToolError("OWNER_REQUIRED", "No owner account is configured. Set AGENT_OWNER or pass owner.");
  const intent = await context.api.post(path, { ...body, account: ownerAddress }) as Intent;
  let stock: Address | undefined;
  if (kind !== "shield") {
    const series = await context.api.get(`/v1/series/${intent.series}?history=0`) as { stock?: string };
    stock = series.stock as Address | undefined;
  }
  const call: RouterCall = routerCallFromIntent(kind, intent, ownerAddress, stock);
  if (agent.clientSideChecks) {
    const refusal = checkPolicy(await agent.policy.read(ownerAddress, agent.account.address), call, Math.floor(agent.now() / 1000));
    if (refusal) throw refusal;
  }
  const router = await resolveRouter(context, agent);
  const { txHash } = await agent.executor.send({ to: router, data: encodeRouterCall(call) });
  if (call.kind !== "sell") agent.policy.recordSpend?.(ownerAddress, call.expectedUsdg);
  return defined({
    action: kind, status: "sent", txHash, router, owner: ownerAddress, agent: agent.account.address, series: intent.series,
    expectedUsdg: intent.quote.usdg, maxCostUsdg: intent.maxCostUsdg, minProceedsUsdg: intent.minProceedsUsdg,
    deadline: intent.deadline, queued: intent.queued, display: intent.display, note: intent.note ?? undefined,
  });
}

const chain = defineTool({
  name: "lmns_chain",
  description: "List names with listed options, or read one name's option chain: strike grid per Daily or Weekly speed with bid, ask, daily cost in USDG, breakeven and Greeks per option unit. Read only.",
  input: z.object({ name: name.optional().describe("Omit to list the names."), speed: z.enum(["DAILY", "WEEKLY"]).optional() }).strict(),
  execution: false,
  async run(context, args) {
    if (!args.name) return context.api.get("/v1/chains");
    const result = await context.api.get(`/v1/chains/${encodeURIComponent(args.name.toUpperCase())}`) as { speeds?: Array<{ speed: string }> };
    return args.speed && result.speeds ? { ...result, speeds: result.speeds.filter((s) => s.speed === args.speed) } : result;
  },
});

const quote = defineTool({
  name: "lmns_quote",
  description: "Price a buy or a sell of an option series in USDG: total, fee, daily cost, breakeven, volatility used and why a buy might be blocked. Read only.",
  input: z.object({ series: hex32, units, side: z.enum(["buy", "sell"]) }).strict(),
  execution: false,
  run: (context, args) => context.api.post("/v1/quote", args),
});

const buy = defineTool({
  name: "lmns_buy",
  description: "Buy option units for the owner through the AgentRouter, within the owner's agent policy (budget, expiry, allowed names). Tokens go to the owner, never to the agent. Needs AGENT_KEY.",
  input: z.object({ series: hex32, units, slippageBps, deadlineSeconds, owner }).strict(),
  execution: true,
  run: (context, args) => execute(context, "buy", "/v1/intent/buy", defined({ series: args.series, units: args.units, slippageBps: args.slippageBps, deadlineSeconds: args.deadlineSeconds }), args.owner),
});

const sell = defineTool({
  name: "lmns_sell",
  description: "Sell option units the owner holds through the AgentRouter. Allowed only when the owner's policy lets the agent sell; proceeds go to the owner. During a halt the sell queues until a fresh price. Needs AGENT_KEY.",
  input: z.object({ series: hex32, units, slippageBps, deadlineSeconds, owner }).strict(),
  execution: true,
  run: (context, args) => execute(context, "sell", "/v1/intent/sell", defined({ series: args.series, units: args.units, slippageBps: args.slippageBps, deadlineSeconds: args.deadlineSeconds }), args.owner),
});

const shield = defineTool({
  name: "lmns_shield",
  description: "Protect Stock Tokens the owner holds with a Weekly Down option at a chosen level below the price, through the AgentRouter. Allowed only when the owner's policy lets the agent use Shield. Needs AGENT_KEY.",
  input: z.object({
    name, tokenUnits: units.describe("Stock Token amount to protect, decimal string."),
    strikePctBelowBps: z.number().int().min(100).max(5_000).optional().describe("How far below the price to protect, in basis points. Default 1000."),
    slippageBps, deadlineSeconds, owner,
  }).strict(),
  execution: true,
  run: (context, args) => execute(context, "shield", "/v1/intent/shield", defined({
    name: args.name, tokenUnits: args.tokenUnits, strikePctBelowBps: args.strikePctBelowBps, slippageBps: args.slippageBps, deadlineSeconds: args.deadlineSeconds,
  }), args.owner),
});

const positions = defineTool({
  name: "lmns_positions",
  description: "Open positions of an account: units after funding, value at bid, today's cost, cost basis and profit or loss. Read only.",
  input: z.object({ owner }).strict(),
  execution: false,
  async run(context, args) {
    const target = args.owner ?? context.agent?.owner ?? context.defaultOwner;
    if (!target) throw new ToolError("OWNER_REQUIRED", "Pass owner, or set AGENT_OWNER.");
    return context.api.get(`/v1/accounts/${target}/positions`);
  },
});

const pool = defineTool({
  name: "lmns_pool",
  description: "Writer Pool state: NAV, exposure per name, stress, caps usage and queue size. Read only.",
  input: z.object({}).strict(),
  execution: false,
  run: (context) => context.api.get("/v1/pool"),
});

export const TOOLS: readonly ToolDefinition<any>[] = [chain, quote, buy, sell, shield, positions, pool];
export const TOOL_NAMES = TOOLS.map((t) => t.name);
