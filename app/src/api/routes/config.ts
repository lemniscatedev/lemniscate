import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import type { ApiDependencies } from "../types";
import { configResponseSchema } from "../schemas";
import { runtimeConfigResponse } from "../../db/queries/config";

const route = createRoute({
  method: "get",
  path: "/v1/config",
  tags: ["system"],
  responses: {
    200: { description: "Runtime chain and contract configuration", content: { "application/json": { schema: configResponseSchema } } },
  },
});

export function registerConfigRoutes(app: OpenAPIHono, deps: ApiDependencies): void {
  app.openapi(route, async (context) => context.json(await runtimeConfigResponse(deps), 200));
}
