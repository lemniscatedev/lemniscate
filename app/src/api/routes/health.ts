import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import type { ApiDependencies } from "../types";
import { healthResponseSchema } from "../schemas";
import { databaseDownHealth, healthResponse } from "../../db/queries/health";
import { safeErrorSummary } from "../../log";

const route = createRoute({
  method: "get",
  path: "/v1/health",
  tags: ["system"],
  responses: {
    200: { description: "Database, indexer, keeper and RPC health", content: { "application/json": { schema: healthResponseSchema } } },
  },
});

export function registerHealthRoutes(app: OpenAPIHono, deps: ApiDependencies): void {
  app.openapi(route, async (context) => {
    try {
      return context.json(await healthResponse(deps), 200);
    } catch (error) {
      deps.logger.warn({ err: safeErrorSummary(error) }, "Health query failed");
      return context.json(databaseDownHealth(), 200);
    }
  });
}
