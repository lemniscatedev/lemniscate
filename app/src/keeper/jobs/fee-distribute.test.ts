import { describe, expect, test } from "bun:test";
import { decodeFunctionData, type Address, type Hex } from "viem";
import { A, FakeChain } from "../test-support";
import { createFeeDistributeJob, FeeRouterAbi } from "./fee-distribute";

const ROUTER = "0x00000000000000000000000000000000000000f1" as Address;

function setup(state: { next: bigint; amount: bigint }, withRouter = true) {
  const chain = new FakeChain();
  const sent: string[] = [];
  const context = chain.context({
    clients: { stateClient: { readContract: async (p: { functionName: string }) => (p.functionName === "nextDistributionAt" ? state.next : state.amount) } },
    tx: { submit: async (t: { data: Hex }) => { sent.push(decodeFunctionData({ abi: FeeRouterAbi, data: t.data }).functionName); return { simulated: false }; } },
  });
  if (withRouter) (context.deployment.contracts as Record<string, unknown>).feeRouter = ROUTER;
  return { chain, sent, context };
}

describe("fee-distribute keeper job", () => {
  test("waits until the period has passed", async () => {
    const { chain, sent, context } = setup({ next: 1_800_000_000n + 100n, amount: 5n });
    expect((await createFeeDistributeJob(context)()).idle).toBe(true);
    expect(sent).toEqual([]);
    chain.nowSeconds += 200n;
    expect((await createFeeDistributeJob(context)()).idle).toBe(false);
    expect(sent).toEqual(["distribute"]);
  });
  test("sends nothing when there is nothing to split, or no fee router is deployed", async () => {
    const empty = setup({ next: 0n, amount: 0n });
    expect((await createFeeDistributeJob(empty.context)()).idle).toBe(true);
    expect(empty.sent).toEqual([]);
    const none = setup({ next: 0n, amount: 5n }, false);
    expect((await createFeeDistributeJob(none.context)()).idle).toBe(true);
    expect(none.sent).toEqual([]);
    void A;
  });
});
