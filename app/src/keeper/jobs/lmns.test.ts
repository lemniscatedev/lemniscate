import { describe, expect, test } from "bun:test";
import type { Address } from "viem";
import { A, FakeChain } from "../test-support";
import { requiredRoles } from "../startup";
import { createBuyBurnJob, createStakingSyncJob } from "./lmns";

const STAKING = "0x00000000000000000000000000000000000005a1" as Address;
const BURN = "0x00000000000000000000000000000000000005b2" as Address;

function withLmns(chain: FakeChain, contracts: Record<string, Address>) {
  const context = chain.context();
  return { ...context, deployment: { ...context.deployment, contracts: { ...context.deployment.contracts, ...contracts } } } as typeof context;
}

describe("LMNS keeper jobs (review F19/F37, decisions 42-43)", () => {
  test("staking.syncLoss is sent hourly only when staking is configured", async () => {
    const chain = new FakeChain();
    expect(await createStakingSyncJob(chain.context())()).toMatchObject({ idle: true });
    expect(chain.sent).toEqual([]);
    const result = await createStakingSyncJob(withLmns(chain, { staking: STAKING }))();
    expect(result).toMatchObject({ idle: false });
    expect(chain.sent.map((tx) => [tx.name, tx.to])).toEqual([["syncLoss", STAKING]]);
  });

  test("buyAndBurn runs only when the burn contract is configured and holds USDG, capped per call", async () => {
    const chain = new FakeChain();
    expect(await createBuyBurnJob(chain.context())()).toMatchObject({ idle: true });
    const context = withLmns(chain, { buyBurn: BURN });
    expect(await createBuyBurnJob(context)()).toMatchObject({ idle: true, reason: "nothing to burn" });
    chain.erc20Balances.set(`${A.engine}:${BURN}`, 5_000_000_000n); // 5,000 USDG (usdg is A.engine in the fake deployment)
    const result = await createBuyBurnJob({ ...context, config: { ...context.config, KEEPER_BUY_BURN_MAX_USDG: 1000 } } as never)();
    expect(result).toMatchObject({ idle: false });
    expect(chain.sent.map((tx) => [tx.name, tx.to, tx.args[0]])).toEqual([["buyAndBurn", BURN, 1_000_000_000n]]);
  });

  test("buy-burn needs the keeper role on the burn contract; staking-sync needs none", () => {
    const deployment = { contracts: { engine: A.engine, registry: A.registry, buyBurn: BURN, staking: STAKING } } as never;
    expect(requiredRoles(new Set(["buy-burn", "staking-sync"]), deployment)).toEqual([
      { job: "buy-burn", contract: "buyBurn", address: BURN, role: "KEEPER_ROLE" },
    ]);
  });
});
