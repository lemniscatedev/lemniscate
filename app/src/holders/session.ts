import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/** Holder sessions: a wallet signs once (a "holder-session" signed action) and gets a bearer token that names its address
 * for HOLDER_SESSION_HOURS. Gated routes read the address from the token, never from the request, so nobody can borrow a
 * whale's address to open its perks. The token is `<address>.<expiresSec>.<hmac>`; the secret is HOLDER_SESSION_SECRET
 * (or a random one per process when unset, which only means sessions end on restart). */

let fallbackSecret: string | undefined;

export function sessionSecret(configured: string): string {
  if (configured) return configured;
  fallbackSecret ??= randomBytes(32).toString("hex");
  return fallbackSecret;
}

function mac(secret: string, body: string): string {
  return createHmac("sha256", secret).update(body).digest("base64url");
}

export function issueHolderSession(secret: string, address: string, expiresSec: number): string {
  const body = `${address.toLowerCase()}.${expiresSec}`;
  return `${body}.${mac(secret, body)}`;
}

/** The address a valid, unexpired token names, or null. */
export function verifyHolderSession(secret: string, token: string, nowSec: number): string | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [address, expires, signature] = parts as [string, string, string];
  if (!/^0x[0-9a-f]{40}$/.test(address) || !/^\d{1,12}$/.test(expires)) return null;
  const expected = Buffer.from(mac(secret, `${address}.${expires}`));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  return Number(expires) > nowSec ? address : null;
}

export function bearerToken(header: string | undefined): string | null {
  const match = /^Bearer\s+(\S+)$/i.exec(header ?? "");
  return match ? match[1]! : null;
}
