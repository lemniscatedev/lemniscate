import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { OpenAPIHono } from "@hono/zod-openapi";
import { pino } from "pino";
import type { Address } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { applyMigrations, createTestDatabase, testDatabaseUrl, type TestDatabase } from "../../testing/db";
import { testDeployment } from "../../indexer/test-support";
import { createApiApp } from "../app";
import { TtlCache } from "../cache";
import { buildSignedMessage, canonicalPayloadHash } from "../signed-action";
import { requireHolderTier } from "../holder-gate";
import type { ApiDependencies } from "../types";
import { createHoldersJob } from "../../keeper/jobs/holders";
import type { KeeperContext } from "../../keeper/context";

const suite = testDatabaseUrl() ? describe : describe.skip;
const TOKEN = `0x${"1a".repeat(20)}`;
const lmns = (n: bigint) => n * 10n ** 18n;
let db: TestDatabase;
let config: Record<string, unknown>;
let deps: ApiDependencies;
let app: ReturnType<typeof createApiApp>;
let gated: OpenAPIHono;

const wallet = () => privateKeyToAccount(generatePrivateKey());
async function sessionFor(account: ReturnType<typeof wallet>): Promise<Response> {
  const address = account.address.toLowerCase();
  const nonce = Math.random().toString(36).slice(2).padEnd(24, "x");
  const issued = new Date(Date.now() - 1_000).toISOString();
  const expires = new Date(Date.now() + 5 * 60_000).toISOString();
  const signature = await account.signMessage({ message: buildSignedMessage({ action: "holder.session", address, payloadHash: canonicalPayloadHash({}), nonce, issued, expires }) });
  return app.request("/v1/holder/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address, nonce, issued, expires, signature }) });
}
async function setBalance(address: string, whole: bigint, ageSec = 0, token = TOKEN) {
  await db.sql`insert into holder_balances (address, token, balance, block_number, updated_at)
    values (${address.toLowerCase()}, ${token}, ${lmns(whole).toString()}, 1, now() - make_interval(secs => ${ageSec}))
    on conflict (address) do update set token = excluded.token, balance = excluded.balance, updated_at = excluded.updated_at`;
}
const level = async (address: string) => (await (await app.request(`/v1/holder/${address}`)).json()) as Record<string, unknown>;
const perk = (token: string | null, path: string) => gated.request(path, token ? { headers: { Authorization: `Bearer ${token}` } } : {});

suite("$LMNS holder perks", () => {
  beforeAll(async () => {
    db = (await createTestDatabase("holders"))!;
    await applyMigrations(db);
    config = {
      CORS_ORIGINS: [], API_RATE_LIMIT_PER_MINUTE: 0, API_CLIENT_IP_HEADER: "", NETWORK: "mainnet",
      LMNS_TOKEN_ADDRESS: "", LMNS_DECIMALS: 18, HOLDER_TIER_HOLDER_LMNS: 100_000, HOLDER_TIER_WHALE_LMNS: 1_000_000,
      HOLDER_BALANCE_TTL_SECONDS: 60, HOLDER_SYNC_MAX_WALLETS: 500, HOLDER_SESSION_SECRET: "t".repeat(64), HOLDER_SESSION_HOURS: 24,
    };
    deps = { sql: db.sql, config, deployment: testDeployment(), logger: pino({ level: "silent" }), cache: new TtlCache() } as unknown as ApiDependencies;
    app = createApiApp(deps);
    gated = new OpenAPIHono();
    gated.get("/perk/holder", requireHolderTier(deps, "holder"), (c) => c.json({ ok: true }));
    gated.get("/perk/whale", requireHolderTier(deps, "whale"), (c) => c.json({ ok: true }));
  });
  afterAll(async () => db.close());

  test("before token day: every wallet is locked and is told what to hold", async () => {
    config.LMNS_TOKEN_ADDRESS = "";
    const body = await level(wallet().address);
    expect(body.status).toBe("awaiting_token");
    expect(body.tier).toBe("none");
    expect((body.levels as { message: string }[]).map((l) => l.message)).toEqual(["Hold 100,000 $LMNS to unlock", "Hold 1,000,000 $LMNS to unlock"]);
    expect((body.perks as { unlocked: boolean }[]).some((p) => p.unlocked)).toBe(false);
  });

  test("token set, no reading yet: checking, locked, and the wallet is queued for the keeper", async () => {
    config.LMNS_TOKEN_ADDRESS = TOKEN;
    const who = wallet().address;
    const body = await level(who);
    expect(body.status).toBe("checking");
    expect(body.tier).toBe("none");
    expect((await db.sql`select 1 from holder_watch where address = ${who.toLowerCase()}`).length).toBe(1);
  });

  test("tier boundaries through the API: 99,999 / 100,000 / 1,000,000", async () => {
    config.LMNS_TOKEN_ADDRESS = TOKEN;
    const [a, b, c] = [wallet().address, wallet().address, wallet().address];
    await setBalance(a, 99_999n);
    await setBalance(b, 100_000n);
    await setBalance(c, 1_000_000n);
    expect((await level(a)).tier).toBe("none");
    expect((await level(b)).tier).toBe("holder");
    expect((await level(c)).tier).toBe("whale");
  });

  test("a stale or other-token reading fails closed (locked)", async () => {
    config.LMNS_TOKEN_ADDRESS = TOKEN;
    const stale = wallet().address;
    await setBalance(stale, 5_000_000n, 600);
    expect(await level(stale)).toMatchObject({ status: "checking", tier: "none" });
    const other = wallet().address;
    await setBalance(other, 5_000_000n, 0, `0x${"2b".repeat(20)}`);
    expect(await level(other)).toMatchObject({ status: "checking", tier: "none" });
  });

  test("gate: no session 401, below level 403 with the unlock text, at level 200", async () => {
    config.LMNS_TOKEN_ADDRESS = TOKEN;
    expect((await perk(null, "/perk/holder")).status).toBe(401);
    const account = wallet();
    const session = await sessionFor(account);
    expect(session.status).toBe(200);
    const { token } = await session.json() as { token: string };
    await setBalance(account.address, 50_000n);
    const denied = await perk(token, "/perk/holder");
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ error: "HOLDER_TIER_REQUIRED", message: "Hold 100,000 $LMNS to unlock" });
    await setBalance(account.address, 100_000n);
    expect((await perk(token, "/perk/holder")).status).toBe(200);
    expect((await perk(token, "/perk/whale")).status).toBe(403);
    await setBalance(account.address, 1_000_000n);
    expect((await perk(token, "/perk/whale")).status).toBe(200);
  });

  test("a session cannot be minted for someone else's address, and a token cannot be edited", async () => {
    const whale = wallet();
    await setBalance(whale.address, 2_000_000n);
    const thief = wallet();
    const address = whale.address.toLowerCase();
    const nonce = "z".repeat(24);
    const issued = new Date(Date.now() - 1_000).toISOString();
    const expires = new Date(Date.now() + 60_000).toISOString();
    const signature = await thief.signMessage({ message: buildSignedMessage({ action: "holder.session", address, payloadHash: canonicalPayloadHash({}), nonce, issued, expires }) });
    const forged = await app.request("/v1/holder/session", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ address, nonce, issued, expires, signature }) });
    expect(forged.status).toBe(401);
    const { token } = await (await sessionFor(thief)).json() as { token: string };
    const edited = token.replace(thief.address.toLowerCase(), address);
    expect((await perk(edited, "/perk/whale")).status).toBe(401);
  });

  test("keeper job: idle without a token; reads due wallets; a failed read leaves the wallet locked", async () => {
    const reads: string[] = [];
    const ctx = {
      sql: db.sql, config, logger: pino({ level: "silent" }),
      clients: { stateClient: { getBlockNumber: async () => 77n } },
    } as unknown as KeeperContext;
    config.LMNS_TOKEN_ADDRESS = "";
    expect(await createHoldersJob(ctx, async () => 0n)()).toMatchObject({ idle: true });
    config.LMNS_TOKEN_ADDRESS = TOKEN;
    const ok = wallet().address.toLowerCase();
    const broken = wallet().address.toLowerCase();
    await db.sql`insert into holder_watch (address) values (${ok}), (${broken}) on conflict do nothing`;
    const result = await createHoldersJob(ctx, async (_token, who: Address) => {
      reads.push(who);
      if (who === broken) throw new Error("rpc down");
      return lmns(250_000n);
    })();
    expect(result).toMatchObject({ idle: false });
    expect(reads).toContain(ok);
    expect((await level(ok)).tier).toBe("holder");
    expect((await level(broken)).tier).toBe("none");
    const rows = await db.sql`select block_number::text as b from holder_balances where address = ${ok}`;
    expect(rows[0]!.b).toBe("77");
    const again: string[] = [];
    await createHoldersJob(ctx, async (_t, who: Address) => { again.push(who); return 0n; })();
    expect(again).not.toContain(ok);
  });

});
