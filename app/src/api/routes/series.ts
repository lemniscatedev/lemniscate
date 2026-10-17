import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { ApiDependencies } from "../types";
import { apiNow } from "../clock";
import { apiErrorSchema, seriesParams, seriesResponseSchema } from "../option-schemas";
import { loadNameContext } from "../quote/context";
import { chainOption, trimDecimal } from "../quote/rows";
import { getSeries, normHistory } from "../../db/queries/series";

const route = createRoute({
  method: "get", path: "/v1/series/{id}", tags: ["markets"],
  request: { params: seriesParams, query: z.object({ history: z.coerce.number().int().min(0).max(1_000).default(100) }) },
  responses: {
    200: { description: "One series: terms, funding history and its current price per option unit", content: { "application/json": { schema: seriesResponseSchema } } },
    404: { description: "Unknown series", content: { "application/json": { schema: apiErrorSchema } } },
  },
});

export function registerSeriesRoutes(app: OpenAPIHono, deps: ApiDependencies): void {
  app.openapi(route, async (context) => {
    const { id } = context.req.valid("param");
    const { history } = context.req.valid("query");
    const series = await getSeries(deps, id);
    if (!series) return context.json({ error: "NOT_FOUND", message: "Unknown series." }, 404);
    context.header("Cache-Control", "public, max-age=2");
    // F41: bid, ask and Greeks are the paid /v1/chains data. With x402 on, they are withheld here from everyone but the
    // website's own server (which presents the internal token).
    const withOption = !deps.x402 || deps.x402.isInternal(context.req.header("x-lmns-internal"));
    const now = await apiNow(deps);
    const [ctx, points] = await Promise.all([
      series.name ? loadNameContext(deps, series.name, now) : null,
      history > 0 ? normHistory(deps, series.id, history) : [],
    ]);
    return context.json({
      id: series.id, name: series.name, stock: series.stock, isCall: series.isCall, speed: series.speed,
      tauSeconds: series.tauSeconds, strike: trimDecimal(series.strike), token: series.token, norm: trimDecimal(series.norm),
      lastAccrual: series.lastAccrual, buyable: series.buyable, archived: series.archived, listedAt: series.listedAt,
      option: ctx && withOption ? chainOption(series, ctx) : null,
      normHistory: points.map((point) => ({
        ts: point.ts, norm: trimDecimal(point.norm), vMark: trimDecimal(point.vMark), payoff: trimDecimal(point.payoff), session: point.session,
      })),
    }, 200);
  });
}
