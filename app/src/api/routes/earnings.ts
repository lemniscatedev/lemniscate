import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import type { ApiDependencies } from "../types";
import { earningsQuery, earningsResponseSchema } from "../schemas";
import { attachEarningsMarkets, upcomingEarnings } from "../../db/queries/earnings";
import { listMarkets } from "../../db/queries/markets";

const route = createRoute({
  method: "get",
  path: "/v1/earnings",
  tags: ["markets"],
  request: { query: earningsQuery },
  responses: {
    200: {
      description: "Upcoming company earnings dates for Lemniscate markets",
      content: { "application/json": { schema: earningsResponseSchema } },
    },
  },
});

export function registerEarningsRoutes(app: OpenAPIHono, deps: ApiDependencies): void {
  app.openapi(route, async (context) => {
    context.header("Cache-Control", "public, max-age=300, stale-while-revalidate=3600");
    const { days } = context.req.valid("query");
    const response = await deps.cache.getOrLoad(`earnings:list:${days}`, 60_000, () => upcomingEarnings(deps, days));
    const markets = await deps.cache.getOrLoad("markets:list", 3_000, () => listMarkets(deps));
    return context.json({ ...response, items: attachEarningsMarkets(response.items, markets) }, 200);
  });
}
