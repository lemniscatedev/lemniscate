import { createRoute, type OpenAPIHono } from "@hono/zod-openapi";
import type { Address } from "viem";
import type { ApiDependencies } from "../types";
import { apiNow } from "../clock";
import {
  accountParams, activityQuery, activityResponseSchema, agentsResponseSchema, apiErrorSchema, smartAccountQuery,
  smartAccountResponseSchema,
} from "../option-schemas";
import {
  accountActivity, accountSeenOnChain, decodeCursor, encodeCursor, ownerAgentPolicies, ownerAgentTrades,
} from "../../db/queries/activity";
import { trimDecimal } from "../quote/rows";
import { usdgMicro, usdgText } from "../quote/model";
import { AaConfigError, loadAaConfig } from "../../aa/config";
import { KERNEL_V33_IMPLEMENTATION, predictKernelAddressOffline } from "../../aa/counterfactual";
import { optionalEnv } from "../../config";

const trim = (value: string | null): string | null => (value === null ? null : trimDecimal(value));

const activityRoute = createRoute({
  method: "get", path: "/v1/accounts/{address}/activity", tags: ["accounts"],
  request: { params: accountParams, query: activityQuery },
  responses: {
    200: { description: "Trades, shields, queued sells, pool deposits and withdrawals, and agent trades, newest first", content: { "application/json": { schema: activityResponseSchema } } },
    400: { description: "Bad cursor", content: { "application/json": { schema: apiErrorSchema } } },
  },
});

const agentsRoute = createRoute({
  method: "get", path: "/v1/accounts/{address}/agents", tags: ["accounts"], request: { params: accountParams },
  responses: { 200: { description: "Agent policies the account set on the AgentRouter, with each agent's indexed trades", content: { "application/json": { schema: agentsResponseSchema } } } },
});

const smartAccountRoute = createRoute({
  method: "get", path: "/v1/accounts/{address}/smart-account", tags: ["accounts"],
  request: { params: accountParams, query: smartAccountQuery },
  responses: {
    200: { description: "The Kernel v3.3 smart account address of an owner (computed locally, no RPC)", content: { "application/json": { schema: smartAccountResponseSchema } } },
    503: { description: "Smart accounts are not configured", content: { "application/json": { schema: apiErrorSchema } } },
  },
});

export function registerAccountActivityRoutes(app: OpenAPIHono, deps: ApiDependencies): void {
  app.openapi(activityRoute, async (context) => {
    context.header("Cache-Control", "private, no-store");
    const { address } = context.req.valid("param");
    const { limit, cursor } = context.req.valid("query");
    const decoded = cursor === undefined ? null : decodeCursor(cursor);
    if (cursor !== undefined && !decoded) return context.json({ error: "BAD_REQUEST", message: "Invalid cursor." }, 400);
    const { items, next } = await accountActivity(deps, address, { limit, cursor: decoded });
    return context.json({
      account: address,
      items: items.map((item) => ({ ...item, strike: trim(item.strike), usdg: trim(item.usdg), amount: trim(item.amount) })),
      nextCursor: next ? encodeCursor(next) : null,
    }, 200);
  });

  app.openapi(agentsRoute, async (context) => {
    context.header("Cache-Control", "private, no-store");
    const { address } = context.req.valid("param");
    const now = await apiNow(deps);
    const [policies, { totals, recent }] = await Promise.all([ownerAgentPolicies(deps, address), ownerAgentTrades(deps, address)]);
    const agents = policies.map((policy) => {
      const remaining = usdgMicro(policy.budgetUsdg) - usdgMicro(totals.get(policy.agent)?.spentUsdg ?? "0");
      const expired = new Date(policy.expiresAt).getTime() <= now.getTime();
      return {
        agent: policy.agent,
        budgetUsdg: trimDecimal(policy.budgetUsdg),
        maxPerTradeUsdg: trimDecimal(policy.maxPerTradeUsdg),
        spentUsdg: trimDecimal(totals.get(policy.agent)?.spentUsdg ?? "0"),
        remainingBudgetUsdg: trimDecimal(usdgText(remaining > 0n ? remaining : 0n)),
        expiresAt: policy.expiresAt, allowedStocks: policy.allowedStocks, canSell: policy.canSell, canShield: policy.canShield, setAt: policy.setAt,
        revoked: policy.revoked, revokedAt: policy.revokedAt, expired, active: !policy.revoked && !expired,
        tradeCount: totals.get(policy.agent)?.trades ?? 0,
        recentTrades: (recent.get(policy.agent) ?? []).map((trade) => ({ ...trade, strike: trim(trade.strike), usdg: trimDecimal(trade.usdg) })),
      };
    });
    return context.json({ account: address, asOf: now.toISOString(), agents }, 200);
  });

  app.openapi(smartAccountRoute, async (context) => {
    context.header("Cache-Control", "private, no-store");
    const { address } = context.req.valid("param");
    const { index } = context.req.valid("query");
    let config;
    try {
      config = loadAaConfig();
    } catch (error) {
      if (!(error instanceof AaConfigError)) throw error;
      return context.json({ error: "AA_UNAVAILABLE", message: "Smart accounts are not configured on this server." }, 503);
    }
    const implementation = (optionalEnv("AA_KERNEL_IMPLEMENTATION") || KERNEL_V33_IMPLEMENTATION) as Address;
    const account = predictKernelAddressOffline(
      { factory: config.kernelFactory, validator: config.kernelValidator, implementation }, address as Address, index,
    ).toLowerCase();
    const seen = await accountSeenOnChain(deps, account);
    return context.json({
      owner: address, accountIndex: index, address: account, deployed: seen ? true : null, chainId: config.chainId,
      factory: config.kernelFactory, validator: config.kernelValidator, entryPoint: config.entryPoint,
    }, 200);
  });
}
