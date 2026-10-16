import { createHash } from "node:crypto";
import { expect, test } from "bun:test";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { ApiDependencies } from "./types";
import { buildSignedMessage, canonicalPayloadHash, verifySignedAction } from "./signed-action";

const NOW = Date.parse("2026-10-08T12:00:00.000Z");
const issued = "2026-10-08T12:00:00.000Z";
const expires = "2026-10-08T12:05:00.000Z";
const payload = { id: "spcx" };
const nonce = "Abcdefghijklmnop12345678";

function depsWith(inserted = true) {
  const queries: { query: string; values: unknown[] }[] = [];
  const transaction = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.join("?");
    queries.push({ query, values });
    return query.includes("insert into api_nonces") && inserted ? [{ nonce }] : [];
  };
  const sql = Object.assign(async () => [], {
    begin: async (callback: (tx: typeof transaction) => Promise<unknown>) => callback(transaction),
  });
  return {
    deps: { sql } as unknown as ApiDependencies,
    queries,
  };
}

function signedInput(address: string, signature: `0x${string}`) {
  return { action: "upcoming.subscribe", address, payload, nonce, issued, expires, signature };
}

test("buildSignedMessage has the canonical EIP-191 text and field order", () => {
  expect(buildSignedMessage({
    action: "upcoming.subscribe",
    address: "0xAbCd000000000000000000000000000000000001",
    payloadHash: "a".repeat(64),
    nonce,
    issued,
    expires,
  })).toBe([
    "Lemniscate wants you to sign this message.",
    "",
    "Action: upcoming.subscribe",
    "Address: 0xabcd000000000000000000000000000000000001",
    `Payload: ${"a".repeat(64)}`,
    `Nonce: ${nonce}`,
    `Issued: ${issued}`,
    `Expires: ${expires}`,
    "Chain: 4663",
  ].join("\n"));
});

test("canonicalPayloadHash sorts nested object keys and hashes compact JSON", () => {
  const expected = createHash("sha256").update('{"a":{"c":3,"d":2},"b":1}', "utf8").digest("hex");
  expect(canonicalPayloadHash({ b: 1, a: { d: 2, c: 3 } })).toBe(expected);
});

test("verifySignedAction accepts an in-memory EOA signature and consumes a nonce", async () => {
  const account = privateKeyToAccount(generatePrivateKey());
  const address = account.address.toLowerCase();
  const fields = { action: "upcoming.subscribe", address, payloadHash: canonicalPayloadHash(payload), nonce, issued, expires };
  const signature = await account.signMessage({ message: buildSignedMessage(fields) });
  const { deps, queries } = depsWith();

  expect(await verifySignedAction(deps, signedInput(address, signature), NOW)).toEqual({ ok: true });
  expect(queries.map((query) => query.query.trim().split(/\s+/).slice(0, 3).join(" "))).toEqual([
    "delete from api_nonces",
    "insert into api_nonces",
  ]);
  expect(queries[1]?.values).toEqual([address, nonce, "upcoming.subscribe", expires]);
});

test("verifySignedAction rejects the wrong signer", async () => {
  const signer = privateKeyToAccount(generatePrivateKey());
  const address = `0x${"b".repeat(40)}`;
  const fields = { action: "upcoming.subscribe", address, payloadHash: canonicalPayloadHash(payload), nonce, issued, expires };
  const signature = await signer.signMessage({ message: buildSignedMessage(fields) });
  const { deps, queries } = depsWith();

  expect(await verifySignedAction(deps, signedInput(address, signature), NOW)).toEqual({ ok: false, code: "BAD_SIGNATURE" });
  expect(queries).toEqual([]);
});

test("verifySignedAction rejects expired, future-issued, and overlong requests", async () => {
  const { deps, queries } = depsWith();
  const signature = `0x${"0".repeat(130)}` as `0x${string}`;

  expect(await verifySignedAction(deps, { ...signedInput(`0x${"a".repeat(40)}`, signature), issued: "2026-10-08T11:00:00.000Z", expires: "2026-10-08T11:59:00.000Z" }, NOW))
    .toEqual({ ok: false, code: "EXPIRED" });
  expect(await verifySignedAction(deps, { ...signedInput(`0x${"a".repeat(40)}`, signature), issued: "2026-10-08T12:01:01.000Z" }, NOW))
    .toEqual({ ok: false, code: "EXPIRED" });
  expect(await verifySignedAction(deps, { ...signedInput(`0x${"a".repeat(40)}`, signature), issued: "2026-10-08T11:50:00.000Z", expires: "2026-10-08T12:01:00.000Z" }, NOW))
    .toEqual({ ok: false, code: "EXPIRED" });
  expect(queries).toEqual([]);
});

test("verifySignedAction rejects a replay when the nonce insert conflicts", async () => {
  const account = privateKeyToAccount(generatePrivateKey());
  const address = account.address.toLowerCase();
  const fields = { action: "upcoming.subscribe", address, payloadHash: canonicalPayloadHash(payload), nonce, issued, expires };
  const signature = await account.signMessage({ message: buildSignedMessage(fields) });
  const { deps } = depsWith(false);

  expect(await verifySignedAction(deps, signedInput(address, signature), NOW)).toEqual({ ok: false, code: "REPLAY" });
});
