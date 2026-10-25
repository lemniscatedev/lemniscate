import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { decodeFunctionData, type Address, type Hex } from "viem";
import { createLogger } from "../../log";
import { applyMigrations, createTestDatabase, testDatabaseUrl, type TestDatabase } from "../../testing/db";
import type { KeeperContext } from "../context";
import { createKernelRegisterJob, KERNEL_REGISTER_ABI } from "./kernel-register";

const suite = testDatabaseUrl() ? describe : describe.skip;
const PAYMASTER = "0x00000000000000000000000000000000000000a7" as Address;
const addr = (n: number): Address => `0x${n.toString(16).padStart(40, "0")}` as Address;

suite("R17 (decision 62): the keeper registers queued standard Kernel accounts with the paymaster", () => {
  let db: TestDatabase;
  beforeAll(async () => { db = (await createTestDatabase("kernel_register"))!; await applyMigrations(db); });
  afterAll(async () => db.close());
  beforeEach(async () => { await db.sql`truncate kernel_registrations`; });

  function harness(known: Set<string>, failing = new Set<string>()) {
    const sent: { account: Address; initData: Hex; salt: Hex }[] = [];
    const context = {
      sql: db.sql,
      clients: { stateClient: { multicall: async (p: { contracts: { args: readonly unknown[] }[] }) =>
        p.contracts.map((c) => ({ status: "success", result: known.has(String(c.args[0]).toLowerCase()) })) } },
      config: { PAYMASTER_ADDRESS: PAYMASTER },
      logger: createLogger("silent"),
      tx: { submit: async (t: { to: Address; data: Hex }) => {
        expect(t.to).toBe(PAYMASTER);
        const { functionName, args } = decodeFunctionData({ abi: KERNEL_REGISTER_ABI, data: t.data });
        expect(functionName).toBe("registerKernelAccount");
        const [account, initData, salt] = args as [Address, Hex, Hex];
        if (failing.has(account.toLowerCase())) throw new Error("execution reverted: UnknownAccount");
        sent.push({ account, initData, salt }); known.add(account.toLowerCase());
        return { simulated: false, hash: `0x${"ab".repeat(32)}` as Hex };
      } },
    } as unknown as KeeperContext;
    return { context, sent };
  }
  const queue = (account: Address) => db.sql`insert into kernel_registrations (account, owner, init_data, salt)
    values (${account.toLowerCase()}, ${addr(1)}, '0x1234', ${`0x${"00".repeat(32)}`})`;

  test("sends registerKernelAccount once per queued account, marks it done, and skips one the paymaster already knows", async () => {
    await queue(addr(0xa1)); await queue(addr(0xa2));
    const h = harness(new Set([addr(0xa2).toLowerCase()]));
    const job = createKernelRegisterJob(h.context);
    const first = await job();
    expect(h.sent.map((s) => s.account.toLowerCase())).toEqual([addr(0xa1).toLowerCase()]);
    expect(h.sent[0]!.initData).toBe("0x1234");
    expect(first).toMatchObject({ registered: 1, alreadyKnown: 1, failed: 0 });
    expect((await db.sql`select count(*)::int as n from kernel_registrations where done_at is null`)[0]!.n).toBe(0);
    await job();
    expect(h.sent.length).toBe(1); // nothing is sent twice
  });

  test("a reverting registration backs off (it is not retried every run) and records the error", async () => {
    await queue(addr(0xb1));
    const h = harness(new Set(), new Set([addr(0xb1).toLowerCase()]));
    const job = createKernelRegisterJob(h.context);
    expect(await job()).toMatchObject({ registered: 0, failed: 1 });
    expect(await job()).toMatchObject({ registered: 0, failed: 0 }); // backed off
    const row = (await db.sql`select attempts, last_error, next_attempt_at > now() as later from kernel_registrations`)[0]!;
    expect(row).toMatchObject({ attempts: 1, later: true });
    expect(String(row.last_error)).toContain("UnknownAccount");
  });

  test("without a paymaster address the job does nothing", async () => {
    await queue(addr(0xc1));
    const h = harness(new Set());
    (h.context.config as Record<string, unknown>).PAYMASTER_ADDRESS = undefined;
    expect(await createKernelRegisterJob(h.context)()).toMatchObject({ idle: true });
    expect(h.sent).toEqual([]);
  });
});
