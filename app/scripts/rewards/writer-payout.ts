// Weekly early-writer $LMNS payout: an UNSIGNED export the owner signs and sends. This script never holds a key,
// never signs and never sends anything; it reads the indexer's Postgres and (for the contract-wallet check and the
// record step) a public RPC.
//
//   Export week N (refuses until the indexer has read past the week's end and week N-1 is recorded):
//     DATABASE_URL=... DEPLOYMENT_FILE=... RPC_URL=... bun run scripts/rewards/writer-payout.ts export --week N \
//       --out <dir outside the repo> [--from <paying wallet>] [--no-contract-check]
//   Recompute and compare with the saved export (same digest or exit 1):
//     ... writer-payout.ts check --week N --out <dir>
//   After the owner sent the batch, record it (reads the receipts; every line paid exactly once, nothing else):
//     ... writer-payout.ts record --week N --out <dir> --tx 0xhash[,0xhash...]
//
// Files in <dir>: week-N.csv, week-N.safe-batch.json (Safe Transaction Builder), week-N.summary.json, records/week-N.json.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import postgres from "postgres";
import { createPublicClient, http, type Hex } from "viem";
import { loadOptionDeployment } from "../../src/chain/deployment";
import { programStatus, weekBounds, writerRewards } from "../../src/config/writer-rewards";
import { indexedThroughSec } from "../../src/rewards/writer-history";
import { contractWallets, payoutFiles, payoutLines, recordCheck } from "../../src/rewards/writer-payout";
import { buildWeek } from "../../src/rewards/writer-week";

const args = process.argv.slice(2);
const command = args[0];
const flag = (name: string): string | undefined => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};
const has = (name: string) => args.includes(`--${name}`);
const fail = (message: string): never => {
  console.error(message);
  process.exit(1);
};

if (!["export", "check", "record"].includes(command ?? "")) {
  fail("usage: writer-payout.ts export|check|record --week N --out <dir> [--from 0x..] [--no-contract-check] [--tx 0x..]");
}
const week = Number(flag("week"));
if (!weekBounds(week)) fail(writerRewards.tokenAddress ? `There is no reward week ${flag("week")} (1..${writerRewards.weeks}).` : "Rewards start when $LMNS launches: set tokenAddress and startAt in src/config/writer-rewards.json first.");
const bounds = weekBounds(week)!;
const outDir = resolve(flag("out") ?? fail("--out <dir> is required (a private folder outside the repository)."));
const repoRoot = resolve(import.meta.dir, "../../..");
const rel = relative(repoRoot, outDir);
if (!rel.startsWith("..") && !rel.startsWith("/")) fail("Refusing to write payout files inside the repository. Pick a folder outside it.");
const file = (name: string) => join(outDir, name);

const databaseUrl = process.env.DATABASE_URL ?? fail("DATABASE_URL is not set.");
const deploymentFile = process.env.DEPLOYMENT_FILE ?? fail("DEPLOYMENT_FILE is not set.");
const deployment = await loadOptionDeployment(deploymentFile);
const rpcUrl = process.env.RPC_URL;
const client = rpcUrl ? createPublicClient({ transport: http(rpcUrl, { retryCount: 2 }) }) : null;
const sql = postgres(databaseUrl, { max: 2, idle_timeout: 5, connect_timeout: 10 });

