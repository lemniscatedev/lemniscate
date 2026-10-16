import { createHash } from "node:crypto";
import { recoverMessageAddress } from "viem";
import type { ApiDependencies } from "./types";

export interface SignedFields {
  action: string;
  address: string;
  payloadHash: string;
  nonce: string;
  issued: string;
  expires: string;
}

export interface VerifySignedActionInput {
  action: string;
  address: string;
  payload: unknown;
  nonce: string;
  issued: string;
  expires: string;
  signature: `0x${string}`;
}

let lastCleanup = 0;

function canonicalJson(value: unknown, inArray = false): string | undefined {
  if (value === null) return "null";
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item, true) ?? "null").join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record).sort().flatMap((key) => {
      const encoded = canonicalJson(record[key]);
      return encoded === undefined ? [] : [`${JSON.stringify(key)}:${encoded}`];
    });
    return `{${entries.join(",")}}`;
  }
  const encoded = JSON.stringify(value);
  return encoded === undefined && inArray ? "null" : encoded;
}

export function canonicalPayloadHash(body: unknown): string {
  const canonical = canonicalJson(body);
  if (canonical === undefined) throw new TypeError("Payload cannot be represented as JSON.");
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

export function buildSignedMessage(fields: SignedFields): string {
  return [
    "Lemniscate wants you to sign this message.",
    "",
    `Action: ${fields.action}`,
    `Address: ${fields.address.toLowerCase()}`,
    `Payload: ${fields.payloadHash}`,
    `Nonce: ${fields.nonce}`,
    `Issued: ${fields.issued}`,
    `Expires: ${fields.expires}`,
    "Chain: 4663",
  ].join("\n");
}

export async function verifySignedAction(
  deps: ApiDependencies,
  input: VerifySignedActionInput,
  nowMs = Date.now(),
): Promise<{ ok: true } | { ok: false; code: "BAD_SIGNATURE" | "EXPIRED" | "REPLAY" }> {
  const issuedMs = Date.parse(input.issued);
  const expiresMs = Date.parse(input.expires);
  if (!Number.isFinite(issuedMs) || !Number.isFinite(expiresMs)
    || issuedMs > nowMs + 60_000 || nowMs >= expiresMs
    || expiresMs <= issuedMs || expiresMs - issuedMs > 10 * 60_000) {
    return { ok: false, code: "EXPIRED" };
  }

  let message: string;
  let payloadHash: string;
  try {
    payloadHash = canonicalPayloadHash(input.payload);
    message = buildSignedMessage({ ...input, payloadHash });
  } catch {
    return { ok: false, code: "BAD_SIGNATURE" };
  }

  let signer: string;
  try {
    signer = await recoverMessageAddress({ message, signature: input.signature });
  } catch {
    return { ok: false, code: "BAD_SIGNATURE" };
  }
  if (signer.toLowerCase() !== input.address.toLowerCase()) return { ok: false, code: "BAD_SIGNATURE" };

  const cleanExpired = nowMs - lastCleanup > 60_000;
  if (cleanExpired) lastCleanup = nowMs;
  const inserted = await deps.sql.begin(async (tx) => {
    if (cleanExpired) await tx`delete from api_nonces where expires_at < now() - interval '1 day'`;
    return tx`
      insert into api_nonces (address, nonce, action, expires_at)
      values (${input.address.toLowerCase()}, ${input.nonce}, ${input.action}, ${input.expires}::timestamptz)
      on conflict do nothing
      returning nonce
    `;
  });
  return inserted.length > 0 ? { ok: true } : { ok: false, code: "REPLAY" };
}
