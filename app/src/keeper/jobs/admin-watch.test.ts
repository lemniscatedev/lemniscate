import { describe, expect, test } from "bun:test";
import { toFunctionSelector, type Address, type Hex } from "viem";
import { FakeChain } from "../test-support";
import { ADMIN_WATCH_RANGE, createAdminWatchJob, OWNER_CODE_REMINDER_MS, type AdminWatchState } from "./admin-watch";

const TIMELOCK = "0x00000000000000000000000000000000000071c0" as Address;
const OWNER = "0x000000000000000000000000000000000000e0a0" as Address;
const POOL = "0x0000000000000000000000000000000000000b01" as Address;
const OP = `0x${"ab".repeat(32)}` as Hex;

interface FakeLog {
  eventName: string;
  args: Record<string, unknown>;
  blockNumber: bigint;
  transactionHash: Hex;
  logIndex: number;
}

/** A fake chain for the watcher: a head block, timelock logs by block, code at addresses, and the saved cursor row. */
class WatchChain {
  head = 100n;
  logs: FakeLog[] = [];
  code = new Map<string, Hex>();
  savedCursor: string | undefined;
  getLogsCalls: { fromBlock: bigint; toBlock: bigint; address: Address }[] = [];
  failGetLogs = false;
  alerts: { level: string; fields: Record<string, unknown>; message: string }[] = [];

  context() {
    const base = new FakeChain().context();
    const record = (level: string) => (fields: Record<string, unknown>, message: string) => {
      if (fields?.alert) this.alerts.push({ level, fields, message });
    };
    const sql = Object.assign(
      async (strings: TemplateStringsArray, ...values: unknown[]) => {
        const text = strings.join("?");
        if (text.startsWith("select meta from keeper_status")) return this.savedCursor ? [{ meta: { cursor: this.savedCursor } }] : [];
        if (text.startsWith("insert into keeper_status")) this.savedCursor = (JSON.parse(String(values[1])) as { cursor: string }).cursor;
        return [];
      },
      { begin: async () => undefined },
    );
    return {
      ...base,
      sql,
      deployment: { ...base.deployment, deployBlock: 10, safe: OWNER, contracts: { ...base.deployment.contracts, pool: POOL, timelock: TIMELOCK } },
      logger: { error: record("error"), warn: record("warn"), info: () => undefined, debug: () => undefined },
      clients: {
        ...base.clients,
        logsClient: {
          getBlockNumber: async () => this.head,
          getLogs: async (p: { address: Address; fromBlock: bigint; toBlock: bigint }) => {
            if (this.failGetLogs) throw new Error("rpc down");
            this.getLogsCalls.push({ fromBlock: p.fromBlock, toBlock: p.toBlock, address: p.address });
            return this.logs.filter((log) => log.blockNumber >= p.fromBlock && log.blockNumber <= p.toBlock);
          },
        },
        stateClient: { ...base.clients.stateClient, getCode: async (p: { address: Address }) => this.code.get(p.address.toLowerCase()) },
      },
    } as unknown as Parameters<typeof createAdminWatchJob>[0];
  }

  log(eventName: string, blockNumber: bigint, args: Record<string, unknown> = {}, logIndex = 0) {
    this.logs.push({ eventName, args: { id: OP, ...args }, blockNumber, transactionHash: `0x${blockNumber.toString(16).padStart(64, "0")}` as Hex, logIndex });
  }
}

const UPGRADE = `${toFunctionSelector("upgradeToAndCall(address,bytes)")}${"00".repeat(64)}` as Hex;

