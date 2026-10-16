import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import type { ApiDependencies } from "../types";
import { leaderboardQuery, leaderboardResponseSchema } from "../schemas";
import { traderRanking } from "../../db/queries/leaderboard";

const route = createRoute({
  method: "get", path: "/v1/leaderboard", tags: ["markets"], request: { query: leaderboardQuery },
  responses: { 200: { description: "Traders ranked by volume or trade count", content: { "application/json": { schema: leaderboardResponseSchema } } } },
});

export function registerLeaderboardRoutes(app: OpenAPIHono, deps: ApiDependencies): void {
  app.openapi(route, async (context) => {
    const { range, sort, limit, address } = context.req.valid("query");
    const all = await deps.cache.getOrLoad(`leaderboard:${range}:${sort}`, 60_000, () => traderRanking(deps, range, sort));
    context.header("Cache-Control", address ? "private, max-age=30" : "public, max-age=30, stale-while-revalidate=120");
    return context.json({ range, sort, totalTraders: all.length, rows: all.slice(0, limit),
      you: address ? all.find((row) => row.address === address) ?? null : null, generatedAt: new Date().toISOString() }, 200);
  });
}
