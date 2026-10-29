import { describe, expect, test } from "bun:test";
import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, erc20Abi, getAddress, type Hex } from "viem";
import { contractWallets, payoutFiles, payoutLines, recordCheck } from "./writer-payout";
import { weekTable, type PoolFlow } from "./writer-points";

const DAY = 86_400;
const START = 1_800_000_000;
const TOKEN = "0x00000000000000000000000000000000000001aa";
const M = 1_000_000n;
const S = 10n ** 18n;
const T = 10n ** 18n;
const A = "0x000000000000000000000000000000000000000a";
const B = "0x000000000000000000000000000000000000000b";
const C = "0x000000000000000000000000000000000000000c";
let n = 0;
const dep = (account: string, usdg: number): PoolFlow =>
  ({ kind: "deposit", account, block: BigInt(++n), logIndex: 0, ts: START, shares18: BigInt(usdg) * S, assetsMicro: BigInt(usdg) * M });
const table = () => weekTable({
  flows: [dep(A, 20_000), dep(B, 30_000), ...Array.from({ length: 10 }, (_, i) => dep(`0x${(0x100 + i).toString(16).padStart(40, "0")}`, 5_000)), dep(C, 10)],
  startSec: START, endSec: START + 7 * DAY, poolUnits: 1_000_000n * T, perWalletCapBps: 1_000, minTimeWeightedUsdg: 1_000,
  redistributeOverCap: false, excluded: new Map(),
});
const meta = { week: 1, chainId: 4663, token: TOKEN, tokenSymbol: "LMNS", decimals: 18, from: null, contractCheck: "done" as const, excluded: [], generatedAt: "2027-01-01T00:00:00.000Z" };
const transferLog = (to: string, value: bigint, token = TOKEN) => ({
  address: token,
  topics: encodeEventTopics({ abi: erc20Abi, eventName: "Transfer", args: { from: "0x00000000000000000000000000000000000000ee", to: to as Hex } }) as Hex[],
  data: encodeAbiParameters([{ type: "uint256" }], [value]),
});

describe("weekly payout export (unsigned)", () => {
  test("CSV, Safe batch and summary: one ERC-20 transfer per paid wallet, sums asserted, nothing signed", () => {
    const t = table();
    const files = payoutFiles(t, meta);
    expect(files.lines.length).toBe(12); // C is under the 1,000 USDG minimum
    const batch = files.safeBatch as { transactions: { to: string; value: string; data: Hex }[]; chainId: string };
    expect(batch.chainId).toBe("4663");
    let sum = 0n;
    for (const tx of batch.transactions) {
      expect(tx.to).toBe(getAddress(TOKEN));
      expect(tx.value).toBe("0");
      const call = decodeFunctionData({ abi: erc20Abi, data: tx.data });
      expect(call.functionName).toBe("transfer");
      sum += call.args[1] as bigint;
    }
    expect(sum).toBe(t.allocatedUnits);
    expect(BigInt(files.summary.allocatedUnits as string) + BigInt(files.summary.unallocatedUnits as string)).toBe(1_000_000n * T);
    expect(files.summary.digest).toBe(t.digest);
    expect(files.csv.split("\n")[0]).toBe("address,points_usdg_days,time_weighted_usdg,eligible,capped,tokens,token_units,reason");
    expect(files.csv).toContain(`${getAddress(B)},210000.00,30000.000000,true,true,100000,${100_000n * T},""`);
    expect(JSON.stringify({ csv: files.csv, batch: files.safeBatch, summary: files.summary })).not.toMatch(/privateKey|signature|mnemonic/i);
  });

  test("record check: exact payment passes; a short, a double or an extra transfer is named", () => {
    const lines = payoutLines(table());
    const logs = lines.map((line) => transferLog(line.address, line.units));
    expect(recordCheck(lines, TOKEN, [...logs, transferLog(A, 5n, "0x00000000000000000000000000000000000002bb")])).toEqual([]);
    const short = recordCheck(lines, TOKEN, logs.slice(1));
    expect(short.length).toBe(1);
    expect(short[0]).toContain("paid 0");
    expect(recordCheck(lines, TOKEN, [...logs, logs[0]!]).length).toBe(1);
    expect(recordCheck(lines, TOKEN, [...logs, transferLog(C, 7n)])[0]).toContain("not in the export");
  });

  test("contract wallets are found by code; EIP-7702 delegated EOAs are not contracts", async () => {
    const code: Record<string, Hex> = { [A]: "0x6080", [B]: "0xef0100aabbccddeeff00112233445566778899aabbcc" };
    const found = await contractWallets([A, B, C], async (address) => code[address]);
    expect([...found.keys()]).toEqual([A]);
  });
});

describe("payout CLI guard rails", () => {
  const run = (...args: string[]) => Bun.spawnSync(["bun", "run", "scripts/rewards/writer-payout.ts", ...args], {
    cwd: `${import.meta.dir}/../..`, env: { ...process.env, DATABASE_URL: "", DEPLOYMENT_FILE: "" },
  });
  test("refuses before $LMNS launches and on an unknown command", () => {
    const pending = run("export", "--week", "1", "--out", "/tmp/lemniscate-writer-payout-test");
    expect(pending.exitCode).toBe(1);
    expect(pending.stderr.toString()).toContain("Rewards start when $LMNS launches");
    const usage = run("send", "--week", "1");
    expect(usage.exitCode).toBe(1);
    expect(usage.stderr.toString()).toContain("usage:");
  });
});