describe("admin-watch keeper job (timelock and owner watcher)", () => {
  test("alerts once on each scheduled, executed and cancelled call, in plain words, with a dedupe key", async () => {
    const chain = new WatchChain();
    chain.log("CallScheduled", 20n, { index: 0n, target: POOL, value: 0n, data: UPGRADE, delay: 172_800n });
    chain.log("CallExecuted", 60n, { index: 0n, target: POOL, value: 0n, data: UPGRADE });
    chain.log("Cancelled", 70n, { id: `0x${"cd".repeat(32)}` });
    const job = createAdminWatchJob(chain.context());
    const result = await job();
    expect(result.events).toBe(3);
    expect(chain.alerts.map((a) => a.message.split(":")[0])).toEqual(["ALERT", "ALERT", "ALERT"]);
    expect(chain.alerts[0]!.message).toContain("an admin action was scheduled on the timelock: upgradeToAndCall on pool");
    expect(chain.alerts[0]!.message).toContain("48 hours");
    expect(chain.alerts[0]!.message).toContain("treat the owner key as compromised");
    expect(chain.alerts[1]!.message).toContain("was executed: upgradeToAndCall on pool");
    expect(chain.alerts[2]!.message).toContain("was cancelled");
    const keys = chain.alerts.map((a) => a.fields.dedupeKey as string);
    expect(new Set(keys).size).toBe(3);
    expect(keys[0]).toStartWith("timelock:CallScheduled:");
    expect(chain.getLogsCalls[0]).toEqual({ fromBlock: 10n, toBlock: 100n, address: TIMELOCK }); // starts at the deploy block
    // The next pass reads only new blocks and does not repeat an alert.
    await job();
    expect(chain.alerts).toHaveLength(3);
    chain.head = 120n;
    chain.log("CallScheduled", 110n, { index: 0n, target: POOL, value: 0n, data: "0x12345678", delay: 172_800n });
    await job();
    expect(chain.getLogsCalls.at(-1)).toEqual({ fromBlock: 101n, toBlock: 120n, address: TIMELOCK });
    expect(chain.alerts).toHaveLength(4);
    expect(chain.alerts[3]!.message).toContain("function 0x12345678 on pool");
  });

  test("a delay change on the timelock is an alert too", async () => {
    const chain = new WatchChain();
    chain.log("MinDelayChange", 30n, { id: undefined, oldDuration: 172_800n, newDuration: 3_600n });
    await createAdminWatchJob(chain.context())();
    expect(chain.alerts[0]!.message).toBe("ALERT: the timelock delay changed from 48 to 1 hours.");
  });

  test("resumes from the saved cursor after a restart and never re-alerts what an earlier keeper saw", async () => {
    const chain = new WatchChain();
    chain.log("CallScheduled", 20n, { index: 0n, target: POOL, value: 0n, data: UPGRADE, delay: 172_800n });
    await createAdminWatchJob(chain.context())();
    expect(chain.savedCursor).toBe("101");
    chain.head = 105n;
    const restarted = createAdminWatchJob(chain.context()); // fresh state, as after a restart
    await restarted();
    expect(chain.alerts).toHaveLength(1);
    expect(chain.getLogsCalls.at(-1)!.fromBlock).toBe(101n);
  });

  test("a retried range after a failed pass does not alert twice", async () => {
    const chain = new WatchChain();
    chain.log("CallScheduled", 20n, { index: 0n, target: POOL, value: 0n, data: UPGRADE, delay: 172_800n });
    const state: AdminWatchState = { sent: new Set() };
    const job = createAdminWatchJob(chain.context(), state);
    await job();
    state.cursor = 10n; // as if the cursor save had failed
    await job();
    expect(chain.alerts).toHaveLength(1);
  });

  test("catches up in bounded ranges", async () => {
    const chain = new WatchChain();
    chain.head = 10n + ADMIN_WATCH_RANGE * 25n;
    const job = createAdminWatchJob(chain.context());
    const first = await job();
    expect(chain.getLogsCalls).toHaveLength(10);
    expect(chain.getLogsCalls.every((c) => c.toBlock - c.fromBlock + 1n <= ADMIN_WATCH_RANGE)).toBe(true);
    expect(first.behind).toBe(true);
    await job();
    await job();
    expect(chain.getLogsCalls.at(-1)!.toBlock).toBe(chain.head);
  });

  test("an RPC failure throws (the scheduler retries) and sends no alert", async () => {
    const chain = new WatchChain();
    chain.failGetLogs = true;
    await expect(createAdminWatchJob(chain.context())()).rejects.toThrow("rpc down");
    expect(chain.alerts).toHaveLength(0);
  });

  test("alerts when the owner gains an EIP-7702 delegation, reminds hourly, and reports when it is gone", async () => {
    const chain = new WatchChain();
    const job = createAdminWatchJob(chain.context());
    expect((await job()).ownerCode).toBe("none");
    expect(chain.alerts).toHaveLength(0);
    const delegate = "1111111111111111111111111111111111111111";
    chain.code.set(OWNER, `0xef0100${delegate}` as Hex);
    expect((await job()).ownerCode).toBe("delegated");
    expect(chain.alerts).toHaveLength(1);
    expect(chain.alerts[0]!.message).toContain(`now has an EIP-7702 delegation to 0x${delegate}`);
    expect(chain.alerts[0]!.fields.dedupeKey).toStartWith(`owner-code:${OWNER}:0x`);
    await job();
    expect(chain.alerts).toHaveLength(1); // one alert per cause, not one per pass
    const realNow = Date.now;
    try {
      Date.now = () => realNow() + OWNER_CODE_REMINDER_MS + 1;
      await job();
    } finally {
      Date.now = realNow;
    }
    expect(chain.alerts).toHaveLength(2);
    expect(chain.alerts[1]!.fields.reminder).toBe(true);
    chain.code.set(OWNER, "0x");
    await job();
    expect(chain.alerts.at(-1)!.message).toBe("RESOLVED: the owner address has no code again.");
  });

  test("any other code at the owner is an alert, and a changed code alerts again at once", async () => {
    const chain = new WatchChain();
    const job = createAdminWatchJob(chain.context());
    chain.code.set(OWNER, "0x6080604052" as Hex);
    expect((await job()).ownerCode).toBe("code");
    expect(chain.alerts[0]!.message).toContain("now has contract code (5 bytes)");
    chain.code.set(OWNER, "0x60806040526000" as Hex);
    await job();
    expect(chain.alerts).toHaveLength(2);
  });

  test("idle without a timelock or owner (testnet), and never sends a transaction", async () => {
    const chain = new WatchChain();
    const context = chain.context();
    (context.deployment as Record<string, unknown>).safe = `0x${"0".repeat(40)}`;
    (context.deployment.contracts as Record<string, unknown>).timelock = `0x${"0".repeat(40)}`;
    let sent = 0;
    (context as { tx: unknown }).tx = { submit: async () => { sent++; return { simulated: false }; } };
    expect((await createAdminWatchJob(context)()).idle).toBe(true);
    expect(sent).toBe(0);
    expect(chain.getLogsCalls).toHaveLength(0);
  });
});
