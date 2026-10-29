// bun run report:users [--wallets <file>] [--deployment <file>] [--rewards-config <file>] [--json]
// Per UTC day: distinct non-team wallets that traded and that deposited, from indexed events. Excludes the wallet pack,
// every Lemniscate contract (deployment file), the writer-rewards config's project wallets and EXCLUDED_WALLETS (env).
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import postgres from "postgres";
import { buildReport, collectExclusions, formatReport, loadRows, type Queryable } from "./real-users-lib";

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set.");
  process.exit(2);
}
const root = resolve(import.meta.dir, "../..");
const firstExisting = (...paths: (string | undefined)[]) => paths.find((p) => p && existsSync(p));
const { excluded, used } = collectExclusions({
  walletPackFile: flag("wallets") ?? firstExisting(process.env.WALLET_PACK_FILE, resolve(root, "../../docs/runbooks/mainnet-addresses.json")),
  deploymentFile: flag("deployment") ?? firstExisting(process.env.DEPLOYMENT_FILE, resolve(root, "../contracts/deployments/mainnet.json")),
  rewardsConfigFile: flag("rewards-config") ?? firstExisting(resolve(root, "src/config/writer-rewards.json")),
  excludedWallets: process.env.EXCLUDED_WALLETS,
});
if (!used.some((u) => u.startsWith("wallet pack"))) console.error("report:users: warning: no wallet pack file found, team wallets are NOT excluded (--wallets <file>)");
const sql = postgres(url, { max: 1, idle_timeout: 5, connect_timeout: 10 });
try {
  const report = buildReport(await loadRows(sql as unknown as Queryable), excluded);
  console.log(process.argv.includes("--json") ? JSON.stringify(report, null, 2) : formatReport(report, used));
} finally {
  await sql.end({ timeout: 2 });
}
