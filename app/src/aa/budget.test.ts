import { describe, expect, test } from "bun:test";
import type { Address } from "viem";
import { RpcBudgetError, withAaCaller, withRpcBudget } from "./chain";
import { ACCOUNT, ENGINE, OWNER, createTestServices } from "./test-support";
import { buildUserOp } from "./userop";

/** R12: the AA read budget is not one bucket any client can empty. */
const addr = (n: number): Address => `0x${n.toString(16).padStart(40, "0")}` as Address;
const CALLS = [{ to: ENGINE, value: 0n, data: "0x12345678" as const }];

function setup(fresh = 0) {
  const t = createTestServices();
  const clock = { at: 1_000_000 };
  const budgeted = withRpcBudget(t.services.chain, { callsPerSecond: 5, burst: 14, now: () => clock.at });
  const services = { ...t.services, chain: budgeted, now: () => clock.at };
  void fresh;
  return { t, clock, budgeted, services };
}

/** What the sponsorship gate and the builder read for a sell of a deployed account. */
async function sell(services: ReturnType<typeof setup>["services"], client: string, account: Address, lane: number) {
  return withAaCaller({ client, sell: true }, async () => {
    await services.chain.isDeployed(account);
    await services.chain.kernelOwner(services.config.kernelValidator, account);
    return buildUserOp(services, { account, calls: CALLS, sponsor: false, nonceLane: lane });
  });
}

/** What an attacker's request reads: a fresh random account and owner, every cache missed. */
async function flood(t: ReturnType<typeof setup>["t"], services: ReturnType<typeof setup>["services"], client: string, i: number): Promise<"ok" | "refused"> {
  try {
    // the attacker computes the CREATE2 address of its throw-away owner offline, so the request gets as far as the nonce read
    const account = addr(0xf00000 + i);
    t.state.predicted = account;
    await withAaCaller({ client, sell: true }, () => buildUserOp(services, { account, owner: addr(0xe00000 + i), calls: CALLS, sponsor: false, nonceLane: i % 60_000 }));
    return "ok";
  } catch (error) {
    const code = (error as { apiError?: string }).apiError;
    return code === "CHAIN_UNAVAILABLE" || error instanceof RpcBudgetError ? "refused" : "ok"; // ACCOUNT_MISMATCH etc. still cost the reads
  }
}

describe("R12 one client cannot empty the shared AA read budget", () => {
  test("PoC: one client at the route limit (2 builds a second, random accounts) leaves another client's sell build served", async () => {
    const { t, clock, services, budgeted } = setup();
    t.state.deployed.add(addr(0x1234).toLowerCase());
    t.state.owners.set(addr(0x1234).toLowerCase(), OWNER.toLowerCase() as Address);
    const honest = addr(0x1234);
    let served = 0;
    let attempts = 0;
    for (let second = 0; second < 120; second++) {
      for (let k = 0; k < 2; k++) await flood(t, services, "attacker", second * 2 + k);
      if (second % 5 === 0) {
        attempts += 1;
        await sell(services, "honest", honest, 0).then(() => { served += 1; }, () => undefined);
      }
      clock.at += 1000;
    }
    expect(attempts).toBe(24);
    expect(served).toBe(attempts); // every sell build of the other client was served
    expect(budgeted.stats.refused).toBeGreaterThan(100); // and the attacker was the one refused
  });

  test("the same attacker used to starve everyone: with a single global bucket the honest build fails", async () => {
    const { t, clock } = setup();
    const single = withRpcBudget(t.services.chain, { callsPerSecond: 5, burst: 14, now: () => clock.at, perClient: { callsPerSecond: 1000, burst: 1000 }, reservedShare: 0 });
    const services = { ...t.services, chain: single, now: () => clock.at };
    let refused = 0;
    for (let second = 0; second < 30; second++) {
      for (let k = 0; k < 2; k++) await flood(t, services, "attacker", second * 2 + k);
      await buildUserOp(services, { account: ACCOUNT, calls: CALLS, sponsor: false, nonceLane: second }).catch(() => { refused += 1; });
      clock.at += 1000;
    }
    expect(refused).toBeGreaterThan(10); // the old behaviour, reproduced by switching the partition off
  });

  test("PROPERTY: under any number of flooding clients a warm sell (account known and cached) is always served; one or two clients never block a cold one", async () => {
    let seed = 4242;
    const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
    for (let trial = 0; trial < 12; trial++) {
      const { t, clock, services } = setup();
      const honest = addr(0x2000 + trial);
      const cold = addr(0x3000 + trial);
      for (const a of [honest, cold]) { t.state.deployed.add(a.toLowerCase()); t.state.owners.set(a.toLowerCase(), OWNER.toLowerCase() as Address); }
      const attackers = 1 + rnd(40);
      await sell(services, "honest", honest, 0); // warm: its account and owner are cached
      clock.at += 10_000;
      let coldServed: boolean | undefined;
      for (let second = 0; second < 60; second++) {
        for (let a = 0; a < attackers; a++) for (let k = 0; k < 2; k++) await flood(t, services, `attacker-${a}`, (second * 100 + a) * 2 + k);
        if (second % 6 === 3) await sell(services, "honest", honest, second % 50); // throws if refused
        if (second === 30 && attackers <= 2) coldServed = await sell(services, "newcomer", cold, 1).then(() => true, () => false);
        clock.at += 1000;
      }
      if (attackers <= 2) expect(coldServed).toBe(true);
    }
  });

  test("a flood of throw-away keys evicts other throw-away keys, never a deployed account's cached state", async () => {
    const { t, budgeted, services, clock } = setup();
    expect(await services.chain.isDeployed(ACCOUNT)).toBe(true);
    for (let i = 0; i < 6_500; i++) { await services.chain.isDeployed(addr(0x900000 + i)).catch(() => undefined); clock.at += 400; } // 2.5 reads/s: the bucket keeps up
    const before = budgeted.stats.reads;
    expect(await services.chain.isDeployed(ACCOUNT)).toBe(true);
    expect(budgeted.stats.reads).toBe(before); // still cached, no read
    void t;
  });
});
