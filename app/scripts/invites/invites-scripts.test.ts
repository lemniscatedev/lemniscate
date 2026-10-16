import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pino } from "pino";
import { applyMigrations, createTestDatabase, testDatabaseUrl, type TestDatabase } from "../../src/testing/db";
import { testDeployment } from "../../src/indexer/test-support";
import { createApiApp } from "../../src/api/app";
import { TtlCache } from "../../src/api/cache";
import type { ApiDependencies } from "../../src/api/types";
import { hashInviteCode } from "../../src/lib/invite-code";

const suite = testDatabaseUrl() ? describe : describe.skip;
const here = import.meta.dir;
let db: TestDatabase;
let server: ReturnType<typeof Bun.serve>;
let dir: string;

async function run(script: string, args: string[]) {
  const url = new URL(testDatabaseUrl()!);
  url.pathname = `/${db.name}`;
  // Async on purpose: the API under test runs in this process and must keep serving while the script runs.
  const proc = Bun.spawn(["bun", "run", join(here, script), ...args], { env: { ...process.env, DATABASE_URL: url.toString() }, stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code: proc.exitCode, out: out + err };
}
const state = async () => (await db.sql`select value from app_settings where key = 'invites_required'`)[0]?.value ?? null;

suite("invite scripts (todo 33)", () => {
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "lmns-invites-"));
    db = (await createTestDatabase("invscripts"))!;
    await applyMigrations(db);
    const app = createApiApp({
      sql: db.sql, config: { CORS_ORIGINS: [], API_RATE_LIMIT_PER_MINUTE: 0, API_CLIENT_IP_HEADER: "", NETWORK: "mainnet", INVITES_REQUIRED: false },
      deployment: testDeployment(), logger: pino({ level: "silent" }), cache: new TtlCache(),
    } as unknown as ApiDependencies);
    server = Bun.serve({ port: 0, fetch: app.fetch });
  });
  afterAll(async () => {
    server?.stop(true);
    rmSync(dir, { recursive: true, force: true });
    await db.close();
  });

  test("generate writes N unique codes, never prints them, never overwrites, never writes inside the repo", async () => {
    const file = join(dir, "codes.txt");
    const made = await run("generate.ts", [file, "--count", "25"]);
    expect(made.code).toBe(0);
    const lines = readFileSync(file, "utf8").trim().split("\n");
    expect(new Set(lines).size).toBe(25);
    for (const line of lines) expect(made.out.includes(line)).toBe(false);
    expect((await run("generate.ts", [file])).code).toBe(2);
    expect((await run("generate.ts", [join(here, "inside-repo.txt")])).code).toBe(2);
    expect(existsSync(join(here, "inside-repo.txt"))).toBe(false);
  });

  test("import hashes the codes and is idempotent", async () => {
    const file = join(dir, "codes.txt");
    expect((await run("import.ts", [file, "--label", "test"])).out).toContain("Imported 25 new code(s); 0 already present.");
    expect((await run("import.ts", [file])).out).toContain("Imported 0 new code(s); 25 already present.");
    const first = readFileSync(file, "utf8").split("\n")[0]!;
    const rows = await db.sql`select code_hash from invite_codes where code_hash = ${hashInviteCode(first)}`;
    expect(rows).toHaveLength(1);
    expect((await db.sql`select 1 from invite_codes where code_hash = ${first}`)).toHaveLength(0);
  });

  test("verify on, then off: both verified, existing approved wallets unaffected, probe leaves nothing behind", async () => {
    const file = join(dir, "codes.txt");
    await db.sql`insert into invite_redemptions (address, code_hash) values (${"0x" + "ab".repeat(20)}, 'x')`;
    const on = await run("verify.ts", ["on", "--api", `http://127.0.0.1:${server.port}`, "--codes", file]);
    expect(on.out).toContain("VERIFIED: invites are on.");
    expect(on.code).toBe(0);
    expect(await state()).toBe("1");
    const off = await run("verify.ts", ["off", "--api", `http://127.0.0.1:${server.port}`]);
    expect(off.out).toContain("VERIFIED: invites are off.");
    expect(off.code).toBe(0);
    expect(await state()).toBe("0");
    expect(await db.sql`select 1 from invite_codes where label = 'verify-probe'`).toHaveLength(0);
    expect(await db.sql`select 1 from invite_redemptions`).toHaveLength(1);
  });

  test("verify reverts to the previous state when a check fails", async () => {
    await db.sql`update app_settings set value = '0' where key = 'invites_required'`;
    const bad = join(dir, "missing.txt");
    await Bun.write(bad, "ZZZZ-ZZZZ-ZZZZ\n"); // never imported: "a code is refused"
    const failed = await run("verify.ts", ["on", "--api", `http://127.0.0.1:${server.port}`, "--codes", bad]);
    expect(failed.code).toBe(1);
    expect(failed.out).toContain("REVERTED");
    expect(await state()).toBe("0");
  });

  test("switch flips the setting and reports it", async () => {
    expect((await run("switch.ts", ["on"])).out).toContain("invites_required: on");
    expect((await run("switch.ts", ["off"])).out).toContain("invites_required: off");
    expect((await run("switch.ts", ["status"])).code).toBe(0);
  });
});
