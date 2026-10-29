// The weekly early-writer payout as an UNSIGNED export the owner signs and sends himself (crypto-token-utility 4):
// a CSV, a Safe Transaction Builder batch (one ERC-20 transfer per wallet) and a summary with the table digest.
// Nothing here holds a key, signs or broadcasts. After the owner sends it, `recordCheck` compares the token's Transfer
// logs in the receipts with the export, and the next week's export refuses until that record exists.
import { decodeEventLog, encodeFunctionData, erc20Abi, getAddress, type Hex } from "viem";
import { unitsText } from "../config/writer-rewards";
import { microText, usdgDays, type WeekTable } from "./writer-points";

export interface PayoutLine {
  readonly address: string;
  readonly units: bigint;
}

export interface PayoutFiles {
  readonly csv: string;
  readonly safeBatch: unknown;
  readonly summary: Record<string, unknown>;
  readonly lines: PayoutLine[];
}

export interface PayoutMeta {
  readonly week: number;
  readonly chainId: number;
  readonly token: string;
  readonly tokenSymbol: string;
  readonly decimals: number;
  /** The wallet the owner pays from (his Safe or the team wallet); shown in the batch, not used to sign. */
  readonly from: string | null;
  readonly contractCheck: "done" | "skipped";
  readonly excluded: ReadonlyArray<{ address: string; reason: string }>;
  readonly generatedAt: string;
}

/** Wallets with a non-zero amount, largest first. */
export function payoutLines(table: WeekTable): PayoutLine[] {
  return table.rows.filter((row) => row.units > 0n).map((row) => ({ address: row.address, units: row.units }));
}

export function payoutFiles(table: WeekTable, meta: PayoutMeta): PayoutFiles {
  const lines = payoutLines(table);
  const sum = lines.reduce((total, line) => total + line.units, 0n);
  if (sum !== table.allocatedUnits || sum + table.unallocatedUnits !== table.poolUnits) {
    throw new Error("payout lines do not add up to the pool");
  }
  const header = "address,points_usdg_days,time_weighted_usdg,eligible,capped,tokens,token_units,reason";
  const csv = [header, ...table.rows.map((row) => [
    getAddress(row.address), usdgDays(row.weightMicroSec), microText(row.avgMicro), row.eligible, row.capped,
    unitsText(row.units, meta.decimals), row.units.toString(), JSON.stringify(row.reason),
  ].join(","))].join("\n") + "\n";
  const safeBatch = {
    version: "1.0",
    chainId: String(meta.chainId),
    createdAt: Date.parse(meta.generatedAt),
    meta: {
      name: `Lemniscate early-writer ${meta.tokenSymbol} rewards, week ${meta.week}`,
      description: `Unsigned. ${lines.length} transfers, ${unitsText(sum, meta.decimals)} ${meta.tokenSymbol}. Table digest ${table.digest}.`,
      createdFromSafeAddress: meta.from ? getAddress(meta.from) : "",
    },
    transactions: lines.map((line) => ({
      to: getAddress(meta.token),
      value: "0",
      data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [getAddress(line.address), line.units] }),
      contractMethod: null,
      contractInputsValues: null,
    })),
  };
  const summary = {
    week: meta.week,
    start: new Date(table.startSec * 1_000).toISOString(),
    end: new Date(table.endSec * 1_000).toISOString(),
    digest: table.digest,
    token: getAddress(meta.token),
    tokenSymbol: meta.tokenSymbol,
    poolUnits: table.poolUnits.toString(),
    capUnits: table.capUnits.toString(),
    allocatedUnits: table.allocatedUnits.toString(),
    unallocatedUnits: table.unallocatedUnits.toString(),
    pool: unitsText(table.poolUnits, meta.decimals),
    allocated: unitsText(table.allocatedUnits, meta.decimals),
    unallocated: unitsText(table.unallocatedUnits, meta.decimals),
    transfers: lines.length,
    eligibleWallets: table.eligibleWallets,
    contractCheck: meta.contractCheck,
    excluded: meta.excluded,
    from: meta.from,
    generatedAt: meta.generatedAt,
    note: "Unsigned. The owner reviews, signs and sends this batch. The unallocated amount stays in the sending wallet.",
  };
  return { csv, safeBatch, summary, lines };
}

/** Contract wallets among the table's addresses (code present and not an EIP-7702 delegation, 0xef0100...). */
export async function contractWallets(addresses: readonly string[], getCode: (address: string) => Promise<Hex | undefined>): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const address of addresses) {
    const code = (await getCode(address)) ?? "0x";
    if (code !== "0x" && !code.toLowerCase().startsWith("0xef0100")) out.set(address, "contract wallet");
  }
  return out;
}

export interface ReceiptLog { readonly address: string; readonly topics: readonly Hex[]; readonly data: Hex }

/** Compares the token Transfer logs of the owner's payout receipts with the export: every line paid exactly once, in
 * full, and nothing else. Returns the problems ([] = the record matches). */
export function recordCheck(lines: readonly PayoutLine[], token: string, logs: readonly ReceiptLog[]): string[] {
  const paid = new Map<string, bigint>();
  for (const log of logs) {
    if (log.address.toLowerCase() !== token.toLowerCase()) continue;
    try {
      const event = decodeEventLog({ abi: erc20Abi, data: log.data, topics: log.topics as [Hex, ...Hex[]] });
      if (event.eventName !== "Transfer") continue;
      const to = event.args.to.toLowerCase();
      paid.set(to, (paid.get(to) ?? 0n) + event.args.value);
    } catch { /* not a Transfer */ }
  }
  const problems: string[] = [];
  for (const line of lines) {
    const got = paid.get(line.address) ?? 0n;
    if (got !== line.units) problems.push(`${getAddress(line.address)}: expected ${line.units} units, paid ${got}`);
    paid.delete(line.address);
  }
  for (const [address, value] of paid) problems.push(`${getAddress(address)}: paid ${value} units but is not in the export`);
  return problems;
}
