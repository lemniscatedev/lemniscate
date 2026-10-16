import { expect, test } from "bun:test";
import { decodeFunctionData } from "viem";
import { PriceGuardAbi } from "../../abi";
import { A, FakeChain, WAD } from "../test-support";
import { pokeDue, updateCorporateActions } from "./corp-actions";

test("pokeDue: from an hour before a staged change until two hours after", () => {
  const eff = 10_000n;
  expect(pokeDue({ current: WAD, pending: 4n * WAD, effectiveAt: eff }, eff - 7200n)).toBe(false);
  expect(pokeDue({ current: WAD, pending: 4n * WAD, effectiveAt: eff }, eff - 3000n)).toBe(true);
  expect(pokeDue({ current: WAD, pending: 4n * WAD, effectiveAt: eff }, eff + 7000n)).toBe(true);
  expect(pokeDue({ current: WAD, pending: 4n * WAD, effectiveAt: eff }, eff + 8000n)).toBe(false);
  expect(pokeDue({ current: WAD, pending: 0n, effectiveAt: 0n }, eff)).toBe(false);
  expect(pokeDue({ current: 4n * WAD, pending: 4n * WAD, effectiveAt: eff }, eff + 600n)).toBe(true);
});

test("a staged 4x change is recorded from the chain and PriceGuard is poked once near the effective time", async () => {
  const chain = new FakeChain();
  const nowS = Number(chain.nowSeconds);
  const upserts: unknown[][] = [];
  const effective = BigInt(nowS + 1800);
  const stock = (a: string) => a.toLowerCase();
  const stateClient = {
    multicall: async (p: { contracts: { address: string; functionName: string }[] }) => p.contracts.map((c) => {
      if (stock(c.address) === stock(A.nvda)) {
        const result = c.functionName === "uiMultiplier" ? WAD : c.functionName === "newUIMultiplier" ? 4n * WAD : effective;
        return { status: "success", result };
      }
      return { status: "success", result: c.functionName === "uiMultiplier" ? WAD : 0n };
    }),
  };
  let meta: Record<string, unknown> = { lastHttpAt: new Date().toISOString() };
  const sql = Object.assign(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?");
    if (text.includes("select meta")) return [{ meta }];
    if (text.includes("insert into corp_actions")) upserts.push(values);
    return [];
  }, {});
  const pokes: string[] = [];
  const tx = { submit: async (t: { data: `0x${string}` }) => {
    const d = decodeFunctionData({ abi: PriceGuardAbi, data: t.data });
    pokes.push(`${d.functionName}:${String((d.args as unknown as string[])[0]).toLowerCase()}`);
    return { simulated: false };
  } };
  const context = chain.context({ sql, tx, clients: { stateClient } });
  const result = await updateCorporateActions(context);
  expect(upserts.length).toBe(1);
  expect(upserts[0]).toContain("NVDA");
  expect(upserts[0]).toContain("4");
  expect(pokes).toEqual([`poke:${A.nvda}`]);
  expect(result.poked).toEqual([A.nvda]);
  meta = { ...meta, pokedAt: result.pokedAt };
  await updateCorporateActions(context);
  expect(pokes.length).toBe(1);
});
