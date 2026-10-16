import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { pino } from "pino";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { applyMigrations, createTestDatabase, testDatabaseUrl, type TestDatabase } from "../../testing/db";
import { testDeployment } from "../../indexer/test-support";
import { createApiApp } from "../app";
import { TtlCache } from "../cache";
import { buildSignedMessage, canonicalPayloadHash } from "../signed-action";
import type { ApiDependencies } from "../types";
import { generateInviteCode, hashInviteCode, normalizeInviteCode } from "../../lib/invite-code";

const suite = testDatabaseUrl() ? describe : describe.skip;
const SERIES = `0x${"00".repeat(31)}01`;
let db: TestDatabase;
let envRequired = false;
let app: ReturnType<typeof createApiApp>;

function post(path: string, body: unknown) {
  return app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}
const wallet = () => privateKeyToAccount(generatePrivateKey());
const buy = (account: string, owner?: string) => post("/v1/intent/buy", { series: SERIES, units: "1", account, ...(owner ? { owner } : {}) });
const sell = (account: string) => post("/v1/intent/sell", { series: SERIES, units: "1", account });
const shield = (account: string) => post("/v1/intent/shield", { name: "NVDA", tokenUnits: "1", account });
async function setting(value: "1" | "0" | null) {
  await db.sql`delete from app_settings where key = 'invites_required'`;
  if (value) await db.sql`insert into app_settings (key, value) values ('invites_required', ${value})`;
}
async function addCode(max = 1) {
  const code = generateInviteCode();
  await db.sql`insert into invite_codes (code_hash, max_uses) values (${hashInviteCode(code)}, ${max})`;
  return code;
}
async function redeemBody(account: ReturnType<typeof wallet>, code: string) {
  const address = account.address.toLowerCase();
  const nonce = Math.random().toString(36).slice(2).padEnd(24, "x");
  const issued = new Date(Date.now() - 1_000).toISOString();
  const expires = new Date(Date.now() + 5 * 60_000).toISOString();
  const payloadHash = canonicalPayloadHash({ code: normalizeInviteCode(code) });
  const signature = await account.signMessage({ message: buildSignedMessage({ action: "invites.redeem", address, payloadHash, nonce, issued, expires }) });
  return { address, nonce, issued, expires, signature, code };
}
const redeem = async (account: ReturnType<typeof wallet>, code: string) => post("/v1/invites/redeem", await redeemBody(account, code));

suite("invite codes (todo 33)", () => {
  beforeAll(async () => {
    db = (await createTestDatabase("invites"))!;
    await applyMigrations(db);
    const config = new Proxy({ CORS_ORIGINS: [], API_RATE_LIMIT_PER_MINUTE: 0, API_CLIENT_IP_HEADER: "", NETWORK: "mainnet" } as Record<string, unknown>, {
      get: (target, key) => key === "INVITES_REQUIRED" ? envRequired : target[key as string],
    });
    app = createApiApp({
      sql: db.sql, config, deployment: testDeployment(), logger: pino({ level: "silent" }), cache: new TtlCache(),
    } as unknown as ApiDependencies);
  });
  afterAll(async () => db.close());

  test("off: nobody is gated; status says so", async () => {
    await setting("0");
    const stranger = wallet().address;
    expect((await buy(stranger)).status).toBe(404); // unknown series, not 403
    const status = await (await app.request(`/v1/invites/status?address=${stranger}`)).json();
    expect(status).toEqual({ required: false, approved: false });
  });

  test("on: buy and shield refuse an unapproved wallet; sells are never gated", async () => {
    await setting("1");
    const stranger = wallet().address;
    for (const response of [await buy(stranger), await shield(stranger)]) {
      expect(response.status).toBe(403);
      expect((await response.json() as { error: string }).error).toBe("INVITE_REQUIRED");
    }
    expect((await sell(stranger)).status).toBe(404);
  });

  test("redeeming a code approves the wallet, the code is single use, and approval survives the gate flipping", async () => {
    await setting("1");
    const a = wallet(), b = wallet();
    const code = await addCode(1);
    const ok = await redeem(a, code.toLowerCase());
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ approved: true, alreadyApproved: false });
    expect((await buy(a.address)).status).toBe(404); // through the gate
    expect((await redeem(b, code)).status).toBe(403);
    expect((await buy(b.address)).status).toBe(403);
    // the same wallet again does not burn another code
    const again = await redeem(a, await addCode(1));
    expect(await again.json()).toEqual({ approved: true, alreadyApproved: true });
    await setting("0"); await setting("1");
    expect((await buy(a.address)).status).toBe(404);
  });

  test("a one-tap smart account passes when its owner is approved", async () => {
    await setting("1");
    const owner = wallet(), smart = wallet().address;
    expect((await buy(smart, owner.address)).status).toBe(403);
    await redeem(owner, await addCode());
    expect((await buy(smart, owner.address)).status).toBe(404);
    expect((await buy(smart)).status).toBe(403);
  });

  test("bad, unknown, revoked and reused-signature redemptions fail without learning anything", async () => {
    await setting("1");
    const a = wallet();
    expect((await redeem(a, "NOPE-NOPE-NOPE")).status).toBe(403);
    expect((await redeem(a, generateInviteCode())).status).toBe(403);
    const revoked = await addCode();
    await db.sql`update invite_codes set revoked = true where code_hash = ${hashInviteCode(revoked)}`;
    expect((await redeem(a, revoked)).status).toBe(403);
    const good = await addCode();
    const body = await redeemBody(wallet(), good);
    body.address = a.address.toLowerCase(); // signature is from another key
    expect((await post("/v1/invites/redeem", body)).status).toBe(401);
    const signed = await redeemBody(a, good);
    expect((await post("/v1/invites/redeem", signed)).status).toBe(200);
    expect((await post("/v1/invites/redeem", signed)).status).toBe(401); // nonce replay
    const { n } = (await db.sql`select count(*)::int as n from invite_redemptions where address = ${a.address.toLowerCase()}`)[0]!;
    expect(n).toBe(1);
  });

  test("two wallets racing for the last use of a code: exactly one wins", async () => {
    const code = await addCode(1);
    const results = await Promise.all(Array.from({ length: 6 }, () => redeem(wallet(), code)));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    const { uses } = (await db.sql`select uses from invite_codes where code_hash = ${hashInviteCode(code)}`)[0]!;
    expect(uses).toBe(1);
  });

  test("a code with several uses admits that many wallets", async () => {
    const code = await addCode(3);
    const statuses = [];
    for (let i = 0; i < 4; i++) statuses.push((await redeem(wallet(), code)).status);
    expect(statuses).toEqual([200, 200, 200, 403]);
  });

  test("the env value is the default when no runtime setting exists", async () => {
    await setting(null);
    envRequired = true;
    expect((await buy(wallet().address)).status).toBe(403);
    expect((await (await app.request("/v1/invites/status")).json() as { required: boolean }).required).toBe(true);
    envRequired = false;
    expect((await buy(wallet().address)).status).toBe(404);
    await setting("1"); // the runtime setting wins over the env default
    expect((await buy(wallet().address)).status).toBe(403);
  });

  test("the migration is additive: no existing table lost a column or a row", async () => {
    const rows = await db.sql`select table_name from information_schema.tables where table_schema='public' and table_name in ('invite_codes','invite_redemptions','app_settings')`;
    expect(rows).toHaveLength(3);
  });
});
