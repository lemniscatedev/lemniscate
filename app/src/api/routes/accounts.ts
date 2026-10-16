import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { ApiDependencies } from "../types";
import { accountStatsResponseSchema, activityQuery, activityResponseSchema, addressParams, exportQuery, portfolioResponseSchema } from "../schemas";
import { accountActivity, accountPortfolio } from "../../db/queries/accounts";
import { accountStats } from "../../db/queries/account-stats";
import { accountExport } from "../../db/queries/account-export";

const portfolioRoute = createRoute({
  method: "get", path: "/v1/accounts/{address}/portfolio", tags: ["accounts"], request: { params: addressParams },
  responses: { 200: { description: "Wallet positions, cost basis, and Writer Pool holdings", content: { "application/json": { schema: portfolioResponseSchema } } } },
});
const activityRoute = createRoute({
  method: "get", path: "/v1/accounts/{address}/activity", tags: ["accounts"], request: { params: addressParams, query: activityQuery },
  responses: { 200: { description: "Cursor-paginated wallet activity", content: { "application/json": { schema: activityResponseSchema } } } },
});
const statsRoute = createRoute({
  method: "get", path: "/v1/accounts/{address}/stats", tags: ["accounts"], request: { params: addressParams },
  responses: { 200: { description: "Lifetime trading statistics for a wallet", content: { "application/json": { schema: accountStatsResponseSchema } } } },
});
const exportRoute = createRoute({
  method: "get", path: "/v1/accounts/{address}/export.csv", tags: ["accounts"], request: { params: addressParams, query: exportQuery },
  responses: { 200: { description: "Complete wallet history as CSV", content: { "text/csv": { schema: z.string() } } } },
});

export function registerAccountRoutes(app: OpenAPIHono, deps: ApiDependencies): void {
  app.openapi(portfolioRoute, async (context) => {
    context.header("Cache-Control", "private, max-age=5");
    const { address } = context.req.valid("param");
    return context.json(await accountPortfolio(deps, address), 200);
  });
  app.openapi(activityRoute, async (context) => {
    context.header("Cache-Control", "private, max-age=5");
    const { address } = context.req.valid("param");
    const { type, cursor, limit } = context.req.valid("query");
    return context.json(await accountActivity(deps, address, type, cursor, limit), 200);
  });
  app.openapi(statsRoute, async (context) => {
    context.header("Cache-Control", "private, max-age=15");
    const { address } = context.req.valid("param");
    return context.json(await deps.cache.getOrLoad(`accounts:stats:${address}`, 10_000, () => accountStats(deps, address)), 200);
  });
  app.openapi(exportRoute, async (context) => {
    const { address } = context.req.valid("param");
    const { type, from, to } = context.req.valid("query");
    const result = await accountExport(deps, address, type, from, to);
    return context.body(result.csv, 200, {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="lemniscate-${address.slice(2, 8)}-${from ?? "start"}-${to ?? "today"}.csv"`,
      "Cache-Control": "private, no-store",
      "X-Lemniscate-History-Complete": String(result.historyComplete),
      "X-Lemniscate-Truncated": String(result.truncated),
    });
  });
}
