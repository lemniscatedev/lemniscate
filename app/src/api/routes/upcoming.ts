import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import type { ApiDependencies } from "../types";
import {
  errorResponseSchema, signedBodySchema, subscribeResponseSchema,
  upcomingQuery, upcomingResponseSchema,
} from "../schemas";
import { upcomingMarketConfig } from "../../config/upcoming";
import { subscribeUpcoming, upcomingMarkets, unsubscribeUpcoming } from "../../db/queries/upcoming";
import { verifySignedAction } from "../signed-action";

const idParams = z.object({ id: z.string().regex(/^[a-z0-9]{2,16}$/) });

const listRoute = createRoute({
  method: "get", path: "/v1/upcoming", tags: ["markets"], request: { query: upcomingQuery },
  responses: { 200: { description: "Upcoming markets and subscription interest", content: { "application/json": { schema: upcomingResponseSchema } } } },
});

const writeRequest = {
  params: idParams,
  body: { required: true, content: { "application/json": { schema: signedBodySchema } } },
};
const subscribeRoute = createRoute({
  method: "post", path: "/v1/upcoming/{id}/subscribe", tags: ["markets"], request: writeRequest,
  responses: {
    200: { description: "Subscription updated", content: { "application/json": { schema: subscribeResponseSchema } } },
    400: { description: "Invalid request", content: { "application/json": { schema: errorResponseSchema } } },
    401: { description: "Signature check failed", content: { "application/json": { schema: errorResponseSchema } } },
    404: { description: "Unknown upcoming market", content: { "application/json": { schema: errorResponseSchema } } },
  },
});
const unsubscribeRoute = createRoute({
  method: "delete", path: "/v1/upcoming/{id}/subscribe", tags: ["markets"], request: writeRequest,
  responses: {
    200: { description: "Subscription updated", content: { "application/json": { schema: subscribeResponseSchema } } },
    400: { description: "Invalid request", content: { "application/json": { schema: errorResponseSchema } } },
    401: { description: "Signature check failed", content: { "application/json": { schema: errorResponseSchema } } },
    404: { description: "Unknown upcoming market", content: { "application/json": { schema: errorResponseSchema } } },
  },
});

function unauthorizedMessage(code: "BAD_SIGNATURE" | "EXPIRED" | "REPLAY"): string {
  if (code === "EXPIRED") return "Request expired.";
  if (code === "REPLAY") return "Request already used.";
  return "Signature check failed.";
}

export function registerUpcomingRoutes(app: OpenAPIHono, deps: ApiDependencies): void {
  app.openapi(listRoute, async (context) => {
    const { address } = context.req.valid("query");
    if (address) {
      context.header("Cache-Control", "private, no-store");
      return context.json(await upcomingMarkets(deps, address), 200);
    }
    context.header("Cache-Control", "public, max-age=15, stale-while-revalidate=60");
    const result = await deps.cache.getOrLoad("upcoming:list", 15_000, () => upcomingMarkets(deps));
    return context.json(result, 200);
  });

  app.openapi(subscribeRoute, async (context) => {
    context.header("Cache-Control", "no-store");
    const { id } = context.req.valid("param");
    const body = context.req.valid("json");
    if (!upcomingMarketConfig.some((item) => item.id === id)) {
      return context.json({ error: "NOT_FOUND", message: `Unknown upcoming market: ${id}` }, 404);
    }
    const verification = await verifySignedAction(deps, {
      action: "upcoming.subscribe", address: body.address, payload: { id }, nonce: body.nonce,
      issued: body.issued, expires: body.expires, signature: body.signature as `0x${string}`,
    });
    if (!verification.ok) return context.json({ error: "UNAUTHORIZED", message: unauthorizedMessage(verification.code) }, 401);
    return context.json({ id, ...await subscribeUpcoming(deps, id, body.address) }, 200);
  });

  app.openapi(unsubscribeRoute, async (context) => {
    context.header("Cache-Control", "no-store");
    const { id } = context.req.valid("param");
    const body = context.req.valid("json");
    if (!upcomingMarketConfig.some((item) => item.id === id)) {
      return context.json({ error: "NOT_FOUND", message: `Unknown upcoming market: ${id}` }, 404);
    }
    const verification = await verifySignedAction(deps, {
      action: "upcoming.unsubscribe", address: body.address, payload: { id }, nonce: body.nonce,
      issued: body.issued, expires: body.expires, signature: body.signature as `0x${string}`,
    });
    if (!verification.ok) return context.json({ error: "UNAUTHORIZED", message: unauthorizedMessage(verification.code) }, 401);
    return context.json({ id, ...await unsubscribeUpcoming(deps, id, body.address) }, 200);
  });
}
