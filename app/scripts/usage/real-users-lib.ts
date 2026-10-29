// Day-1 real-user count (crypto-token-utility: measure whether anyone outside the team uses the product).
// Pure parts live here so tests can drive them with a fake database.
import { existsSync, readFileSync } from "node:fs";

export type Queryable = (strings: TemplateStringsArray, ...values: unknown[]) => PromiseLike<unknown[]>;
export interface DayRow { day: string; account: string }
export interface DayReport { day: string; traders: number; depositors: number; either: number }

const ADDRESS = /0x[0-9a-fA-F]{40}/g;
const lower = (a: string) => a.toLowerCase();

/** Every address inside any JSON value (strings, arrays, objects). Used for the wallet pack, the deployment file and the
 * rewards config, whose shapes differ; an address anywhere in them counts as "not a real outside user". */
export function addressesIn(value: unknown, out = new Set<string>()): Set<string> {
  if (typeof value === "string") for (const m of value.match(ADDRESS) ?? []) out.add(lower(m));
  else if (Array.isArray(value)) for (const v of value) addressesIn(v, out);
  else if (value && typeof value === "object") for (const v of Object.values(value)) addressesIn(v, out);
  return out;
}

export interface ExclusionSources {
  walletPackFile?: string | undefined; // docs/runbooks/mainnet-addresses.json
  deploymentFile?: string | undefined; // contracts/deployments/mainnet.json (every Lemniscate contract)
  rewardsConfigFile?: string | undefined; // app/src/config/writer-rewards.json (projectWallets + EXCLUDED_WALLETS), when present
  excludedWallets?: string | undefined; // EXCLUDED_WALLETS env: comma or space separated
  extra?: string[];
}

export function collectExclusions(src: ExclusionSources): { excluded: Set<string>; used: string[] } {
  const excluded = new Set<string>(["0x0000000000000000000000000000000000000000"]);
  const used: string[] = [];
  for (const [label, file] of [["wallet pack", src.walletPackFile], ["deployment", src.deploymentFile], ["rewards config", src.rewardsConfigFile]] as const) {
    if (!file) continue;
    if (!existsSync(file)) throw new Error(`${label} file not found: ${file}`);
    const before = excluded.size;
    addressesIn(JSON.parse(readFileSync(file, "utf8")), excluded);
    used.push(`${label}: ${file} (${excluded.size - before} addresses)`);
  }
  const env = src.excludedWallets ?? "";
  const listed = env.split(/[\s,]+/).filter(Boolean);
  for (const a of listed) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(a)) throw new Error(`EXCLUDED_WALLETS has a bad address: ${a}`);
    excluded.add(lower(a));
  }
  if (listed.length) used.push(`EXCLUDED_WALLETS: ${listed.length} addresses`);
  for (const a of src.extra ?? []) excluded.add(lower(a));
  return { excluded, used };
}

/** Distinct (UTC day, wallet) pairs of everyone who traded and of everyone who deposited into the Writer Pool, straight
 * from the indexed events. Agent-router trades count for the owner behind the agent. */
export async function loadRows(sql: Queryable): Promise<{ trades: DayRow[]; deposits: DayRow[] }> {
  const trades = (await sql`
    SELECT to_char(ts AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, account
    FROM (SELECT ts, account FROM trades UNION ALL SELECT ts, owner AS account FROM agent_trades) AS t
    GROUP BY 1, 2 ORDER BY 1`) as DayRow[];
  const deposits = (await sql`
    SELECT to_char(ts AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, account
    FROM pool_events WHERE kind = 'deposit'
    GROUP BY 1, 2 ORDER BY 1`) as DayRow[];
  return { trades, deposits };
}

export function buildReport(rows: { trades: DayRow[]; deposits: DayRow[] }, excluded: Set<string>): DayReport[] {
  const traded = new Map<string, Set<string>>();
  const deposited = new Map<string, Set<string>>();
  const add = (map: Map<string, Set<string>>, { day, account }: DayRow) => {
    const a = lower(account);
    if (excluded.has(a)) return;
    (map.get(day) ?? map.set(day, new Set()).get(day)!).add(a);
  };
  for (const r of rows.trades) add(traded, r);
  for (const r of rows.deposits) add(deposited, r);
  const days = [...new Set([...traded.keys(), ...deposited.keys()])].sort();
  return days.map((day) => {
    const t = traded.get(day) ?? new Set<string>();
    const d = deposited.get(day) ?? new Set<string>();
    return { day, traders: t.size, depositors: d.size, either: new Set([...t, ...d]).size };
  });
}

export function formatReport(report: DayReport[], used: string[]): string {
  const lines = ["Real (non-team) wallets per UTC day, from indexed events", ...used.map((u) => `  excluded via ${u}`), ""];
  lines.push("day         traded  deposited  either");
  for (const r of report) lines.push(`${r.day}  ${String(r.traders).padStart(6)}  ${String(r.depositors).padStart(9)}  ${String(r.either).padStart(6)}`);
  if (report.length === 0) lines.push("(no events from outside wallets yet)");
  return lines.join("\n");
}
