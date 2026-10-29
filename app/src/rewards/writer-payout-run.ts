// The weekly early-writer payout commands (export | check | record) as a function with injected dependencies, so every
// gate is tested. scripts/rewards/writer-payout.ts is the thin CLI around it. Nothing here holds a key, signs or sends.
//
// export: refuses until the indexer has read at least an hour past the week's end, until week N-1 is recorded, and if
//   week N was already exported. Finds contract wallets with eth_getCode once, and saves that list in the summary.
// check:  recomputes the table from the indexed history using the SAVED exclusions (no new eth_getCode), and compares
//   it with the SAVED csv, Safe batch and digest. Run it right before signing.
// record: validates the receipts against the SAVED export only (no recomputation, no database): every line paid exactly
//   once, nothing else, each transaction sent by the paying wallet after the export was made, and no transaction hash
//   reused from an earlier record.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import type { Sql } from "postgres";
import { decodeFunctionData, erc20Abi, getAddress, type Hex } from "viem";
import { programStatus, weekBounds, writerRewards, type WriterRewardsConfig } from "../config/writer-rewards";
import { indexedThroughSec } from "./writer-history";
import { contractWallets, payoutFiles, payoutLines, recordCheck, type PayoutLine, type ReceiptLog } from "./writer-payout";
import { buildWeek } from "./writer-week";

/** The export waits this long past the week's end for the indexer, so late blocks and reorgs have settled. */
export const EXPORT_SETTLE_SECONDS = 3_600;

export interface PayoutReceipt {
  readonly status: "success" | "reverted";
  readonly from: string;
  readonly blockNumber: bigint;
  readonly logs: readonly ReceiptLog[];
}

export interface PayoutDeps {
  readonly sql?: Sql;
  readonly pool?: string;
  readonly contracts?: Readonly<Record<string, string>>;
  readonly chainId?: number;
  readonly config?: WriterRewardsConfig;
  readonly getCode?: (address: string) => Promise<Hex | undefined>;
  readonly getReceipt?: (hash: Hex) => Promise<PayoutReceipt>;
  readonly getBlockTime?: (blockNumber: bigint) => Promise<number>;
  readonly now?: () => Date;
  /** Payout files may not be written inside this folder (the repository). */
  readonly repoRoot: string;
}

export interface PayoutResult {
  readonly code: 0 | 1;
  readonly out: string[];
}

class Refused extends Error {}
const refuse = (message: string): never => {
  throw new Refused(message);
};

interface SavedSummary {
  week: number;
  digest: string;
  token: string;
  from: string | null;
  generatedAt: string;
  allocatedUnits: string;
  excluded: { address: string; reason: string }[];
}

const flagOf = (args: readonly string[], name: string): string | undefined => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};

/** The paid lines of a saved export, read from the Safe batch and cross-checked with the CSV (both must agree). */
export function savedLines(dir: string, week: number, token: string): PayoutLine[] {
  const batch = JSON.parse(readFileSync(join(dir, `week-${week}.safe-batch.json`), "utf8")) as { transactions: { to: string; value: string; data: Hex }[] };
  const fromBatch = batch.transactions.map((tx) => {
    if (tx.to.toLowerCase() !== token.toLowerCase() || tx.value !== "0") refuse(`The saved Safe batch has a call that is not a ${token} transfer.`);
    const call = decodeFunctionData({ abi: erc20Abi, data: tx.data });
    if (call.functionName !== "transfer") refuse("The saved Safe batch has a call that is not transfer().");
    const [to, units] = call.args as [string, bigint];
    return { address: to.toLowerCase(), units };
  });
  const csv = readFileSync(join(dir, `week-${week}.csv`), "utf8").trim().split("\n").slice(1);
  const fromCsv = csv.map((row) => row.split(",")).filter((cells) => cells[6] !== "0")
    .map((cells) => ({ address: cells[0]!.toLowerCase(), units: BigInt(cells[6]!) }));
  const key = (lines: PayoutLine[]) => lines.map((line) => `${line.address}:${line.units}`).sort().join("|");
  if (key(fromBatch) !== key(fromCsv)) refuse(`week-${week}.csv and week-${week}.safe-batch.json disagree. Do not sign; export again into a new folder.`);
  return fromBatch;
}

/** Every transaction hash already used by a recorded week (lower case). */
export function recordedTxs(dir: string): Set<string> {
  const records = join(dir, "records");
  const out = new Set<string>();
  if (!existsSync(records)) return out;
  for (const name of readdirSync(records)) {
    if (!name.endsWith(".json")) continue;
    const body = JSON.parse(readFileSync(join(records, name), "utf8")) as { txs?: string[] };
    for (const hash of body.txs ?? []) out.add(hash.toLowerCase());
  }
  return out;
}

