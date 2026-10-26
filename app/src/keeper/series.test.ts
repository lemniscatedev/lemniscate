import { describe, expect, test } from "bun:test";
import { decodeFunctionResult, encodeFunctionResult, type Address, type Hex } from "viem";
import { OptionEngineAbi } from "../abi";
import { readLiveRisk } from "./series";
import { A, FakeChain, WAD } from "./test-support";

// Fork run 2026-10-25 (round 3): readLiveRisk read engine.seriesRisk as an array, but the function returns one struct,
// which viem decodes as an object. Every keeper run threw "Invalid argument type in ToBigInt operation", so the 5-minute
// funding grid (R3-01) and dust retirement never ran. The unit fake answered with an array, so no test saw it.

const risk = { value: 37n * WAD, delta: -5n * WAD, gamma: 1n, vega: 2n, sc0: -3n, sc1: 4n, sc2: 5n, sc3: -6n };

/** What a node answers for seriesRisk, decoded exactly as viem decodes it for readContract and multicall. */
function realDecoded(value = risk): unknown {
  const data = encodeFunctionResult({ abi: OptionEngineAbi, functionName: "seriesRisk", result: value });
  return decodeFunctionResult({ abi: OptionEngineAbi, functionName: "seriesRisk", data });
}

describe("engine.seriesRisk decoding (fork run 2026-10-25: the keeper's live list was unreadable)", () => {
  test("viem decodes the single-struct return as an object keyed by field name, not an array", () => {
    const decoded = realDecoded() as Record<string, unknown>;
    expect(Array.isArray(decoded)).toBe(false);
    expect(decoded.value).toBe(37n * WAD);
    expect((decoded as unknown as unknown[])[0]).toBeUndefined();
  });

  test("readLiveRisk reads each live series' value from real decoded seriesRisk returns", async () => {
    const ids = [`0x${"1".repeat(64)}`, `0x${"2".repeat(64)}`] as Hex[];
    const stateClient = {
      multicall: async (p: { contracts: { functionName: string; args?: readonly unknown[] }[] }) => p.contracts.map((c) => {
        if (c.functionName === "guards") return [0n, 1800, 604_800];
        if (c.functionName === "liveSeries") return (c.args?.[0] as string).toLowerCase() === A.nvda.toLowerCase() ? ids : [];
        if (c.functionName === "seriesRisk") return realDecoded({ ...risk, value: c.args?.[0] === ids[0] ? 11n * WAD : 22n * WAD });
        throw new Error(`unexpected ${c.functionName}`);
      }),
    };
    const deployment = { contracts: { engine: A.engine }, stocks: [{ name: "NVDA", stock: A.nvda as Address }, { name: "SPY", stock: A.spy as Address }] };
    const live = await readLiveRisk({ clients: { stateClient } as never, deployment: deployment as never });
    expect(live.live.map((x) => x.value)).toEqual([11n * WAD, 22n * WAD]);
    expect(live.dustWad).toBe(1_000_000n * 10n ** 12n);
  });

  test("the FakeChain answers seriesRisk in the shape viem decodes, and refuses a drifted array answer", async () => {
    const chain = new FakeChain();
    const s = chain.addSeries({ stock: A.nvda, isCall: true, strike: 100n * WAD, tauSeconds: 86_400, supply: WAD, riskValue: 9n * WAD });
    const { stateClient } = chain.clients();
    const fake = await stateClient.readContract({ address: A.engine, abi: OptionEngineAbi, functionName: "seriesRisk", args: [s.id] }) as Record<string, unknown>;
    const real = realDecoded(fake as typeof risk) as Record<string, unknown>;
    expect(Object.keys(fake).sort()).toEqual(Object.keys(real).sort());
    expect(fake.value).toBe(9n * WAD);
    // A fake that answers a struct as an array (the old drift) now fails loudly.
    const drifted = new FakeChain() as unknown as { call: (...a: unknown[]) => unknown; clients: FakeChain["clients"] };
    drifted.call = () => [1n, 0n, 0n, 0n, 0n, 0n, 0n, 0n];
    await expect(drifted.clients().stateClient.readContract({ address: A.engine, abi: OptionEngineAbi, functionName: "seriesRisk", args: [s.id] }))
      .rejects.toThrow(/returns one struct/);
  });
});
