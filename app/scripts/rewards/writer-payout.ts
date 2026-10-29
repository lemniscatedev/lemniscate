// Weekly early-writer $LMNS payout: an UNSIGNED export the owner signs and sends. This script never holds a key,
// never signs and never sends anything; it reads the indexer's Postgres and (for the contract-wallet check and the
// record step) a public RPC. The logic and every gate live in src/rewards/writer-payout-run.ts.
//
//   Export week N (an hour after the week ends, once week N-1 is recorded):
//     DATABASE_URL=... DEPLOYMENT_FILE=... RPC_URL=... bun run scripts/rewards/writer-payout.ts export --week N \
//       --out <dir outside the repo> --from <paying wallet> [--no-contract-check]
//   Right before signing, compare the saved export with the indexed history (uses the saved exclusions):
//     DATABASE_URL=... DEPLOYMENT_FILE=... bun run scripts/rewards/writer-payout.ts check --week N --out <dir>
//   After the owner sent the batch, record it (reads only the saved files and the receipts):
//     RPC_URL=... bun run scripts/rewards/writer-payout.ts record --week N --out <dir> --tx 0xhash[,0xhash...] [--from 0x..]
//
// Files in <dir>: week-N.csv, week-N.safe-batch.json (Safe Transaction Builder), week-N.summary.json, records/week-N.json.
import { resolve } from "node:path";
import postgres from "postgres";
import { createPublicClient, http, type Hex } from "viem";
import { loadOptionDeployment } from "../../src/chain/deployment";
import { runPayout, type PayoutDeps } from "../../src/rewards/writer-payout-run";

const args = process.argv.slice(2);
const repoRoot = resolve(import.meta.dir, "../../..");
const rpcUrl = process.env.RPC_URL;
const client = rpcUrl ? createPublicClient({ transport: http(rpcUrl, { retryCount: 2 }) }) : null;
const needsDb = args[0] === "export" || args[0] === "check";
const deployment = needsDb && process.env.DEPLOYMENT_FILE ? await loadOptionDeployment(process.env.DEPLOYMENT_FILE) : null;
const sql = needsDb && process.env.DATABASE_URL ? postgres(process.env.DATABASE_URL, { max: 2, idle_timeout: 5, connect_timeout: 10 }) : null;

const deps: PayoutDeps = {
  repoRoot,
  ...(sql ? { sql } : {}),
  ...(deployment?.contracts.pool ? { pool: deployment.contracts.pool, contracts: deployment.contracts as Record<string, string>, chainId: deployment.chainId } : {}),
  ...(client ? {
    getCode: async (address: string) => client.getCode({ address: address as Hex }),
    getReceipt: async (hash: Hex) => {
      const receipt = await client.getTransactionReceipt({ hash });
      return { status: receipt.status, from: receipt.from, blockNumber: receipt.blockNumber, logs: receipt.logs };
    },
    getBlockTime: async (blockNumber: bigint) => Number((await client.getBlock({ blockNumber })).timestamp),
  } : {}),
};

try {
  const result = await runPayout(args, deps);
  for (const line of result.out) (result.code === 0 ? console.log : console.error)(line);
  process.exitCode = result.code;
} finally {
  await sql?.end();
}
