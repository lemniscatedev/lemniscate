import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { z } from "@hono/zod-openapi";
import type { ApiDependencies } from "../types";
import {
  candleSchema, carrySchema, errorResponseSchema, limitQuery, marketDetailResponseSchema,
  marketCurvesResponseSchema, marketHoldersResponseSchema, marketTokenFlowQuery, marketTokenFlowSchema,
  marketVolSchema, marketListResponseSchema, backtestQuery, marketBacktestResponseSchema,
  regimeListSchema, rangeQuery, symbolParams, tradeListSchema,
} from "../schemas";
import { marketCandles, marketCarry, getMarketDetail, listMarkets, marketRegimes, marketTrades } from "../../db/queries/markets";
import { marketCurves } from "../../db/queries/curves";
import { marketBacktest } from "../../db/queries/backtest";
import { marketHolders } from "../../db/queries/holders";
import { marketTokenFlow } from "../../db/queries/token-flow";
import { dateValue, textValue } from "../types";

import { apiNow } from "../clock";
import { allMarketVols } from "../../db/queries/vol";
import { nextEarningsBySymbol } from "../../db/queries/earnings";

const cacheHeader = "public, max-age=5, stale-while-revalidate=30";
const marketListQuery = z.object({ include: z.enum(["upcoming"]).optional() });

const listRoute = createRoute({
  method: "get", path: "/v1/markets", tags: ["markets"],
  request: { query: marketListQuery },
  responses: { 200: { description: "Current market quotes and capacity", content: { "application/json": { schema: marketListResponseSchema } } } },
});
const detailRoute = createRoute({
  method: "get", path: "/v1/markets/{symbol}", tags: ["markets"],
  request: { params: symbolParams, query: marketListQuery },
  responses: {
    200: { description: "Market quote and configuration", content: { "application/json": { schema: marketDetailResponseSchema } } },
    404: { description: "Unknown market symbol", content: { "application/json": { schema: errorResponseSchema } } },
  },
});
const candlesRoute = createRoute({
  method: "get", path: "/v1/markets/{symbol}/candles", tags: ["markets"], request: { params: symbolParams, query: rangeQuery },
  responses: {
    200: { description: "OHLC candles", content: { "application/json": { schema: candleSchema } } },
    404: { description: "Unknown market symbol", content: { "application/json": { schema: errorResponseSchema } } },
  },
});
const carryRoute = createRoute({
  method: "get", path: "/v1/markets/{symbol}/carry", tags: ["markets"],
  request: { params: symbolParams, query: z.object({ range: z.enum(["1W", "1M", "ALL"]).default("1W") }) },
  responses: {
    200: { description: "Hourly carry and regime", content: { "application/json": { schema: carrySchema } } },
    404: { description: "Unknown market symbol", content: { "application/json": { schema: errorResponseSchema } } },
  },
});
const tradesRoute = createRoute({
  method: "get", path: "/v1/markets/{symbol}/trades", tags: ["markets"], request: { params: symbolParams, query: limitQuery },
  responses: {
    200: { description: "Recent market trades", content: { "application/json": { schema: tradeListSchema } } },
    404: { description: "Unknown market symbol", content: { "application/json": { schema: errorResponseSchema } } },
  },
});
const regimesRoute = createRoute({
  method: "get", path: "/v1/markets/{symbol}/regimes", tags: ["markets"], request: { params: symbolParams, query: limitQuery },
  responses: {
    200: { description: "Recent market regime changes", content: { "application/json": { schema: regimeListSchema } } },
    404: { description: "Unknown market symbol", content: { "application/json": { schema: errorResponseSchema } } },
  },
});
const holdersRoute = createRoute({
  method: "get", path: "/v1/markets/{symbol}/holders", tags: ["markets"], request: { params: symbolParams },
  responses: {
    200: { description: "Holder count, concentration and distribution", content: { "application/json": { schema: marketHoldersResponseSchema } } },
    404: { description: "Unknown market symbol", content: { "application/json": { schema: errorResponseSchema } } },
  },
});

const volRoute = createRoute({
  method: "get", path: "/v1/markets/{symbol}/vol", tags: ["markets"], request: { params: symbolParams },
  responses: {
    200: { description: "Realized and carry-implied market volatility", content: { "application/json": { schema: marketVolSchema } } },
    404: { description: "Unknown market symbol", content: { "application/json": { schema: errorResponseSchema } } },
  },
});

