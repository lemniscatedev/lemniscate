import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { z } from "@hono/zod-openapi";
import type { ApiDependencies } from "../types";
import { corpActionsSchema } from "../schemas";
import { corporateActions } from "../../db/queries/corp-actions";

const route = createRoute({
  method: "get", path: "/v1/corporate-actions", tags: ["markets"],
  request: { query: z.object({ symbol: z.string().min(1).max(16).transform((value) => value.toUpperCase()).optional() }) },
  responses: { 200: { description: "Upcoming and recent corporate actions", content: { "application/json": { schema: corpActionsSchema } } } },
});

export function registerCorporateActionRoutes(app: OpenAPIHono, deps: ApiDependencies): void {
  app.openapi(route, async (context) => {
    context.header("Cache-Control", "public, max-age=30, stale-while-revalidate=60");
    const { symbol } = context.req.valid("query");
    const key = `corp-actions:${symbol ?? "all"}`;
    const actions = await deps.cache.getOrLoad(key, 30_000, () => corporateActions(deps, symbol));
    return context.json(actions, 200);
  });
}
