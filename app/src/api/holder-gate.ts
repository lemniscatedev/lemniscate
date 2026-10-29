import type { MiddlewareHandler } from "hono";
import type { ApiDependencies } from "./types";
import { holderLevel, thresholdsOf } from "../db/queries/holders";
import { bearerToken, sessionSecret, verifyHolderSession } from "../holders/session";
import { meetsTier, minimumLmns, unlockText, type PerkLevel } from "../holders/tiers";

/** Server-side gate for $LMNS holder perks. The wallet comes from a holder session token (POST /v1/holder/session, one
 * signature), never from the request, so a perk cannot be opened by naming someone else's address. 401 without a valid
 * session, 403 below the level. Never put this on a core route (trade, deposit, withdraw, exit, safety). On success the
 * wallet is in context.get("holderAddress"). */
export function requireHolderTier(deps: ApiDependencies, level: PerkLevel): MiddlewareHandler {
  return async (context, next) => {
    context.header("Cache-Control", "private, no-store");
    const thresholds = thresholdsOf(deps);
    const required = { level, minimumLmns: minimumLmns(level, thresholds), message: unlockText(level, thresholds) };
    const token = bearerToken(context.req.header("Authorization"));
    const address = token ? verifyHolderSession(sessionSecret(deps.config.HOLDER_SESSION_SECRET), token, Math.floor(Date.now() / 1000)) : null;
    if (!address) return context.json({ error: "HOLDER_SESSION_REQUIRED", message: "Connect your wallet and sign in to check your $LMNS level.", required }, 401);
    const current = await holderLevel(deps, address);
    if (!meetsTier(current.tier, level)) {
      return context.json({ error: "HOLDER_TIER_REQUIRED", message: required.message, required, current }, 403);
    }
    context.set("holderAddress" as never, address as never);
    await next();
  };
}
