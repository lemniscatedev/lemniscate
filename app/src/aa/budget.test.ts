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
async function sell(services: ReturnType<typeof setup>["services"], client: string, account: Address, lane: number, holder = false) {
  // R3-06: `holder` is what the route sets when Postgres shows the account holds the option it sells.
  return withAaCaller({ client, sell: true, ...(holder ? { holder: account } : {}) }, async () => {
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
        await sell(services, "honest", honest, 0, true).then(() => { served += 1; }, () => undefined);
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
      await sell(services, "honest", honest, 0, true); // warm: its account and owner are cached
      clock.at += 10_000;
      let coldServed: boolean | undefined;
      for (let second = 0; second < 60; second++) {
        for (let a = 0; a < attackers; a++) for (let k = 0; k < 2; k++) await flood(t, services, `attacker-${a}`, (second * 100 + a) * 2 + k);
        if (second % 6 === 3) await sell(services, "honest", honest, 0, true); // throws if refused (R3-06: holders sell on lane 0)
        if (second === 30 && attackers <= 2) coldServed = await sell(services, "newcomer", cold, 1, true).then(() => true, () => false);
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

/** R3-06: the reserved sell lane is for holders (an indexed option position, checked in Postgres by the route), each holder
 * account with its own small share of it; a deployed Kernel account with no position is an ordinary caller. */
describe("R3-06 a handful of /64s and self-deployed Kernel accounts cannot starve a holder's sell", () => {
  /** A holder's sell, as the route runs it: the gate's identity reads, then the build. */
  async function holderSell(services: ReturnType<typeof setup>["services"], client: string, account: Address) {
    return withAaCaller({ client, sell: true, holder: account }, async () => {
      await services.chain.isDeployed(account);
      await services.chain.kernelOwner(services.config.kernelValidator, account);
      await services.chain.implementationOf(account);
      return buildUserOp(services, { account, calls: CALLS, sponsor: false, nonceLane: 0 });
    });
  }
  /** Served within `retries` tries one second apart (the clock moves; the flood goes on in `between`). */
  async function servedWithin(retries: number, attempt: () => Promise<unknown>, between: () => Promise<void>): Promise<boolean> {
    for (let i = 0; i < retries; i++) {
      if (await attempt().then(() => true, () => false)) return true;
      await between();
    }
    return false;
  }
  const deployKernel = (t: ReturnType<typeof setup>["t"], account: Address) => {
    t.state.deployed.add(account.toLowerCase());
    t.state.owners.set(account.toLowerCase(), OWNER.toLowerCase() as Address);
  };

  test("PoC (report numbers): 3 /64s drain the shared lane, 4 /64s sell self-deployed Kernel accounts on fresh nonce lanes; the holder's sell is still served", async () => {
    const { t, clock, services } = setup();
    const holder = addr(0x51_0001);
    deployKernel(t, holder);
    const attackerAccounts = [0, 1, 2, 3].map((i) => addr(0x52_0000 + i));
    for (const a of attackerAccounts) deployKernel(t, a); // about $0.015 each through the public factory; no position
    let lane = 1;
    // The clock moves first and the flood spends the refill before the holder tries: the attacker wins every race.
    const second = async () => {
      clock.at += 1000;
      for (let c = 0; c < 3; c++) await flood(t, services, `2001:db8:a:${c}::/64`, clock.at / 1000 * 3 + c);
      for (let c = 0; c < 4; c++) await sell(services, `2001:db8:b:${c}::/64`, attackerAccounts[c]!, lane++ % 65_536).catch(() => undefined);
    };
    for (let s = 0; s < 20; s++) await second(); // the flood is in its steady state
    let served = 0;
    for (let round = 0; round < 12; round++) {
      if (await servedWithin(3, () => holderSell(services, "198.51.100.7", holder), second)) served += 1;
      for (let s = 0; s < 10; s++) await second(); // a holder sells now and then, not every second
    }
    expect(served).toBe(12);
  });

  test("PROPERTY: K = 1,000 attacker /64s at the route limit plus any number of attacker-deployed Kernel accounts never stop a holder's sell for more than a bounded number of retries", async () => {
    let seed = 3636;
    const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
    for (let trial = 0; trial < 2; trial++) {
      const { t, clock, services } = setup();
      const holders = [0, 1, 2].map((i) => addr(0x61_0000 + trial * 16 + i));
      for (const h of holders) deployKernel(t, h);
      const kernels = Array.from({ length: 1 + rnd(300) }, (_, i) => addr(0x62_0000 + trial * 1000 + i));
      for (const k of kernels) deployKernel(t, k);
      let n = 0;
      const second = async () => {
        clock.at += 1000;
        // 1,000 /64s at 30 builds a minute each: 500 requests a second, half random accounts, half deployed Kernel sells
        for (let r = 0; r < 500; r++) {
          const client = `2001:db8:${(r * 2 + (clock.at / 1000) % 2).toString(16)}::/64`;
          if (rnd(2)) await flood(t, services, client, n++);
          else await sell(services, client, kernels[rnd(kernels.length)]!, rnd(65_536)).catch(() => undefined);
        }
      };
      for (let s = 0; s < 5; s++) await second();
      for (let round = 0; round < 4; round++) {
        for (const h of holders) {
          expect(await servedWithin(3, () => holderSell(services, `203.0.113.${rnd(250)}`, h), second)).toBe(true);
        }
        for (let s = 0; s < 8; s++) await second();
      }
    }
  }, 60_000);

  test("a holder account takes at most its own share of the reserved lane, so one position cannot drain it for the others", async () => {
    const { t, clock, services } = setup();
    const greedy = addr(0x71_0001);
    const other = addr(0x71_0002);
    deployKernel(t, greedy); deployKernel(t, other);
    for (let s = 0; s < 30; s++) {
      clock.at += 1000;
      for (let k = 0; k < 20; k++) await withAaCaller({ client: `2001:db8:c:${k}::/64`, sell: true, holder: greedy },
        () => buildUserOp(services, { account: greedy, calls: CALLS, sponsor: false, nonceLane: s * 20 + k })).catch(() => undefined);
    }
    expect(await holderSell(services, "192.0.2.9", other).then(() => true, () => false)).toBe(true);
  });
});

/** R3-06 follow-up (skeptic H1): the route marks a sell `holder` because Postgres shows a position, but nothing proves the
 * caller controls the account. Strangers can name real holders' accounts; that must not drain the reserved lane. */
describe("R3-06 H1 strangers naming real holders' accounts cannot drain the reserved lane", () => {
  const dep = (t: ReturnType<typeof setup>["t"], a: Address) => { t.state.deployed.add(a.toLowerCase()); t.state.owners.set(a.toLowerCase(), OWNER.toLowerCase() as Address); };
  /** The route's holder sell (the PoC passes `holder` on any lane, the worst case for the wrapper). */
  async function namedSell(services: ReturnType<typeof setup>["services"], client: string, account: Address, lane = 0, asRoute = false) {
    // asRoute: the route marks `holder` only on lane 0 (and with the owner's proof); the PoC marks it on every lane.
    return withAaCaller({ client, sell: true, ...(!asRoute || lane === 0 ? { holder: account } : {}) }, async () => {
      await services.chain.isDeployed(account);
      await services.chain.kernelOwner(services.config.kernelValidator, account);
      await services.chain.implementationOf(account);
      return buildUserOp(services, { account, calls: CALLS, sponsor: false, nonceLane: lane });
    });
  }
  async function run(laneOf: (i: number) => number, namedCount: number, asRoute = false) {
    const { t, clock, services } = setup();
    const victim = addr(0x51_0001); dep(t, victim);
    const named = Array.from({ length: namedCount }, (_, i) => addr(0x53_0000 + i)); named.forEach((a) => dep(t, a));
    let lane = 1, n = 0;
    const second = async () => {
      clock.at += 1000;
      for (let c = 0; c < 3; c++) await flood(t, services, `2001:db8:a:${c}::/64`, n++); // 3 /64s drain the shared lane
      // 2 builds a second naming real holders (4-5 /64s at 30 a minute each)
      for (let k = 0; k < 2; k++) await namedSell(services, `2001:db8:b:${k}::/64`, named[(n++) % named.length]!, laneOf(lane++), asRoute).catch(() => undefined);
    };
    for (let s = 0; s < 30; s++) await second();
    let served = 0;
    for (let round = 0; round < 12; round++) {
      for (let r = 0; r < 3; r++) {
        if (await namedSell(services, "198.51.100.7", victim).then(() => true, () => false)) { served++; break; }
        await second();
      }
      for (let s = 0; s < 10; s++) await second();
    }
    return served;
  }

  test("skeptic PoC: 12 named holders on fresh nonce lanes leave the victim's sell served every round (was 0 of 12)", async () => {
    expect(await run((lane) => lane % 65_536, 12)).toBe(12);
  });

  test("the same on lane 0: a named holder's lane-0 nonce is cached, so naming it costs one read per two minutes", async () => {
    expect(await run(() => 0, 12)).toBe(12);
  });

  test("PROPERTY: any number (up to 60) of holders named on fresh lanes, or up to 12 position accounts the attacker owns (and proves) on lane 0, leave the victim served within 3 tries every round", async () => {
    // Lane 0 needs the owner's proof at the route (sell-lane-proof.ts), so on lane 0 only the attacker's own accounts count here.
    let seed = 6006;
    const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
    for (let trial = 0; trial < 6; trial++) {
      const laneZero = rnd(2) === 0;
      const count = laneZero ? 1 + rnd(12) : 1 + rnd(60);
      expect(await run((lane) => (laneZero ? 0 : 1 + ((lane * 7919 + rnd(65_535)) % 65_535)), count, true)).toBe(12);
    }
  }, 60_000);

  test("nonce-lane miss cap: one account has at most 4 fresh non-zero lanes read a minute; lane 0 is never refused for it", async () => {
    const { t, clock, services } = setup();
    const before = t.state.reads.filter((r) => r.startsWith("nonce:")).length;
    const outcomes: string[] = [];
    for (let lane = 1; lane <= 20; lane++) {
      outcomes.push(await withAaCaller({ client: `198.51.100.${lane}`, sell: true }, () => services.chain.entryPointNonce(services.config.entryPoint, ACCOUNT, BigInt(lane)))
        .then(() => "ok", (error) => (error instanceof RpcBudgetError ? "refused" : "other")));
    }
    expect(outcomes.filter((o) => o === "ok").length).toBe(4);
    expect(t.state.reads.filter((r) => r.startsWith("nonce:")).length - before).toBe(4);
    expect(await services.chain.entryPointNonce(services.config.entryPoint, ACCOUNT, 0n)).toBe(0n);
    expect(await services.chain.entryPointNonce(services.config.entryPoint, ACCOUNT, 1n)).toBe(1n << 64n); // a lane already read: cached or re-readable
    clock.at += 61_000; // a minute later the account may read new lanes again
    expect(await services.chain.entryPointNonce(services.config.entryPoint, ACCOUNT, 99n)).toBe(99n << 64n);
  });

  test("our relay moves the cached lane-0 nonce on, so a long cache never hands a user a spent nonce", async () => {
    const { t, clock, services } = setup();
    expect(await services.chain.entryPointNonce(services.config.entryPoint, ACCOUNT, 0n)).toBe(0n);
    const reads = t.state.reads.length;
    services.chain.noteRelayed!(ACCOUNT, 0n);
    t.state.nonces.set(`${ACCOUNT.toLowerCase()}:0`, 1n); // included on chain
    expect(await services.chain.entryPointNonce(services.config.entryPoint, ACCOUNT, 0n)).toBe(1n);
    expect(t.state.reads.length).toBe(reads); // known without a read
    clock.at += 61_000;
    expect(await services.chain.entryPointNonce(services.config.entryPoint, ACCOUNT, 0n)).toBe(1n); // re-read later
  });
});
