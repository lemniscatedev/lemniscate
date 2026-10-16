import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import type { ApiDependencies } from "../types";
import { apiNow } from "../clock";
import { apiErrorSchema, chainListSchema, chainResponseSchema, nameParams } from "../option-schemas";
import { loadNameContext, volAgeSeconds } from "../quote/context";
import { chainOption, trimDecimal, type ChainOption } from "../quote/rows";
import { TAU_SECONDS, type Speed } from "../quote/model";
import { listSeries, listedNames } from "../../db/queries/series";

const CHAIN_TTL_MS = 2_000;

const listRoute = createRoute({
  method: "get", path: "/v1/chains", tags: ["markets"],
  responses: { 200: { description: "Names with listed options", content: { "application/json": { schema: chainListSchema } } } },
});

const chainRoute = createRoute({
  method: "get", path: "/v1/chains/{name}", tags: ["markets"], request: { params: nameParams },
  responses: {
    200: { description: "Strike grid per speed: bid, ask, daily cost, breakeven and Greeks per option unit", content: { "application/json": { schema: chainResponseSchema } } },
    404: { description: "Unknown name", content: { "application/json": { schema: apiErrorSchema } } },
  },
});

export function registerChainRoutes(app: OpenAPIHono, deps: ApiDependencies): void {
  const known = new Set(deps.deployment.stocks.map((entry) => entry.name));

  app.openapi(listRoute, async (context) => {
    context.header("Cache-Control", "public, max-age=2");
    const names = await deps.cache.getOrLoad("chains:names", CHAIN_TTL_MS, () => listedNames(deps));
    return context.json({ names }, 200);
  });

  app.openapi(chainRoute, async (context) => {
    const { name } = context.req.valid("param");
    if (!known.has(name)) return context.json({ error: "NOT_FOUND", message: `Unknown name: ${name}` }, 404);
    context.header("Cache-Control", "public, max-age=2");
    const body = await deps.cache.getOrLoad(`chains:${name}`, CHAIN_TTL_MS, async () => {
      const now = await apiNow(deps);
      const [ctx, series] = await Promise.all([loadNameContext(deps, name, now), listSeries(deps, { name })]);
      if (!ctx) return null;
      const speeds = (["DAILY", "WEEKLY"] as Speed[]).map((speed) => {
        const rows = new Map<string, { strike: string; call: ChainOption | null; put: ChainOption | null }>();
        for (const item of series.filter((entry) => entry.speed === speed)) {
          const strike = trimDecimal(item.strike);
          const row = rows.get(strike) ?? { strike, call: null, put: null };
          const option = chainOption(item, ctx);
          if (item.isCall) row.call = option; else row.put = option;
          rows.set(strike, row);
        }
        const post = ctx.vol[speed];
        const spot = Number(ctx.tick.spot);
        const strikes = [...rows.values()]
          .sort((a, b) => Number(a.strike) - Number(b.strike))
          .map((row) => ({ ...row, moneynessPct: Number(((Number(row.strike) / spot - 1) * 100).toFixed(4)) }));
        return {
          speed, tauSeconds: TAU_SECONDS[speed], sigmaBps: post?.sigmaBps ?? null,
          volAgeSeconds: volAgeSeconds(post, ctx.nowMs), volStale: post ? ctx.nowMs > new Date(post.validUntil).getTime() : true,
          strikes,
        };
      });
      const buyable = speeds.some((s) => s.strikes.some((row) => row.call?.buyable || row.put?.buyable));
      return {
        name, spot: trimDecimal(ctx.tick.spot), session: ctx.tick.session, asOf: ctx.tick.ts,
        priceUpdatedAt: ctx.tick.priceUpdatedAt, buyable, units: "1" as const, speeds,
      };
    });
    if (!body) return context.json({ error: "NOT_FOUND", message: `No price indexed yet for ${name}` }, 404);
    return context.json(body, 200);
  });
}
