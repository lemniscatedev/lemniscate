import { describe, expect, test } from "bun:test";
import { DeploymentFileError, parseOptionDeployment } from "./deployment";

const a = (n: number): `0x${string}` => `0x${n.toString(16).padStart(40, "0")}`;
const base = {
  chainId: 4663,
  network: "fork",
  deployBlock: "123",
  contracts: { engine: a(1), pool: a(2), registry: a(3), priceGuard: a(4), volOracle: a(5), usdg: a(6) },
  stocks: [{ name: "NVDA", stock: a(10).toUpperCase().replace("0X", "0x"), feed: a(11) }, { name: "TSLA", stock: a(12) }],
};

describe("option deployment file", () => {
  test("parses, lowercases addresses and defaults the pool share decimals", () => {
    const parsed = parseOptionDeployment(base);
    expect(parsed.deployBlock).toBe(123);
    expect(parsed.poolShareDecimals).toBe(12);
    expect(parsed.stocks[0]?.stock).toBe(a(10));
    expect(parsed.contracts.agentRouter).toBeUndefined();
  });

  test("rejects a wrong chain, missing contracts and duplicate stocks", () => {
    expect(() => parseOptionDeployment({ ...base, chainId: 1 })).toThrow(DeploymentFileError);
    // The deploy script's profiles: fork on anvil 31337, testnet 46630, mainnet 4663.
    expect(parseOptionDeployment({ ...base, chainId: 31337 }).chainId).toBe(31337);
    expect(parseOptionDeployment({ ...base, chainId: 46630, network: "testnet" }).network).toBe("testnet");
    expect(() => parseOptionDeployment({ ...base, network: "devnet" })).toThrow(DeploymentFileError);
    expect(() => parseOptionDeployment({ ...base, contracts: { engine: a(1) } })).toThrow(/contracts\.pool/);
    expect(() => parseOptionDeployment({ ...base, stocks: [] })).toThrow(DeploymentFileError);
    expect(() => parseOptionDeployment({ ...base, stocks: [base.stocks[1], base.stocks[1]] })).toThrow(/duplicate/);
    expect(() => parseOptionDeployment({ ...base, stocks: [{ name: "nvda", stock: a(10) }] })).toThrow(/upper case/);
  });
});
