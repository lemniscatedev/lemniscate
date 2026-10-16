import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import type { ApiDependencies } from "../types";
import { apiNow } from "../clock";
import { apiErrorSchema, nameParams, volResponseSchema } from "../option-schemas";
import { loadNameContext } from "../quote/context";
import { trimDecimal } from "../quote/rows";
import { volPostHistory } from "../../db/queries/market";
import type { Speed } from "../quote/model";

const route = createRoute({
  method: "get", path: "/v1/vol/{name}", tags: ["markets"], request: { params: nameParams },
  responses: {
    200: { description: "Volatility inputs and the latest posts with their expiry", content: { "application/json": { schema: volResponseSchema } } },
    404: { description: "Unknown name", content: { "application/json": { schema: apiErrorSchema } } },
  },
});

export function registerVolRoutes(app: OpenAPIHono, deps: ApiDependencies): void {
  const known = new Set(deps.deployment.stocks.map((entry) => entry.name));
  app.openapi(route, async (context) => {
    const { name } = context.req.valid("param");
    if (!known.has(name)) return context.json({ error: "NOT_FOUND", message: `Unknown name: ${name}` }, 404);
    context.header("Cache-Control", "public, max-age=5");
    const now = await apiNow(deps);
    const [ctx, history] = await Promise.all([loadNameContext(deps, name, now), volPostHistory(deps, name, 50)]);
    if (!ctx) return context.json({ error: "NOT_FOUND", message: `No price indexed yet for ${name}` }, 404);
    return context.json({
      name, asOf: ctx.tick.ts, spot: trimDecimal(ctx.tick.spot), session: ctx.tick.session,
      speeds: (["DAILY", "WEEKLY"] as Speed[]).map((speed) => {
        const post = ctx.vol[speed];
        const expiry = post ? new Date(post.validUntil).getTime() : 0;
        return {
          speed,
          latest: post
            ? {
              ...post,
              stale: ctx.nowMs > expiry,
              ageSeconds: Math.max(0, Math.round((ctx.nowMs - new Date(post.ts).getTime()) / 1_000)),
              secondsToExpiry: Math.round((expiry - ctx.nowMs) / 1_000),
            }
            : null,
        };
      }),
      history,
    }, 200);
  });
}