const curvesRoute = createRoute({
  method: "get", path: "/v1/markets/{symbol}/curves", tags: ["markets"], request: { params: symbolParams },
  responses: {
    200: { description: "Power curve payoff and fair carry comparison", content: { "application/json": { schema: marketCurvesResponseSchema } } },
    404: { description: "Unknown or unlaunched market symbol", content: { "application/json": { schema: errorResponseSchema } } },
  },
});

const tokenFlowRoute = createRoute({
  method: "get", path: "/v1/markets/{symbol}/flow", tags: ["markets"],
  request: { params: symbolParams, query: marketTokenFlowQuery },
  responses: {
    200: { description: "Daily Robinhood stock token flow", content: { "application/json": { schema: marketTokenFlowSchema } } },
    404: { description: "Unknown market symbol", content: { "application/json": { schema: errorResponseSchema } } },
  },
});

const backtestRoute = createRoute({
  method: "get", path: "/v1/markets/{symbol}/backtest", tags: ["markets"],
  request: { params: symbolParams, query: backtestQuery },
  responses: {
    200: { description: "Hypothetical market backtest", content: { "application/json": { schema: marketBacktestResponseSchema } } },
    404: { description: "Unknown market symbol", content: { "application/json": { schema: errorResponseSchema } } },
  },
});

function publicResponse(context: { header: (name: string, value: string) => void }): void {
  context.header("Cache-Control", cacheHeader);
}

