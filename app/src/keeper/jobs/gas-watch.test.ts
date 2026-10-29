import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Address } from "viem";
import { FakeChain } from "../test-support";
import { burnPerMs, createGasWatchJob, newGasWatchState } from "./gas-watch";

const TOKEN = "987654:GAS-TOKEN-never-print";
const A = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;
const KEEPER = A(0xc1), VOL = A(0xc2), HEDGER = A(0xc3), GUARDIAN = A(0xc4), OWNER = A(0xc5);
const ETH = (x: number) => BigInt(Math.round(x * 1e18));
const HOUR = 3_600_000;

let dir: string;
let envFile: string;
let server: ReturnType<typeof Bun.serve>;
let sent: { path: string; body: { chat_id: string; text: string } }[] = [];
let failTelegram = false;
let balances = new Map<string, bigint>();
const warnings: string[] = [];
let clock = 1_800_000_000_000;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "lmns-gas-"));
  envFile = join(dir, "release.env");
  writeFileSync(envFile, `TELEGRAM_BOT_TOKEN=${TOKEN}\nTELEGRAM_COMMUNITY_CHAT_ID=-100111\nTELEGRAM_OPS_CHAT_ID=-100222\n`);
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      sent.push({ path: new URL(req.url).pathname, body: (await req.json()) as never });
      if (failTelegram) return Response.json({ ok: false }, { status: 500 });
      return Response.json({ ok: true });
    },
  });
  process.env.TELEGRAM_API_BASE = `http://127.0.0.1:${server.port}`;
});
afterAll(() => {
  server.stop(true);
  delete process.env.TELEGRAM_API_BASE;
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  sent = [];
  failTelegram = false;
  warnings.length = 0;
  balances = new Map([[KEEPER, ETH(0.05)], [VOL, ETH(0.05)], [HEDGER, ETH(0.05)], [GUARDIAN, ETH(0.05)], [OWNER, ETH(0.05)]]);
});

function make(config: Record<string, unknown> = {}) {
  const chain = new FakeChain();
  const base = chain.context({}, {
    GAS_WATCH_ENABLED: true, GAS_WATCH_MIN_KEEPER_ETH: 0.008, GAS_WATCH_MIN_VOL_SIGNER_ETH: 0.002, GAS_WATCH_MIN_OTHER_ETH: 0.0005,
    GAS_WATCH_REALERT_HOURS: 6, GAS_WATCH_VOL_SIGNER_ADDRESS: VOL, GAS_WATCH_HEDGER_ADDRESS: HEDGER, GAS_WATCH_GUARDIAN_ADDRESS: GUARDIAN,
    GAS_WATCH_OWNER_ADDRESS: "", GAS_WATCH_TELEGRAM_ENV_FILE: envFile, HEDGER_DRY_RUN: true, CHAIN_ID: 4663, ...config,
  });
  const context = {
    ...base,
    deployment: { ...base.deployment, safe: OWNER },
    logger: { warn: (m: string) => warnings.push(m), error: () => undefined, info: () => undefined, debug: () => undefined },
    clients: { ...base.clients, walletClient: { account: { address: KEEPER } }, stateClient: { getBalance: async ({ address }: { address: Address }) => balances.get(address) ?? 0n } },
    sql: Object.assign(async () => [], { begin: async () => undefined }),
  } as unknown as Parameters<typeof createGasWatchJob>[0];
  const job = createGasWatchJob(context, newGasWatchState(), { nowMs: () => clock });
  return job;
}
const texts = () => sent.map((s) => s.body.text);