try {
  if (programStatus(Date.now()) === "off") fail("Early-writer rewards are switched off in the config.");
  const pool = deployment.contracts.pool ?? fail("The deployment file has no pool address.");
  const contracts = deployment.contracts as Record<string, string>;

  async function compute(contractCheck: boolean) {
    const endSec = Math.floor(bounds.endMs / 1_000);
    const through = await indexedThroughSec(sql);
    if (through === null || through < endSec) {
      fail(`Week ${week} is not final: the indexer has read up to ${through ? new Date(through * 1_000).toISOString() : "nothing"}, the week ends ${new Date(bounds.endMs).toISOString()}.`);
    }
    let extra = new Map<string, string>();
    if (contractCheck) {
      if (!client) fail("RPC_URL is not set (needed to find contract wallets). Pass --no-contract-check to skip it knowingly.");
      const first = await buildWeek({ sql, pool, contracts, week, nowSec: endSec });
      extra = await contractWallets(first!.rows.filter((row) => row.eligible).map((row) => row.address),
        async (address) => client!.getCode({ address: address as Hex }));
    }
    const table = (await buildWeek({ sql, pool, contracts, week, nowSec: endSec, extraExcluded: extra }))!;
    return { table, extra };
  }

  if (command === "export" || command === "check") {
    const contractCheck = !has("no-contract-check");
    const { table, extra } = await compute(contractCheck);
    if (command === "check") {
      const saved = JSON.parse(readFileSync(file(`week-${week}.summary.json`), "utf8")) as { digest: string };
      if (saved.digest !== table.digest) fail(`Digest mismatch for week ${week}: saved ${saved.digest}, recomputed ${table.digest}.`);
      console.log(`Week ${week} recomputes to the saved digest ${table.digest}.`);
    } else {
      if (week > 1 && !existsSync(file(`records/week-${week - 1}.json`))) {
        fail(`Week ${week - 1} is not recorded yet. Send it, then run: writer-payout.ts record --week ${week - 1} --tx <hash>.`);
      }
      if (existsSync(file(`week-${week}.summary.json`))) fail(`Week ${week} was already exported to ${outDir}. Use check to compare.`);
      mkdirSync(join(outDir, "records"), { recursive: true });
      const excluded = table.rows.filter((row) => row.reason.startsWith("excluded")).map((row) => ({ address: row.address, reason: row.reason }));
      for (const [address, reason] of extra) if (!excluded.some((row) => row.address === address)) excluded.push({ address, reason });
      const files = payoutFiles(table, {
        week, chainId: deployment.chainId, token: writerRewards.tokenAddress, tokenSymbol: writerRewards.tokenSymbol,
        decimals: writerRewards.tokenDecimals, from: flag("from") ?? null, contractCheck: contractCheck ? "done" : "skipped",
        excluded, generatedAt: new Date().toISOString(),
      });
      writeFileSync(file(`week-${week}.csv`), files.csv, { flag: "wx" });
      writeFileSync(file(`week-${week}.safe-batch.json`), JSON.stringify(files.safeBatch, null, 2) + "\n", { flag: "wx" });
      writeFileSync(file(`week-${week}.summary.json`), JSON.stringify(files.summary, null, 2) + "\n", { flag: "wx" });
      console.log(`Week ${week}: ${files.lines.length} transfers, ${files.summary.allocated} ${writerRewards.tokenSymbol} allocated, ${files.summary.unallocated} unallocated (stays with the owner). Digest ${table.digest}.`);
      console.log(`Unsigned files in ${outDir}. Review them, then load week-${week}.safe-batch.json in the Safe Transaction Builder and sign.`);
    }
  } else {
    if (!client) fail("RPC_URL is not set (needed to read the payout receipts).");
    const hashes = (flag("tx") ?? fail("--tx 0xhash[,0xhash] is required.")).split(",").map((value) => value.trim()) as Hex[];
    const { table } = await compute(!has("no-contract-check"));
    const saved = JSON.parse(readFileSync(file(`week-${week}.summary.json`), "utf8")) as { digest: string };
    if (saved.digest !== table.digest) fail(`Digest mismatch for week ${week}: the export is not what the history gives now.`);
    const logs = [];
    for (const hash of hashes) {
      const receipt = await client!.getTransactionReceipt({ hash });
      if (receipt.status !== "success") fail(`Transaction ${hash} did not succeed.`);
      logs.push(...receipt.logs);
    }
    const problems = recordCheck(payoutLines(table), writerRewards.tokenAddress, logs);
    if (problems.length) fail(`The receipts do not match the export:\n${problems.join("\n")}`);
    writeFileSync(file(`records/week-${week}.json`), JSON.stringify({ week, digest: table.digest, txs: hashes, recordedAt: new Date().toISOString() }, null, 2) + "\n", { flag: "wx" });
    console.log(`Week ${week} recorded: every line paid exactly once. Week ${week + 1} can be exported after it ends.`);
  }
} finally {
  await sql.end();
}
