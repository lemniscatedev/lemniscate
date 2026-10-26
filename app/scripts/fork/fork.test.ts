import { describe, expect, test } from "bun:test";
import { parseOptionDeployment } from "@/chain/deployment";
import { cacheable } from "./rpc-cache";
import { remapDevAddresses, wellKnownDevAddresses, withForkProof } from "./setup";

const deployment = {
  chainId: 31337, network: "fork", deployBlock: 123,
  contracts: { engine: `0x${"1".repeat(40)}`, pool: `0x${"2".repeat(40)}`, registry: `0x${"3".repeat(40)}`, priceGuard: `0x${"4".repeat(40)}`, volOracle: `0x${"5".repeat(40)}`, usdg: `0x${"6".repeat(40)}` },
  stocks: [{ name: "NVDA", stock: `0x${"7".repeat(40)}` }],
};

describe("fork deployment identity (todo 23 bug: the keeper refused the fork deploy's file)", () => {
  test("the deploy output alone has no forkProof, which the fork keeper requires", () => {
    expect(parseOptionDeployment(deployment).forkProof).toBeUndefined();
  });
  test("withForkProof adds the deploy block number and hash in the schema the keeper checks", () => {
    const parsed = parseOptionDeployment(withForkProof(deployment, `0x${"ab".repeat(32)}`));
    expect(parsed.forkProof).toEqual({ blockNumber: 123, blockHash: `0x${"ab".repeat(32)}` });
    expect(() => withForkProof(deployment, "0x12")).toThrow();
  });
});

describe("rpc cache keys", () => {
  test("only block-pinned reads are cached", () => {
    expect(cacheable({ method: "eth_getStorageAt", params: ["0x01", "0x0", "0x10"] })).toBe(true);
    expect(cacheable({ method: "eth_getStorageAt", params: ["0x01", "0x0", "latest"] })).toBe(false);
    expect(cacheable({ method: "eth_blockNumber", params: [] })).toBe(false);
    expect(cacheable({ method: "eth_chainId", params: [] })).toBe(true);
    expect(cacheable({ method: "eth_call", params: [{}, { blockHash: "0xab" }] })).toBe(true);
  });
});

describe("rpc cache pruned-state fallback", () => {
  test("a pinned storage read is retried at latest when the node pruned the block; block reads never are", async () => {
    const { atLatest, PRUNED_STATE } = await import("./rpc-cache");
    expect(PRUNED_STATE.test("historical state c626c0 is not available")).toBe(true);
    expect(atLatest({ method: "eth_getStorageAt", params: ["0x01", "0x0", "0x10"] })?.params).toEqual(["0x01", "0x0", "latest"]);
    expect(atLatest({ method: "eth_getBalance", params: ["0x01", "0x10"] })?.params).toEqual(["0x01", "latest"]);
    expect(atLatest({ method: "eth_getBlockByNumber", params: ["0x10", false] })).toBeUndefined();
  });
});

describe("fresh fork keys (anvil's well-known dev accounts carry EIP-7702 sweepers on chain 4663)", () => {
  test("the well-known list is anvil's default accounts", () => {
    const known = wellKnownDevAddresses(20);
    expect(known[0]).toBe("0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266");
    expect(known[9]).toBe("0xa0Ee7A142d267C1f36714E4a8F75612F20a79720");
  });
  test("every role in the deploy config moves to the fresh account with the same index, any case", () => {
    const known = wellKnownDevAddresses(3);
    const fresh = [`0x${"a1".repeat(20)}`, `0x${"b2".repeat(20)}`, `0x${"c3".repeat(20)}`] as `0x${string}`[];
    const config = JSON.stringify({ owner: known[1], keeper: known[2]!.toLowerCase(), depositors: [known[1]], other: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" });
    const out = JSON.parse(remapDevAddresses(config, fresh, known));
    expect(out.owner.toLowerCase()).toBe(fresh[1]);
    expect(out.keeper.toLowerCase()).toBe(fresh[2]);
    expect(out.depositors[0].toLowerCase()).toBe(fresh[1]);
    expect(out.other).toBe("0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168");
    for (const k of known) expect(remapDevAddresses(config, fresh, known).toLowerCase()).not.toContain(k.slice(2).toLowerCase());
  });
});