export function registerMarketRoutes(app: OpenAPIHono, deps: ApiDependencies): void {
  app.openapi(tokenFlowRoute, async (context) => {
    context.header("Cache-Control", "public, max-age=60, stale-while-revalidate=120");
    const { symbol } = context.req.valid("param");
    const days = Number(context.req.valid("query").days) as 7 | 30;
    const now = await apiNow(deps);
    const flow = await deps.cache.getOrLoad(
      `markets:flow:${symbol}:${days}`,
      60_000,
      () => marketTokenFlow(deps, symbol, days, now),
    );
    if (!flow) return context.json({ error: "NOT_FOUND", message: `Unknown market symbol: ${symbol}` }, 404);
    return context.json(flow, 200);
  });

  app.openapi(volRoute, async (context) => {
    context.header("Cache-Control", "public, max-age=300, stale-while-revalidate=600");
    const { symbol } = context.req.valid("param");
    const now = await apiNow(deps);
    const all = await deps.cache.getOrLoad("vol:all", 600_000, () => allMarketVols(deps, now));
    const vol = all.find((market) => market.symbol.toUpperCase() === symbol.toUpperCase());
    if (!vol) return context.json({ error: "NOT_FOUND", message: `Unknown market symbol: ${symbol}` }, 404);
    return context.json({ ...vol, asOf: now.toISOString() }, 200);
  });

  app.openapi(curvesRoute, async (context) => {
    context.header("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
    const { symbol } = context.req.valid("param");
    const markets = await deps.cache.getOrLoad("markets:list", 3_000, () => listMarkets(deps));
    const visibleMarket = markets.find((market) => market.symbol.toUpperCase() === symbol && market.launched);
    if (!visibleMarket) return context.json({ error: "NOT_FOUND", message: `Unknown market symbol: ${symbol}` }, 404);

    const now = await apiNow(deps);
    const table = await deps.cache.getOrLoad(
      `markets:curves:${symbol}`,
      60_000,
      () => marketCurves(deps, symbol, now),
    );
    if (!table) return context.json({ error: "NOT_FOUND", message: `Unknown market symbol: ${symbol}` }, 404);
    return context.json(table, 200);
  });

  app.openapi(backtestRoute, async (context) => {
    context.header("Cache-Control", "public, max-age=60, stale-while-revalidate=300");
    const { symbol } = context.req.valid("param");
    const { days } = context.req.valid("query");
    const markets = await deps.cache.getOrLoad("markets:list", 3_000, () => listMarkets(deps));
    const visibleMarket = markets.find((market) => market.symbol.toUpperCase() === symbol && market.launched);
    if (!visibleMarket) return context.json({ error: "NOT_FOUND", message: `Unknown market symbol: ${symbol}` }, 404);

    const result = await deps.cache.getOrLoad(
      `markets:backtest:${symbol}:${days}`,
      60_000,
      () => marketBacktest(deps, symbol, days),
    );
    if (!result) return context.json({ error: "NOT_FOUND", message: `Unknown market symbol: ${symbol}` }, 404);
    return context.json(result, 200);
  });

  app.openapi(listRoute, async (context) => {
    publicResponse(context);
    const { include } = context.req.valid("query");
    const markets = await deps.cache.getOrLoad("markets:list", 3_000, () => listMarkets(deps));
    const visible = include === "upcoming" ? markets : markets.filter((market) => market.launched);
    const next = await deps.cache.getOrLoad("earnings:next", 60_000, () => nextEarningsBySymbol(deps));
    return context.json(visible.map(({ config: _config, stats: _stats, ...market }) => ({
      ...market,
      nextEarnings: next.get((market.underlying ?? market.symbol).toUpperCase()) ?? null,
    })), 200);
  });

  app.openapi(detailRoute, async (context) => {
    publicResponse(context);
    const { symbol } = context.req.valid("param");
    const { include } = context.req.valid("query");
    const market = await deps.cache.getOrLoad(`markets:detail:${symbol}`, 3_000, () => getMarketDetail(deps, symbol));
    if (!market || (!market.launched && include !== "upcoming")) {
      return context.json({ error: "NOT_FOUND", message: `Unknown market symbol: ${symbol}` }, 404);
    }
    const next = await deps.cache.getOrLoad("earnings:next", 60_000, () => nextEarningsBySymbol(deps));
    return context.json({
      ...market,
      nextEarnings: next.get((market.underlying ?? market.symbol).toUpperCase()) ?? null,
    }, 200);
  });

  app.openapi(candlesRoute, async (context) => {
    publicResponse(context);
    const { symbol } = context.req.valid("param");
    const { range, series } = context.req.valid("query");
    const candles = await deps.cache.getOrLoad(`markets:candles:${symbol}:${range}:${series}`, 10_000,
      () => marketCandles(deps, symbol, range, series));
    if (!candles) return context.json({ error: "NOT_FOUND", message: `Unknown market symbol: ${symbol}` }, 404);
    return context.json(candles, 200);
  });

  app.openapi(carryRoute, async (context) => {
    publicResponse(context);
    const { symbol } = context.req.valid("param");
    const { range } = context.req.valid("query");
    const points = await deps.cache.getOrLoad(`markets:carry:${symbol}:${range}`, 10_000, () => marketCarry(deps, symbol, range));
    if (!points) return context.json({ error: "NOT_FOUND", message: `Unknown market symbol: ${symbol}` }, 404);
    return context.json(points, 200);
  });

  app.openapi(tradesRoute, async (context) => {
    publicResponse(context);
    const { symbol } = context.req.valid("param");
    const { limit } = context.req.valid("query");
    const trades = await deps.cache.getOrLoad(`markets:trades:${symbol}:${limit}`, 3_000, () => marketTrades(deps, symbol, limit));
    if (!trades) return context.json({ error: "NOT_FOUND", message: `Unknown market symbol: ${symbol}` }, 404);
    return context.json(trades.map((row) => ({
      txHash: textValue(row.tx_hash),
      side: (textValue(row.side).toLowerCase() === "sell" ? "sell" : "buy") as "buy" | "sell",
      account: textValue(row.account),
      recipient: textValue(row.recipient),
      usdg: textValue(row.usdg),
      fee: textValue(row.fee),
      tokens: textValue(row.tokens),
      price: textValue(row.price),
      ts: dateValue(row.ts)?.toISOString() ?? "1970-01-01T00:00:00.000Z",
    })), 200);
  });

  app.openapi(regimesRoute, async (context) => {
    publicResponse(context);
    const { symbol } = context.req.valid("param");
    const { limit } = context.req.valid("query");
    const regimes = await deps.cache.getOrLoad(`markets:regimes:${symbol}:${limit}`, 3_000, () => marketRegimes(deps, symbol, limit));
    if (!regimes) return context.json({ error: "NOT_FOUND", message: `Unknown market symbol: ${symbol}` }, 404);
    const label = (value: unknown): "open" | "off_hours" | "paused" => {
      const parsed = Number(value);
      return parsed === 2 ? "paused" : parsed === 1 ? "off_hours" : "open";
    };
    return context.json(regimes.map((row) => ({
      txHash: textValue(row.tx_hash),
      from: label(row.from_regime),
      to: label(row.to_regime),
      ts: dateValue(row.ts)?.toISOString() ?? "1970-01-01T00:00:00.000Z",
    })), 200);
  });

  app.openapi(holdersRoute, async (context) => {
    context.header("Cache-Control", "public, max-age=30, stale-while-revalidate=120");
    const { symbol } = context.req.valid("param");
    const holders = await deps.cache.getOrLoad(`markets:holders:${symbol}`, 60_000, () => marketHolders(deps, symbol));
    if (!holders) return context.json({ error: "NOT_FOUND", message: `Unknown market symbol: ${symbol}` }, 404);
    return context.json(holders, 200);
  });
}
