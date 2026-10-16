import type { ApiDependencies } from "../../api/types";
import { asRows } from "../../api/types";
import { hashInviteCode } from "../../lib/invite-code";

export const INVITES_SETTING_KEY = "invites_required";

export type RedeemResult =
  | { ok: true; alreadyApproved: boolean }
  | { ok: false; code: "INVALID_CODE" };

/**
 * Whether the invite gate is on. The `app_settings` row wins (the operator flips it live); the INVITES_REQUIRED env
 * value is the default. If the database cannot be read the env value is used, so a database blip never turns the
 * gate on for sells (sells are not gated at all) and never changes what the operator configured.
 */
export async function invitesRequired(deps: Pick<ApiDependencies, "sql" | "config">): Promise<boolean> {
  const fallback = deps.config.INVITES_REQUIRED === true;
  try {
    const rows = asRows<{ value?: unknown }>(await deps.sql`select value from app_settings where key = ${INVITES_SETTING_KEY}`);
    const value = rows[0]?.value;
    if (value === "1") return true;
    if (value === "0") return false;
    return fallback;
  } catch {
    return fallback;
  }
}

export async function isApproved(deps: Pick<ApiDependencies, "sql">, address: string): Promise<boolean> {
  const rows = asRows(await deps.sql`select 1 as one from invite_redemptions where address = ${address.toLowerCase()}`);
  return rows.length > 0;
}

/**
 * Binds one use of a code to a wallet. Idempotent per wallet: a wallet that is already approved keeps its approval and
 * does not burn another code. The unknown, revoked and used-up cases are one answer so a guesser learns nothing.
 */
export async function redeemInvite(deps: Pick<ApiDependencies, "sql">, address: string, code: string): Promise<RedeemResult> {
  const wallet = address.toLowerCase();
  const hash = hashInviteCode(code);
  return deps.sql.begin(async (tx) => {
    const existing = asRows(await tx`select 1 as one from invite_redemptions where address = ${wallet}`);
    if (existing.length > 0) return { ok: true, alreadyApproved: true } as RedeemResult;
    const claimed = asRows(await tx`
      update invite_codes set uses = uses + 1
      where code_hash = ${hash} and revoked = false and uses < max_uses
      returning code_hash
    `);
    if (claimed.length === 0) return { ok: false, code: "INVALID_CODE" } as RedeemResult;
    const inserted = asRows(await tx`
      insert into invite_redemptions (address, code_hash) values (${wallet}, ${hash})
      on conflict (address) do nothing returning address
    `);
    if (inserted.length === 0) throw new Error("invite redemption raced");
    return { ok: true, alreadyApproved: false } as RedeemResult;
  }) as Promise<RedeemResult>;
}
