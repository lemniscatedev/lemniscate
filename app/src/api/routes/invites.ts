import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { isAddress } from "viem";
import type { ApiDependencies } from "../types";
import { errorResponseSchema, signedBodySchema } from "../schemas";
import { verifySignedAction } from "../signed-action";
import { invitesRequired, isApproved, redeemInvite } from "../../db/queries/invites";
import { isWellFormedInviteCode, normalizeInviteCode } from "../../lib/invite-code";

/**
 * Closed-beta invite codes (todo 33). Off-chain only: the contracts stay permissionless, and the only thing this gate
 * stops is the API building buy and shield calldata for a wallet that has not redeemed a code. Sells are never gated.
 */

export const INVITE_REQUIRED_MESSAGE = "Lemniscate is invite-only for now. Enter your invite code to start buying. Selling is always open.";

const statusQuery = z.object({
  address: z.string().refine((value) => isAddress(value, { strict: false }), "Invalid EVM address").transform((value) => value.toLowerCase()).optional(),
});
const statusResponse = z.object({ required: z.boolean(), approved: z.boolean().nullable() });
const redeemBody = signedBodySchema.extend({ code: z.string().min(4).max(40) });
const redeemResponse = z.object({ approved: z.literal(true), alreadyApproved: z.boolean() });

const statusRoute = createRoute({
  method: "get", path: "/v1/invites/status", tags: ["access"], request: { query: statusQuery },
  responses: { 200: { description: "Whether invites are required and whether the wallet is approved", content: { "application/json": { schema: statusResponse } } } },
});
const redeemRoute = createRoute({
  method: "post", path: "/v1/invites/redeem", tags: ["access"],
  request: { body: { required: true, content: { "application/json": { schema: redeemBody } } } },
  responses: {
    200: { description: "The wallet is approved", content: { "application/json": { schema: redeemResponse } } },
    400: { description: "Invalid request", content: { "application/json": { schema: errorResponseSchema } } },
    401: { description: "Signature check failed", content: { "application/json": { schema: errorResponseSchema } } },
    403: { description: "The code is not valid or has been used", content: { "application/json": { schema: errorResponseSchema } } },
  },
});

function unauthorizedMessage(code: "BAD_SIGNATURE" | "EXPIRED" | "REPLAY"): string {
  if (code === "EXPIRED") return "Request expired.";
  if (code === "REPLAY") return "Request already used.";
  return "Signature check failed.";
}

/** The signed payload both sides build: the normalized code. */
export function inviteRedeemPayload(code: string): { code: string } {
  return { code: normalizeInviteCode(code) };
}

/**
 * Null when the wallet may build a buy or shield intent, otherwise the 403 body. `owner` is the EOA that owns a smart
 * account in one-tap flows; either being approved is enough. Never call this for sells.
 */
export async function inviteGate(
  deps: ApiDependencies, wallets: readonly (string | undefined)[],
): Promise<{ error: "INVITE_REQUIRED"; message: string } | null> {
  if (!(await invitesRequired(deps))) return null;
  for (const wallet of wallets) {
    if (wallet && await isApproved(deps, wallet)) return null;
  }
  return { error: "INVITE_REQUIRED", message: INVITE_REQUIRED_MESSAGE };
}

export function registerInviteRoutes(app: OpenAPIHono, deps: ApiDependencies): void {
  app.openapi(statusRoute, async (context) => {
    context.header("Cache-Control", "private, no-store");
    const { address } = context.req.valid("query");
    const required = await invitesRequired(deps);
    const approved = address ? await isApproved(deps, address) : null;
    return context.json({ required, approved }, 200);
  });

  app.openapi(redeemRoute, async (context) => {
    context.header("Cache-Control", "no-store");
    const body = context.req.valid("json");
    if (!isWellFormedInviteCode(body.code)) {
      return context.json({ error: "INVALID_CODE", message: "That code is not valid or has already been used." }, 403);
    }
    const verification = await verifySignedAction(deps, {
      action: "invites.redeem", address: body.address, payload: inviteRedeemPayload(body.code), nonce: body.nonce,
      issued: body.issued, expires: body.expires, signature: body.signature as `0x${string}`,
    });
    if (!verification.ok) return context.json({ error: "UNAUTHORIZED", message: unauthorizedMessage(verification.code) }, 401);
    const result = await redeemInvite(deps, body.address, body.code);
    if (!result.ok) return context.json({ error: "INVALID_CODE", message: "That code is not valid or has already been used." }, 403);
    return context.json({ approved: true as const, alreadyApproved: result.alreadyApproved }, 200);
  });
}
