import { describe, expect, test } from "bun:test";
import { cacheable } from "./rpc-cache";

const deployment = {
  chainId: 31337, network: "fork", deployBlock: 123,
  contracts: { engine: `0x${"1".repeat(40)}`, pool: `0x${"2".repeat(40)}`, registry: `0x${"3".repeat(40)}`, priceGuard: `0x${"4".repeat(40)}`, volOracle: `0x${"5".repeat(40)}`, usdg: `0x${"6".repeat(40)}` },
  stocks: [{ name: "NVDA", stock: `0x${"7".repeat(40)}` }],
};

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
