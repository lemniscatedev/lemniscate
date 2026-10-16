import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import type { ApiDependencies } from "../types";
import {
  correlationQuery, correlationResponseSchema, historyRangeQuery, hottestTokensQuery, hottestTokensSchema,
  statsHistoryResponseSchema, statsResponseSchema, volBoardResponseSchema,
} from "../schemas";
import { aggregateStats } from "../../db/queries/stats";
import { protocolHistory } from "../../db/queries/analytics";
import { apiNow } from "../clock";
import { allMarketVols, sortVolBoard } from "../../db/queries/vol";
import { hottestTokens } from "../../db/queries/token-flow";
import { listMarkets } from "../../db/queries/markets";
import { marketCorrelation, type CorrelationDays } from "../../db/queries/correlation";

const route = createRoute({
  method: "get", path: "/v1/stats", tags: ["markets"],
  responses: { 200: { description: "Aggregate market and vault statistics", content: { "application/json": { schema: statsResponseSchema } } } },
});

const historyRoute = createRoute({
  method: "get", path: "/v1/stats/history", tags: ["markets"], request: { query: historyRangeQuery },
  responses: { 200: { description: "Daily protocol history", content: { "application/json": { schema: statsHistoryResponseSchema } } } },
});

const correlationRoute = createRoute({
  method: "get", path: "/v1/stats/correlation", tags: ["markets"], request: { query: correlationQuery },
  responses: { 200: { description: "Hourly correlation matrix for launched market underlyings", content: { "application/json": { schema: correlationResponseSchema } } } },
});

const volRoute = createRoute({
  method: "get", path: "/v1/stats/vol", tags: ["markets"],
  responses: { 200: { description: "Markets ranked by carry relative to realized variance", content: { "application/json": { schema: volBoardResponseSchema } } } },
});

const hottestTokensRoute = createRoute({
  method: "get", path: "/v1/stats/token-flow", tags: ["markets"], request: { query: hottestTokensQuery },
  responses: { 200: { description: "Robinhood stock tokens ranked by today's mint and redeem flow", content: { "application/json": { schema: hottestTokensSchema } } } },
});

export function registerStatsRoutes(app: OpenAPIHono, deps: ApiDependencies): void {
  app.openapi(correlationRoute, async (context) => {
    context.header("Cache-Control", "public, max-age=300, stale-while-revalidate=900");
    const days = Number(context.req.valid("query").days) as CorrelationDays;
    const result = await marketCorrelation(deps, days);
    return context.json(result, 200);
  });

  app.openapi(hottestTokensRoute, async (context) => {
    context.header("Cache-Control", "public, max-age=5, stale-while-revalidate=30");
    const { limit } = context.req.valid("query");
    const now = await apiNow(deps);
    const result = await hottestTokens(deps, limit, now);
    return context.json(result, 200);
  });

  app.openapi(volRoute, async (context) => {
    context.header("Cache-Control", "public, max-age=5, stale-while-revalidate=30");
    const now = await apiNow(deps);
    const [all, registered] = await Promise.all([
      deps.cache.getOrLoad("vol:all", 600_000, () => allMarketVols(deps, now)),
      deps.cache.getOrLoad("markets:list", 3_000, () => listMarkets(deps)),
    ]);
    const launched = new Set(registered.filter((market) => market.launched).map((market) => market.symbol.toUpperCase()));
    const markets = sortVolBoard(all.filter((market) => launched.has(market.symbol.toUpperCase())))
      .map(({ history: _history, ...market }) => market);
    return context.json({ asOf: now.toISOString(), markets }, 200);
  });

  app.openapi(route, async (context) => {
    context.header("Cache-Control", "public, max-age=5, stale-while-revalidate=30");
    const stats = await deps.cache.getOrLoad("stats:all", 3_000, () => aggregateStats(deps));
    return context.json(stats, 200);
  });

  app.openapi(historyRoute, async (context) => {
    context.header("Cache-Control", "public, max-age=5, stale-while-revalidate=30");
    const { range } = context.req.valid("query");
    const [history, registered] = await Promise.all([
      deps.cache.getOrLoad(`stats:history:${range}`, 60_000, () => protocolHistory(deps, range)),
      deps.cache.getOrLoad("markets:list", 3_000, () => listMarkets(deps)),
    ]);
    const launched = new Set(registered.filter((market) => market.launched).map((market) => market.symbol.toUpperCase()));
    return context.json({ ...history, markets: history.markets.filter((market) => launched.has(market.symbol.toUpperCase())) }, 200);
  });
}