describe("gas-watch keeper job", () => {
  test("ships off: GAS_WATCH_ENABLED=0 reads nothing and posts nothing", async () => {
    balances.set(KEEPER, 0n);
    const job = make({ GAS_WATCH_ENABLED: false });
    expect(await job()).toMatchObject({ idle: true });
    expect(sent).toHaveLength(0);
  });

  test("a wallet under its own threshold posts the plain message to the group and the ops chat, nobody else does", async () => {
    balances.set(KEEPER, ETH(0.007)); // < 0.008
    balances.set(VOL, ETH(0.0025)); // above 0.002
    balances.set(OWNER, ETH(0.0006)); // above 0.0005
    const job = make();
    await job();
    expect(sent).toHaveLength(2);
    expect(sent.map((s) => s.body.chat_id).sort()).toEqual(["-100111", "-100222"]);
    expect(sent[0]!.path).toBe(`/bot${TOKEN}/sendMessage`);
    const text = sent[0]!.body.text;
    expect(text).toContain("keeper wallet");
    expect(text).toContain(KEEPER);
    expect(text).toContain("0.007 ETH");
    expect(text).toContain("not measured yet");
    expect(text).toContain("send about 0.0160 ETH"); // two days, no burn measured: twice the alert level
    expect(text.endsWith(`Send ETH on Robinhood Chain (4663) to ${KEEPER}`)).toBe(true);
    expect(text).not.toContain("—");
  });

  test("thresholds: vol-signer 0.002, guardian-hot and owner 0.0005; the hedger is skipped in dry run and watched when live", async () => {
    balances.set(VOL, ETH(0.0019));
    balances.set(GUARDIAN, ETH(0.0004));
    balances.set(OWNER, ETH(0.0004));
    balances.set(HEDGER, ETH(0.0001));
    await make()();
    expect(texts().filter((t, i) => i % 2 === 0).map((t) => t.match(/on the (\S+) wallet/)![1])).toEqual(["vol-signer", "guardian-hot", "owner"]);
    sent = [];
    await make({ HEDGER_DRY_RUN: false })();
    expect(texts().some((t) => t.includes("hedger wallet"))).toBe(true);
  });

  test("one alert per wallet per 6 h, then one 'topped up, thanks' on recovery, and no repeat after", async () => {
    balances.set(OWNER, ETH(0.0002));
    const job = make();
    await job();
    expect(sent).toHaveLength(2);
    clock += 5 * HOUR;
    await job();
    expect(sent).toHaveLength(2); // still inside the 6 h window
    clock += 1.1 * HOUR;
    await job();
    expect(sent).toHaveLength(4); // 6 h passed: one more alert (group + ops)
    balances.set(OWNER, ETH(0.01));
    clock += 600_000;
    await job();
    expect(sent).toHaveLength(6);
    expect(sent.at(-1)!.body.text).toBe(`Topped up, thanks. The owner wallet ${OWNER} now has 0.01 ETH.`);
    clock += 600_000;
    await job();
    expect(sent).toHaveLength(6);
  });

  test("the burn rate gives the time left and a two-day top-up", async () => {
    // 0.003 ETH an hour: 0.020, 0.017, 0.014, 0.011, 0.008 (not below), then 0.005 and the alert fires
    const job = make();
    for (const level of [0.02, 0.017, 0.014, 0.011, 0.008]) {
      balances.set(KEEPER, ETH(level));
      await job();
      clock += HOUR;
    }
    expect(sent).toHaveLength(0);
    balances.set(KEEPER, ETH(0.005));
    await job();
    const text = sent[0]!.body.text;
    expect(text).toContain("Time left at the current burn: about 2 hours"); // 0.005 / 0.003 = 1.7 h
    expect(text).toContain("send about 0.1440 ETH"); // 0.003 x 48 h
  });

  test("burnPerMs ignores top-ups and needs 30 minutes of data", () => {
    expect(burnPerMs([{ t: 0, wei: "100" }, { t: 600_000, wei: "50" }])).toBeUndefined();
    const rate = burnPerMs([{ t: 0, wei: "1000" }, { t: HOUR, wei: "400" }, { t: 2 * HOUR, wei: "5000" }, { t: 3 * HOUR, wei: "4400" }]);
    expect(rate).toBeCloseTo(600 / HOUR, 10);
  });

  test("a Telegram failure leaves the wallet un-alerted so the next pass retries, and the token is never logged", async () => {
    balances.set(GUARDIAN, ETH(0.0001));
    failTelegram = true;
    const job = make();
    await job();
    expect(warnings.join(" ")).toContain("could not post the guardian-hot message");
    expect(warnings.join(" ")).not.toContain(TOKEN);
    failTelegram = false;
    sent = [];
    clock += 600_000;
    await job();
    expect(sent).toHaveLength(2); // retried at once, not held back for 6 h
  });

  test("a missing token file is a warning, not a crash", async () => {
    balances.set(KEEPER, 0n);
    const job = make({ GAS_WATCH_TELEGRAM_ENV_FILE: join(dir, "missing.env") });
    expect(await job()).toMatchObject({ idle: false });
    expect(warnings.join(" ")).toContain("could not post");
  });
});
