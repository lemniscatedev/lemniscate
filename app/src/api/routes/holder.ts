import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { isAddress } from "viem";
import type { ApiDependencies } from "../types";
import { errorResponseSchema, signedBodySchema } from "../schemas";
import { verifySignedAction } from "../signed-action";
import { holderLevel, thresholdsOf } from "../../db/queries/holders";
import { issueHolderSession, sessionSecret } from "../../holders/session";
import { perksFor, unlockText } from "../../holders/tiers";

/** $LMNS holder perks: a wallet's level (GET /v1/holder/{address}) and a holder session for gated routes
 * (POST /v1/holder/session, one signature). Reading the level needs no signature: it is public on chain anyway. */

const tierEnum = z.enum(["none", "holder", "whale"]);
const levelEnum = z.enum(["holder", "whale"]);

export const holderResponseSchema = z.object({
  token: z.object({ symbol: z.literal("LMNS"), address: z.string().nullable() }),
  status: z.enum(["awaiting_token", "checking", "ok"]),
  tier: tierEnum,
  balanceLmns: z.string().nullable(),
  updatedAt: z.string().nullable(),
  levels: z.array(z.object({ level: levelEnum, minimumLmns: z.number(), message: z.string() })),
  perks: z.array(z.object({ id: z.string(), name: z.string(), level: levelEnum, unlocked: z.boolean() })),
});

const params = z.object({
  address: z.string().refine((value) => isAddress(value, { strict: false }), "Invalid EVM address").transform((value) => value.toLowerCase()),
});
const sessionResponse = z.object({ token: z.string(), address: z.string(), expires: z.string() });

const levelRoute = createRoute({
  method: "get", path: "/v1/holder/{address}", tags: ["access"], request: { params },
  responses: { 200: { description: "The wallet's $LMNS holder level and what it unlocks", content: { "application/json": { schema: holderResponseSchema } } } },
});
const sessionRoute = createRoute({
  method: "post", path: "/v1/holder/session", tags: ["access"],
  request: { body: { required: true, content: { "application/json": { schema: signedBodySchema } } } },
  responses: {
    200: { description: "A holder session token for gated routes (Authorization: Bearer)", content: { "application/json": { schema: sessionResponse } } },
    401: { description: "Signature check failed", content: { "application/json": { schema: errorResponseSchema } } },
  },
});

export const HOLDER_SESSION_ACTION = "holder.session";

export function registerHolderRoutes(app: OpenAPIHono, deps: ApiDependencies): void {
  app.openapi(levelRoute, async (context) => {
    context.header("Cache-Control", "private, no-store");
    const { address } = context.req.valid("param");
    const level = await holderLevel(deps, address);
    const thresholds = thresholdsOf(deps);
    return context.json({
      token: { symbol: "LMNS" as const, address: deps.config.LMNS_TOKEN_ADDRESS || null },
      ...level,
      levels: (["holder", "whale"] as const).map((name) => ({
        level: name, minimumLmns: name === "whale" ? thresholds.whaleLmns : thresholds.holderLmns, message: unlockText(name, thresholds),
      })),
      perks: perksFor(level.tier),
    }, 200);
  });

  app.openapi(sessionRoute, async (context) => {
    context.header("Cache-Control", "no-store");
    const body = context.req.valid("json");
    const verification = await verifySignedAction(deps, {
      action: HOLDER_SESSION_ACTION, address: body.address, payload: {}, nonce: body.nonce,
      issued: body.issued, expires: body.expires, signature: body.signature as `0x${string}`,
    });
    if (!verification.ok) return context.json({ error: "UNAUTHORIZED", message: "Signature check failed." }, 401);
    const expiresSec = Math.floor(Date.now() / 1000) + deps.config.HOLDER_SESSION_HOURS * 3600;
    const address = body.address.toLowerCase();
    return context.json({
      token: issueHolderSession(sessionSecret(deps.config.HOLDER_SESSION_SECRET), address, expiresSec),
      address, expires: new Date(expiresSec * 1000).toISOString(),
    }, 200);
  });
}
