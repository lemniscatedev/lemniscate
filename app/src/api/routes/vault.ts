import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { z } from "@hono/zod-openapi";
import type { ApiDependencies } from "../types";
import { vaultHistorySchema, vaultResponseSchema } from "../schemas";
import { vaultHistory, vaultSnapshot } from "../../db/queries/vault";

const cacheHeader = "public, max-age=5, stale-while-revalidate=30";
const vaultRoute = createRoute({
  method: "get", path: "/v1/vault", tags: ["vault"],
  responses: { 200: { description: "Vault NAV, utilization and hedge state", content: { "application/json": { schema: vaultResponseSchema } } } },
});
const historyRoute = createRoute({
  method: "get", path: "/v1/vault/history", tags: ["vault"],
  request: { query: z.object({ range: z.enum(["1W", "1M", "ALL"]).default("1W") }) },
  responses: { 200: { description: "Vault NAV history", content: { "application/json": { schema: vaultHistorySchema } } } },
});

export function registerVaultRoutes(app: OpenAPIHono, deps: ApiDependencies): void {
  app.openapi(vaultRoute, async (context) => {
    context.header("Cache-Control", cacheHeader);
    const value = await deps.cache.getOrLoad("vault:snapshot", 3_000, () => vaultSnapshot(deps));
    return context.json(value, 200);
  });
  app.openapi(historyRoute, async (context) => {
    context.header("Cache-Control", cacheHeader);
    const { range } = context.req.valid("query");
    const value = await deps.cache.getOrLoad(`vault:history:${range}`, 10_000, () => vaultHistory(deps, range));
    return context.json(value, 200);
  });
}