export async function runPayout(args: readonly string[], deps: PayoutDeps): Promise<PayoutResult> {
  const out: string[] = [];
  try {
    const config = deps.config ?? writerRewards;
    const now = deps.now ?? (() => new Date());
    const command = args[0];
    if (!["export", "check", "record"].includes(command ?? "")) {
      refuse("usage: writer-payout.ts export|check|record --week N --out <dir> [--from 0x..] [--no-contract-check] [--tx 0x..,0x..]");
    }
    const week = Number(flagOf(args, "week"));
    const bounds = weekBounds(week, config);
    if (!bounds) {
      refuse(config.tokenAddress ? `There is no reward week ${flagOf(args, "week")} (1..${config.weeks}).` : "Rewards start when $LMNS launches: set tokenAddress and startAt in src/config/writer-rewards.json first.");
    }
    if (programStatus(now().getTime(), config) === "off") refuse("Early-writer rewards are switched off in the config.");
    const outFlag = flagOf(args, "out");
    if (!outFlag) refuse("--out <dir> is required (a private folder outside the repository).");
    const dir = resolve(outFlag!);
    const rel = relative(resolve(deps.repoRoot), dir);
    if (!rel.startsWith("..") && !rel.startsWith("/")) refuse("Refusing to write payout files inside the repository. Pick a folder outside it.");
    const file = (name: string) => join(dir, name);
    const endSec = Math.floor(bounds!.endMs / 1_000);

    const needDb = () => {
      if (!deps.sql || !deps.pool) refuse("DATABASE_URL and DEPLOYMENT_FILE are needed for this command.");
      return { sql: deps.sql!, pool: deps.pool!, contracts: deps.contracts ?? {} };
    };
    const readSummary = (): SavedSummary => {
      if (!existsSync(file(`week-${week}.summary.json`))) refuse(`Week ${week} has not been exported to ${dir}.`);
      return JSON.parse(readFileSync(file(`week-${week}.summary.json`), "utf8")) as SavedSummary;
    };

    if (command === "export") {
      const { sql, pool, contracts } = needDb();
      const through = await indexedThroughSec(sql);
      if (through === null || through < endSec + EXPORT_SETTLE_SECONDS) {
        refuse(`Week ${week} is not final yet: the indexer has read up to ${through ? new Date(through * 1_000).toISOString() : "nothing"}; export from ${new Date((endSec + EXPORT_SETTLE_SECONDS) * 1_000).toISOString()} (an hour after the week ends).`);
      }
      if (week > 1 && !existsSync(file(`records/week-${week - 1}.json`))) {
        refuse(`Week ${week - 1} is not recorded yet. Send it, then run: writer-payout.ts record --week ${week - 1} --tx <hash>.`);
      }
      if (existsSync(file(`week-${week}.summary.json`)) || existsSync(file(`week-${week}.csv`)) || existsSync(file(`week-${week}.safe-batch.json`))) {
        refuse(`Week ${week} was already exported to ${dir}. Use check to compare; never overwrite an export.`);
      }
      const contractCheck = !args.includes("--no-contract-check");
      let extra = new Map<string, string>();
      if (contractCheck) {
        if (!deps.getCode) refuse("RPC_URL is not set (needed to find contract wallets). Pass --no-contract-check to skip it knowingly.");
        const first = await buildWeek({ sql, pool, contracts, week, nowSec: endSec, config });
        extra = await contractWallets(first!.rows.filter((row) => row.eligible).map((row) => row.address), deps.getCode!);
      }
      const table = (await buildWeek({ sql, pool, contracts, week, nowSec: endSec, extraExcluded: extra, config }))!;
      const excluded = table.rows.filter((row) => row.reason.startsWith("excluded")).map((row) => ({ address: row.address, reason: row.reason.replace(/^excluded: /, "") }));
      const from = flagOf(args, "from");
      const files = payoutFiles(table, {
        week, chainId: deps.chainId ?? 4663, token: config.tokenAddress, tokenSymbol: config.tokenSymbol, decimals: config.tokenDecimals,
        from: from ?? null, contractCheck: contractCheck ? "done" : "skipped", excluded, generatedAt: now().toISOString(),
      });
      mkdirSync(join(dir, "records"), { recursive: true });
      writeFileSync(file(`week-${week}.csv`), files.csv, { flag: "wx" });
      writeFileSync(file(`week-${week}.safe-batch.json`), JSON.stringify(files.safeBatch, null, 2) + "\n", { flag: "wx" });
      writeFileSync(file(`week-${week}.summary.json`), JSON.stringify(files.summary, null, 2) + "\n", { flag: "wx" });
      out.push(`Week ${week}: ${files.lines.length} transfers, ${files.summary.allocated} ${config.tokenSymbol} allocated, ${files.summary.unallocated} unallocated (stays with the owner). Digest ${table.digest}.`);
      out.push(`Unsigned files in ${dir}. Right before signing, run: writer-payout.ts check --week ${week} --out ${dir}. Then load week-${week}.safe-batch.json in the Safe Transaction Builder and sign.`);
      return { code: 0, out };
    }

    const summary = readSummary();
    if (summary.week !== week) refuse(`week-${week}.summary.json is for week ${summary.week}.`);
    const lines = savedLines(dir, week, summary.token);
    const allocated = lines.reduce((sum, line) => sum + line.units, 0n);
    if (allocated.toString() !== summary.allocatedUnits) refuse(`The saved export does not add up: ${allocated} in the batch, ${summary.allocatedUnits} in the summary.`);

    if (command === "check") {
      const { sql, pool, contracts } = needDb();
      // The SAVED exclusions, not a new eth_getCode: a wallet that became a contract after the export changes nothing.
      const saved = new Map(summary.excluded.map((row) => [row.address.toLowerCase(), row.reason]));
      const table = (await buildWeek({ sql, pool, contracts, week, nowSec: endSec, extraExcluded: saved, config }))!;
      const fresh = payoutLines(table);
      const key = (list: PayoutLine[]) => list.map((line) => `${line.address}:${line.units}`).sort().join("|");
      if (table.digest !== summary.digest || key(fresh) !== key(lines)) {
        refuse(`Week ${week} does not recompute to the saved export (saved digest ${summary.digest}, now ${table.digest}). Do not sign.`);
      }
      out.push(`Week ${week} recomputes to the saved export (digest ${table.digest}, ${lines.length} transfers). Safe to sign.`);
      return { code: 0, out };
    }

    // record
    if (!deps.getReceipt || !deps.getBlockTime) refuse("RPC_URL is not set (needed to read the payout receipts).");
    const txFlag = flagOf(args, "tx");
    if (!txFlag) refuse("--tx 0xhash[,0xhash] is required.");
    const hashes = txFlag!.split(",").map((value) => value.trim().toLowerCase() as Hex);
    if (new Set(hashes).size !== hashes.length) refuse("The same transaction hash is listed twice.");
    if (existsSync(file(`records/week-${week}.json`))) refuse(`Week ${week} is already recorded.`);
    const used = recordedTxs(dir);
    for (const hash of hashes) if (used.has(hash)) refuse(`Transaction ${hash} is already part of an earlier record.`);
    const payer = (flagOf(args, "from") ?? summary.from ?? "").toLowerCase();
    if (!/^0x[0-9a-f]{40}$/.test(payer)) refuse("--from <paying wallet> is required (the export did not name one).");
    const exportedAt = Math.floor(Date.parse(summary.generatedAt) / 1_000);
    const logs: ReceiptLog[] = [];
    for (const hash of hashes) {
      const receipt = await deps.getReceipt!(hash);
      if (receipt.status !== "success") refuse(`Transaction ${hash} did not succeed.`);
      if (receipt.from.toLowerCase() !== payer) refuse(`Transaction ${hash} was sent by ${receipt.from}, not the paying wallet ${getAddress(payer)}.`);
      const blockTime = await deps.getBlockTime!(receipt.blockNumber);
      if (blockTime <= exportedAt) refuse(`Transaction ${hash} was mined before the week ${week} export was made.`);
      logs.push(...receipt.logs);
    }
    const problems = recordCheck(lines, summary.token, logs);
    if (problems.length) refuse(`The receipts do not match the saved export:\n${problems.join("\n")}`);
    mkdirSync(join(dir, "records"), { recursive: true });
    writeFileSync(file(`records/week-${week}.json`), JSON.stringify({ week, digest: summary.digest, from: payer, txs: hashes, recordedAt: now().toISOString() }, null, 2) + "\n", { flag: "wx" });
    out.push(`Week ${week} recorded: every line paid exactly once by ${getAddress(payer)}. Week ${week + 1} can be exported an hour after it ends.`);
    return { code: 0, out };
  } catch (error) {
    if (error instanceof Refused) return { code: 1, out: [...out, error.message] };
    throw error;
  }
}
