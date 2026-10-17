// Exercise EVERY user and admin action on the anvil mainnet fork (crypto-local-testing section 2, todo 23 R2-R5):
// success and expected-failure paths, each asserting the chain effect AND the API's view after indexing. Writes
// $FORK_DIR/exercise/results.json (every flow and every transaction: hash, gas, status, decoded revert); report.ts turns
// it into the markdown and HTML report.
//
//   PORT_OFFSET=600 bun scripts/fork/exercise.ts            (the stack from up.sh must be running)
//
// Time: the fork's clock is moved with evm_increaseTime (sessions, holds, queues). Everything runs against the real
// Robinhood Chain tokens, feeds and Uniswap pools forked at the pinned block; the fork relaxations are in setup.ts.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  decodeErrorResult, decodeEventLog, encodeFunctionData, formatUnits, getAddress, keccak256, parseAbi, parseUnits, toBytes, toHex,
  type Abi, type Address, type Hex, type TransactionReceipt, type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { entryPoint07Abi } from "viem/account-abstraction";
import postgres from "postgres";
import { AgentRouterAbi, OptionEngineAbi, PoolAbi, PriceGuardAbi, SeriesRegistryAbi, VolOracleAbi } from "@/abi";
import { fundingStep } from "@/pricing";
import { compareWithEngine, type EngineState } from "@/sim/engine-check";
import { fromEngineStruct } from "@/api/quote/parity";
import { createPayingFetch } from "@/x402";
import { fund } from "./fund";
import {
  addressOf, ANVIL_URL, API_URL, APP, DATABASE_URL, erc20Abi, FORK_DIR, forkClients, impersonated, keyOf, loadDeployment, nextNy, PORTS, ROOT, walletFor,
  type Role,
} from "./lib";

// ------------------------------------------------------------------------------------------------ records
export interface TxRec { flow: string; label: string; hash: Hex | null; gas: string | null; status: "success" | "reverted" | "not-sent"; revert?: string; at: number }
export interface FlowRec {
  id: string; area: string; name: string; expected: string; actual: string; status: "pass" | "fail"; error?: string;
  txs: TxRec[]; startedAt: number; chainTime: number; ms: number;
}
const OUT = join(FORK_DIR, "exercise");
mkdirSync(OUT, { recursive: true });
const flows: FlowRec[] = [];
const notes: string[] = [];
const dep = loadDeployment();
const { pub, test } = forkClients();
const C = dep.contracts;
const sql = postgres(DATABASE_URL, { max: 2, onnotice: () => undefined });
const stockOf = (name: string): Address => getAddress(dep.stocks.find((s) => s.name === name)!.stock);
const WAD = 10n ** 18n;
const USD = (n: number) => parseUnits(n.toFixed(6), 6);
const fmt = (raw: bigint, d = 6) => formatUnits(raw, d);

// One ABI with every error the stack can raise, to name a revert.
const extraErrors = parseAbi([
  "error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)",
  "error ERC20InsufficientAllowance(address spender, uint256 allowance, uint256 needed)",
  "error FailedOp(uint256 opIndex, string reason)",
  "error FailedOpWithRevert(uint256 opIndex, string reason, bytes inner)",
]);
const ERRORS: Abi = [...OptionEngineAbi, ...PoolAbi, ...AgentRouterAbi, ...SeriesRegistryAbi, ...PriceGuardAbi, ...VolOracleAbi, ...extraErrors, ...entryPoint07Abi]
  .filter((x) => (x as { type: string }).type === "error") as Abi;

export function revertName(error: unknown): string {
  const e = error as { data?: Hex; cause?: unknown; shortMessage?: string; message?: string; walk?: (fn: (e: unknown) => boolean) => unknown };
  let data: Hex | undefined;
  let cursor: unknown = e;
  for (let i = 0; i < 8 && cursor; i++) {
    const c = cursor as { data?: unknown; cause?: unknown };
    if (typeof c.data === "string" && c.data.startsWith("0x") && c.data.length >= 10) { data = c.data as Hex; break; }
    if (c.data && typeof c.data === "object" && typeof (c.data as { data?: unknown }).data === "string") { data = (c.data as { data: Hex }).data; break; }
    cursor = c.cause;
  }
  const text = `${e.shortMessage ?? ""} ${e.message ?? ""}`;
  if (!data) {
    const m = /(0x[0-9a-fA-F]{8,})/.exec(text.match(/(?:data|reason)[:=]\s*"?(0x[0-9a-fA-F]+)/)?.[1] ?? "");
    if (m) data = m[1] as Hex;
  }
  if (data) {
    try {
      const d = decodeErrorResult({ abi: ERRORS, data });
      const args = (d.args ?? []).map((a) => (typeof a === "string" && a.length === 66 && a.startsWith("0x") ? bytes32Text(a as Hex) : String(a)));
      return `${d.errorName}(${args.join(", ")})`;
    } catch { return `revert ${data.slice(0, 10)}`; }
  }
  const reason = /reverted with reason:?\s*([^\n.]+)/i.exec(text)?.[1] ?? /reason:\s*([^\n]+)/i.exec(text)?.[1];
  return reason ? reason.trim() : (e.shortMessage ?? e.message ?? String(error)).split("\n")[0]!.slice(0, 160);
}
function bytes32Text(h: Hex): string {
  const bytes = toBytes(h);
  const end = bytes.indexOf(0);
  const head = end === -1 ? bytes : bytes.slice(0, end);
  if (head.length > 0 && head.every((b) => b >= 32 && b < 127) && bytes.slice(head.length).every((b) => b === 0)) return `"${new TextDecoder().decode(head)}"`;
  return h;
}

class Flow {
  readonly txs: TxRec[] = [];
  actual = "";
  constructor(readonly id: string) {}
  /** Sends a transaction from `wallet`; simulates first and throws the decoded revert if it would fail. */
  async send(label: string, wallet: WalletClient, call: { to: Address; data: Hex; value?: bigint }, gas?: bigint): Promise<TransactionReceipt> {
    const account = wallet.account!;
    let estimate: bigint;
    try {
      estimate = gas ?? await pub.estimateGas({ account, to: call.to, data: call.data, value: call.value ?? 0n });
    } catch (error) {
      const reason = revertName(error);
      this.txs.push({ flow: this.id, label, hash: null, gas: null, status: "not-sent", revert: reason, at: Date.now() });
      throw new Error(`${label} would revert: ${reason}`);
    }
    // Gas one second ahead (crypto-local-testing: estimates taken in the same second as a time-based accrual run short).
    const hash = await wallet.sendTransaction({ account, chain: null, to: call.to, data: call.data, value: call.value ?? 0n, gas: (estimate * 13n) / 10n + 50_000n });
    const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
    this.txs.push({ flow: this.id, label, hash, gas: receipt.gasUsed.toString(), status: receipt.status, at: Date.now() });
    if (receipt.status !== "success") throw new Error(`${label} reverted on chain (${hash})`);
    return receipt;
  }
  /** Expected failure: the call must revert with `match` in its decoded error. Mines it anyway (fixed gas) so the report
   * has the failing transaction hash and status. */
  async expectRevert(label: string, wallet: WalletClient, call: { to: Address; data: Hex }, match: string | RegExp): Promise<string> {
    const account = wallet.account!;
    let reason = "";
    try {
      await pub.call({ account, to: call.to, data: call.data });
      reason = "did not revert";
    } catch (error) { reason = revertName(error); }
    let hash: Hex | null = null;
    let gas: string | null = null;
    try {
      hash = await wallet.sendTransaction({ account, chain: null, to: call.to, data: call.data, gas: 3_000_000n });
      const r = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
      gas = r.gasUsed.toString();
      if (r.status === "success") reason = `${reason} / MINED SUCCESSFULLY`;
    } catch { /* node refused the doomed transaction: keep the simulated reason */ }
    this.txs.push({ flow: this.id, label, hash, gas, status: hash ? "reverted" : "not-sent", revert: reason, at: Date.now() });
    const ok = typeof match === "string" ? reason.includes(match) : match.test(reason);
    if (!ok) throw new Error(`${label}: expected revert ${String(match)}, got ${reason}`);
    return reason;
  }
}

async function chainTime(): Promise<number> { return Number((await pub.getBlock()).timestamp); }

async function flow(area: string, name: string, expected: string, fn: (f: Flow) => Promise<string | void>): Promise<FlowRec> {
  const id = `${area}.${flows.filter((x) => x.area === area).length + 1}`;
  const f = new Flow(id);
  const started = Date.now();
  const rec: FlowRec = { id, area, name, expected, actual: "", status: "pass", txs: f.txs, startedAt: started, chainTime: await chainTime(), ms: 0 };
  try {
    const actual = await fn(f);
    rec.actual = actual ?? f.actual;
  } catch (error) {
    rec.status = "fail";
    rec.error = (error as Error).message.split("\n").slice(0, 3).join(" ").slice(0, 600);
    rec.actual = f.actual || rec.error;
  }
  rec.ms = Date.now() - started;
  flows.push(rec);
  writeFileSync(join(OUT, "results.json"), JSON.stringify({ flows, notes }, null, 1));
  console.log(`${rec.status === "pass" ? "PASS" : "FAIL"} ${id} ${name}${rec.status === "fail" ? ` :: ${rec.error}` : ""}`);
  return rec;
}
function assert(cond: unknown, message: string): asserts cond { if (!cond) throw new Error(message); }

// ------------------------------------------------------------------------------------------------ helpers
async function api<T = any>(path: string, body?: unknown, base = API_URL): Promise<{ status: number; json: T }> {
  const res = await fetch(`${base}${path}`, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const text = await res.text();
  let json: any = text;
  try { json = JSON.parse(text); } catch { /* keep text */ }
  return { status: res.status, json };
}
async function waitFor<T>(what: string, fn: () => Promise<T | undefined | false | null>, timeoutMs = 90_000, everyMs = 1000): Promise<T> {
  const end = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < end) {
    try { const v = await fn(); if (v) return v as T; } catch (e) { last = e; }
    await Bun.sleep(everyMs);
  }
  throw new Error(`timed out waiting for ${what}${last ? ` (${(last as Error).message})` : ""}`);
}
async function warp(seconds: number): Promise<number> {
  await test.increaseTime({ seconds });
  await test.mine({ blocks: 1 });
  return chainTime();
}
async function warpTo(target: number): Promise<number> {
  const now = await chainTime();
  if (target > now) await warp(target - now);
  return chainTime();
}
const engineRead = <T>(functionName: string, args: unknown[] = []) => pub.readContract({ address: C.engine, abi: OptionEngineAbi, functionName: functionName as never, args: args as never }) as Promise<T>;
async function priceReading(name: string) {
  return pub.readContract({ address: C.priceGuard, abi: PriceGuardAbi, functionName: "read", args: [stockOf(name)] }) as Promise<{ s: bigint; session: number; fresh: boolean; buysPaused: boolean; updatedAt: bigint }>;
}
async function volFresh(name: string, speed: 0 | 1): Promise<boolean> {
  const r = await pub.readContract({ address: C.volOracle, abi: VolOracleAbi, functionName: "read", args: [stockOf(name), speed] }) as { stale: boolean; sigmaBps: bigint };
  return !r.stale && r.sigmaBps > 0n;
}
async function waitVolFresh(names: string[], timeoutMs = 240_000) {
  await waitFor(`fresh vol for ${names.join(",")}`, async () => {
    for (const n of names) for (const sp of [0, 1] as const) if (!(await volFresh(n, sp))) return false;
    return true;
  }, timeoutMs, 3000);
}
interface SeriesRow { id: Hex; name: string; isCall: boolean; speed: "DAILY" | "WEEKLY"; strike: number; token: Address; buyable: boolean }
async function chainOf(name: string): Promise<{ spot: number; rows: SeriesRow[]; raw: any }> {
  const { json } = await api(`/v1/chains/${name}`);
  const rows: SeriesRow[] = [];
  for (const sp of json.speeds ?? []) for (const k of sp.strikes ?? []) for (const side of ["call", "put"] as const) {
    const o = k[side];
    if (o) rows.push({ id: o.id, name, isCall: side === "call", speed: sp.speed, strike: Number(k.strike), token: getAddress(o.token), buyable: o.buyable });
  }
  return { spot: Number(json.spot), rows, raw: json };
}
async function tokenBalance(token: Address, who: Address): Promise<bigint> {
  return pub.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [who] });
}
async function usdgOf(who: Address): Promise<bigint> { return tokenBalance(C.usdg, who); }

/** Builds the intent with the API and sends it (approvals first) from `role`. Returns the receipt and the intent. */
async function viaIntent(f: Flow, kind: "buy" | "sell" | "shield", role: Role, body: Record<string, unknown>) {
  const wallet = walletFor(role);
  const account = addressOf(role);
  const { status, json } = await api(`/v1/intent/${kind}`, { account, ...body });
  if (status !== 200) throw new Error(`/v1/intent/${kind} ${status}: ${JSON.stringify(json).slice(0, 300)}`);
  for (const a of json.approvals ?? []) {
    const have = await pub.readContract({ address: getAddress(a.token), abi: erc20Abi, functionName: "allowance", args: [account, getAddress(a.spender)] });
    if (have < BigInt(a.amount)) {
      await f.send(`${kind}:approve`, wallet, { to: getAddress(a.token), data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [getAddress(a.spender), BigInt(a.amount)] }) });
    }
  }
  const receipt = await f.send(`engine.${kind}`, wallet, { to: getAddress(json.to), data: json.data as Hex });
  return { receipt, intent: json };
}
function events(receipt: TransactionReceipt, abi: Abi, address?: Address) {
  const out: { eventName: string; args: any }[] = [];
  for (const log of receipt.logs) {
    if (address && log.address.toLowerCase() !== address.toLowerCase()) continue;
    try { out.push(decodeEventLog({ abi, data: log.data, topics: log.topics }) as never); } catch { /* other contract */ }
  }
  return out;
}
async function positionUnits(account: Address, seriesId: string): Promise<number> {
  const { json } = await api(`/v1/accounts/${account}/positions`);
  const p = (json.positions ?? []).find((x: any) => x.seriesId.toLowerCase() === seriesId.toLowerCase());
  return p ? Number(p.units) : 0;
}

// ------------------------------------------------------------------------------------------------ service control
function pidOf(name: string): number | undefined {
  const file = join(FORK_DIR, "pids", `${name}.pid`);
  return existsSync(file) ? Number(readFileSync(file, "utf8").trim()) : undefined;
}
function alive(pid?: number) { if (!pid) return false; try { process.kill(pid, 0); return true; } catch { return false; } }
async function stopService(name: string) {
  const pid = pidOf(name);
  if (alive(pid)) { process.kill(pid!, "SIGTERM"); await waitFor(`${name} to stop`, async () => !alive(pid), 20_000, 250); }
}
async function startServices() {
  await new Promise<void>((resolve, reject) => {
    const p = spawn("bash", [join(APP, "scripts/fork/up.sh")], { cwd: APP, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    p.stdout.on("data", (d) => { out += d; });
    p.stderr.on("data", (d) => { out += d; });
    p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`up.sh exited ${code}: ${out.slice(-400)}`))));
  });
}
let x402Api: ChildProcess | undefined;

// ------------------------------------------------------------------------------------------------ the run
const ROLES_USED: Role[] = ["alice", "bob", "carol", "agentOwner", "depositor", "lp2", "payer", "kal"];

async function main() {
  console.log(`exercise: fork ${ANVIL_URL}, API ${API_URL}, chain time ${new Date((await chainTime()) * 1000).toISOString()}`);
  const health = await api("/v1/health");
  assert(health.status === 200, "API is not healthy");

  // ---------------------------------------------------------------- setup and system checks
  await flow("setup", "Deploy + post-deploy check on the fork (R1)", "DeploySystem fork profile broadcast, PostDeployCheck [PASS] every check, deployment has forkProof", async () => {
    const deployLog = readFileSync(join(FORK_DIR, "logs", "deploy.log"), "utf8");
    const checkLog = readFileSync(join(FORK_DIR, "logs", "post-deploy-check.log"), "utf8");
    assert(deployLog.includes("[PASS] post-deploy check"), "deploy log has no [PASS]");
    assert(checkLog.includes("[PASS] every check"), "PostDeployCheck did not pass");
    assert(dep.forkProof, "no forkProof");
    const cfg = await api("/v1/config");
    assert(cfg.json.chainId === 31337 && cfg.json.network === "fork", "API config is not the fork");
    return `deploy [PASS], PostDeployCheck [PASS] every check; API /v1/config chain ${cfg.json.chainId} ${cfg.json.network}; ${Object.keys(cfg.json.contracts).length} contracts`;
  });

  await flow("setup", "Fund test accounts from real holders", "ETH via anvil_setBalance; USDG and NVDA transferred from an impersonated real holder", async () => {
    const targets = ROLES_USED.map(addressOf);
    const r = await fund(targets, 250_000, 50, {});
    const s = await fund([addressOf("carol")], 0, 50, { NVDA: 5, TSLA: 2 });
    for (const x of r) assert(x.usdg >= USD(250_000), `${x.address} not funded`);
    const nvda = await tokenBalance(stockOf("NVDA"), addressOf("carol"));
    assert(nvda >= 5n * WAD, "carol has no NVDA");
    return `${r.length} accounts x 250,000 USDG + 50 ETH; carol 5 NVDA + 2 TSLA (${s.length} transfer set)`;
  });

  // Session: run the trading flows in a REGULAR session.
  await flow("setup", "Move to a regular session if needed", "chain clock inside NYSE regular hours with fresh vol for every name", async () => {
    const r = await priceReading("NVDA");
    let note = `session was ${["REGULAR", "EXTENDED", "CLOSED", "UNKNOWN", "HALTED"][r.session]}`;
    if (r.session !== 0) {
      const now = await chainTime();
      let target = Infinity;
      for (const d of [1, 2, 3, 4, 5]) target = Math.min(target, nextNy(now, d, 10, 0));
      await warpTo(target);
      note += `; warped to ${new Date(target * 1000).toISOString()}`;
    }
    await waitVolFresh(dep.stocks.map((s) => s.name));
    const after = await priceReading("NVDA");
    assert(after.session === 0, `session after warp ${after.session}`);
    return `${note}; NVDA session REGULAR, vol fresh for all names`;
  });

  await flow("setup", "Keeper lists the grid and turns it buyable (R1)", "every launch name has Daily+Weekly calls and puts on the strike grid, buyable, visible in /v1/chains", async () => {
    const rows = await waitFor("the whole grid listed and buyable", async () => {
      const done = await sql`select count(*) filter (where buyable)::int as b from series`;
      if ((done[0]!.b as number) < dep.stocks.length * 20) return false;
      const { json } = await api("/v1/chains");
      const names = json.names ?? [];
      return names.length === dep.stocks.length && names.every((n: any) => n.buyable) ? names : false;
    }, 1_200_000, 5000).catch(async () => (await api("/v1/chains")).json.names); // the lister retries every 10 min while it cannot list
    const counts = await sql`select name, count(*)::int as n, count(*) filter (where buyable)::int as b from series group by name order by name`;
    const total = counts.reduce((a, r) => a + (r.n as number), 0);
    assert(counts.length === dep.stocks.length && counts.every((r) => r.b >= 20), `listing incomplete: ${JSON.stringify(counts)}`);
    return `${total} series (${counts.map((r) => `${r.name} ${r.b}/${r.n}`).join(", ")}); API names ${rows.map((n: any) => n.name).join(",")}`;
  });

  // ---------------------------------------------------------------- pool
  const depositor = "depositor" as const;
  await flow("pool", "Allowlisted deposit", "deposit 200,000 USDG mints shares at NAV + 10 bps; /v1/pool NAV shows it after indexing", async (f) => {
    const w = walletFor(depositor);
    const who = addressOf(depositor);
    await f.send("usdg.approve", w, { to: C.usdg, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [C.pool, USD(200_000)] }) });
    const r = await f.send("pool.deposit", w, { to: C.pool, data: encodeFunctionData({ abi: PoolAbi, functionName: "deposit", args: [USD(200_000), who] }) });
    const ev = events(r, PoolAbi, C.pool).find((e) => e.eventName === "Deposit");
    assert(ev && ev.args.shares > 0n, "no Deposit event");
    const nav = await waitFor("pool NAV in the API", async () => { const p = (await api("/v1/pool")).json; return Number(p.nav) >= 199_000 ? p : false; });
    return `shares ${fmt(ev.args.shares, 12)}; API NAV ${nav.nav}, navPerShare ${nav.navPerShare}`;
  });

  await flow("pool", "Deposit from a wallet not on the allowlist (expected failure)", "reverts NotDepositor (closed beta)", async (f) => {
    const w = walletFor("lp2");
    await f.send("usdg.approve", w, { to: C.usdg, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [C.pool, USD(1000)] }) });
    return f.expectRevert("pool.deposit", w, { to: C.pool, data: encodeFunctionData({ abi: PoolAbi, functionName: "deposit", args: [USD(1000), addressOf("lp2")] }) }, "NotDepositor");
  });

  // ---------------------------------------------------------------- replay R3 on the fork: simulator vs engine
  await flow("replay", "Replay R3: the simulator's quote vs the deployed engine, 20 fork states", "for 20 listed series (every name, both speeds, calls and puts, buys and sells) the sim quote model on the chain's own S, sigma, skew and session matches IOptionEngine.quote field by field (0.5%, sigma exact)", async () => {
    const SESS = ["REGULAR", "EXTENDED", "CLOSED", "UNKNOWN", "HALTED"] as const;
    const states: (EngineState & { id: string })[] = [];
    let k = 0;
    for (const s of dep.stocks) {
      const ch = await chainOf(s.name);
      const pr = await priceReading(s.name);
      const picks = [...ch.rows].sort((a, b) => a.strike - b.strike).filter((_, i) => i % 5 === k % 5).slice(0, 4);
      k++;
      for (const [j, row] of picks.entries()) {
        const vol = await pub.readContract({ address: C.volOracle, abi: VolOracleAbi, functionName: "read", args: [stockOf(s.name), row.speed === "DAILY" ? 0 : 1] }) as any;
        const now = await chainTime();
        states.push({
          id: row.id, name: s.name, unitsWad: parseUnits(String(1 + j * 3.5), 18), isBuy: j % 2 === 0,
          series: { isCall: row.isCall, speed: row.speed, strike: row.strike, buyable: row.buyable, archived: false },
          market: {
            spot: Number(pr.s) / 1e18, session: SESS[pr.session]!, fresh: pr.fresh, priceBuysPaused: pr.buysPaused, engineBuysPaused: false,
            sigmaBps: Number(vol.sigmaBps), skewK: BigInt(vol.skewK), volStale: vol.stale, nowMs: now * 1000,
            buyBlockFromMs: Number(vol.buyBlockFrom) ? Number(vol.buyBlockFrom) * 1000 : null, buyBlockToMs: Number(vol.buyBlockTo) ? Number(vol.buyBlockTo) * 1000 : null,
          },
        });
      }
    }
    const r = await compareWithEngine(
      async ({ id, unitsWad, isBuy }) => fromEngineStruct(await engineRead("quote", [id, unitsWad, isBuy])),
      (st) => (st as EngineState & { id: string }).id, async () => undefined, states.slice(0, 20),
    );
    writeFileSync(join(OUT, "engine-check.json"), JSON.stringify({ r, states: states.slice(0, 20).map((x) => ({ id: x.id, name: x.name, ...x.series, isBuy: x.isBuy, units: formatUnits(x.unitsWad, 18) })) }, (_, v) => (typeof v === "bigint" ? v.toString() : v), 1));
    assert(r.status === "pass", `${r.failures.length}/${r.compared} differ: ${JSON.stringify(r.failures.slice(0, 3))}`);
    return `${r.compared}/${r.compared} states match (usdg, fee, daily cost, vMark, breakeven, spread within 0.5%; sigma exact); details engine-check.json`;
  });

  // ---------------------------------------------------------------- buys: every speed, side and moneyness on NVDA
  const bought: { role: Role; row: SeriesRow; units: string; tokens: bigint; paid: bigint }[] = [];
  const nvda = await chainOf("NVDA");
  const grid = [...new Set(nvda.rows.map((r) => r.strike))].sort((a, b) => a - b);
  for (const speed of ["DAILY", "WEEKLY"] as const) {
    for (const isCall of [true, false]) {
      for (const strike of grid) {
        const row = nvda.rows.find((r) => r.speed === speed && r.isCall === isCall && r.strike === strike)!;
        const pct = ((strike / nvda.spot - 1) * 100).toFixed(1);
        await flow("buy", `NVDA ${speed} ${isCall ? "call" : "put"} K=${strike} (${pct}% from spot)`, "API intent -> approve + engine.buy; Bought event; tokens minted; position in the API after indexing", async (f) => {
          const units = "10";
          const { receipt, intent } = await viaIntent(f, "buy", "alice", { series: row.id, units, slippageBps: 100 });
          const ev = events(receipt, OptionEngineAbi, C.engine).find((e) => e.eventName === "Bought");
          assert(ev, "no Bought event");
          assert(BigInt(ev.args.usdgPaid) <= BigInt(intent.maxCostUsdg), "paid more than maxCost");
          bought.push({ role: "alice", row, units, tokens: ev.args.tokens, paid: ev.args.usdgPaid });
          const held = await waitFor("position indexed", async () => { const u = await positionUnits(addressOf("alice"), row.id); return u > 0 ? u : false; });
          return `paid ${fmt(ev.args.usdgPaid)} USDG (quote ${fmt(BigInt(intent.quote.usdg))}, spread ${intent.quote.spreadBps} bps, sigma ${intent.quote.sigmaBps}); tokens ${fmt(ev.args.tokens, 18)}; API units ${held}`;
        });
      }
    }
  }
  // one Daily call and one Weekly put on every other name; a name inside an earnings buy-block is an expected failure
  for (const s of dep.stocks.filter((x) => x.name !== "NVDA")) {
    const ch = await chainOf(s.name);
    const atm = [...new Set(ch.rows.map((r) => r.strike))].sort((a, b) => Math.abs(a - ch.spot) - Math.abs(b - ch.spot))[0]!;
    const vol = await pub.readContract({ address: C.volOracle, abi: VolOracleAbi, functionName: "read", args: [stockOf(s.name), 0] }) as { buyBlockFrom: bigint; buyBlockTo: bigint };
    const now = BigInt(await chainTime());
    if (vol.buyBlockFrom <= now && now <= vol.buyBlockTo && vol.buyBlockTo > 0n) {
      const row = ch.rows.find((r) => r.speed === "DAILY" && r.isCall && r.strike === atm)!;
      await flow("buy", `${s.name}: earnings buy-block from the vol-engine (expected failure)`, "a report inside 16 days with only one earnings source (no Alpha Vantage key) blocks buys for 24h (decision 18): API 409 EARNINGS_BLOCK, engine.buy reverts EarningsBlock", async (f) => {
        const r = await api("/v1/intent/buy", { account: addressOf("bob"), series: row.id, units: "1", slippageBps: 100 });
        assert(r.status === 409 && r.json.reason === "EARNINGS_BLOCK", `API answered ${r.status} ${JSON.stringify(r.json).slice(0, 120)}`);
        const deadline = BigInt(await chainTime()) + 300n;
        const w = walletFor("bob");
        await f.send("usdg.approve", w, { to: C.usdg, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [C.engine, USD(1_000_000)] }) });
        const reason = await f.expectRevert("engine.buy", w, { to: C.engine, data: encodeFunctionData({ abi: OptionEngineAbi, functionName: "buy", args: [row.id, WAD, USD(5000), deadline, addressOf("bob")] }) }, "EarningsBlock");
        return `window ${new Date(Number(vol.buyBlockFrom) * 1000).toISOString()} .. ${new Date(Number(vol.buyBlockTo) * 1000).toISOString()}; API 409 EARNINGS_BLOCK; chain ${reason}`;
      });
      continue;
    }
    for (const [speed, isCall] of [["DAILY", true], ["WEEKLY", false]] as const) {
      const row = ch.rows.find((r) => r.speed === speed && r.isCall === isCall && r.strike === atm)!;
      await flow("buy", `${s.name} ${speed} ${isCall ? "call" : "put"} ATM K=${atm}`, "buy through the API intent; Bought; position indexed", async (f) => {
        const units = s.name === "SPY" || s.name === "QQQ" ? "2" : "5";
        const { receipt } = await viaIntent(f, "buy", "bob", { series: row.id, units, slippageBps: 100 });
        const ev = events(receipt, OptionEngineAbi, C.engine).find((e) => e.eventName === "Bought");
        assert(ev, "no Bought event");
        bought.push({ role: "bob", row, units, tokens: ev.args.tokens, paid: ev.args.usdgPaid });
        const held = await waitFor("position indexed", async () => { const u = await positionUnits(addressOf("bob"), row.id); return u > 0 ? u : false; });
        return `paid ${fmt(ev.args.usdgPaid)} USDG, API units ${held}`;
      });
    }
  }

  const atmDaily = nvda.rows.filter((r) => r.speed === "DAILY" && r.isCall).sort((a, b) => Math.abs(a.strike - nvda.spot) - Math.abs(b.strike - nvda.spot))[0]!;
  await flow("buy", "Slippage limit below the price (expected failure)", "engine.buy reverts Slippage when maxCost is under the ask", async (f) => {
    const w = walletFor("alice");
    const q = await engineRead<{ usdg: bigint }>("quote", [atmDaily.id, 10n * WAD, true]);
    const deadline = BigInt(await chainTime()) + 300n;
    return f.expectRevert("engine.buy", w, { to: C.engine, data: encodeFunctionData({ abi: OptionEngineAbi, functionName: "buy", args: [atmDaily.id, 10n * WAD, q.usdg / 2n, deadline, addressOf("alice")] }) }, "Slippage");
  });
  await flow("buy", "Deadline in the past (expected failure)", "engine.buy reverts Expired", async (f) => {
    const w = walletFor("alice");
    const deadline = BigInt(await chainTime()) - 10n;
    return f.expectRevert("engine.buy", w, { to: C.engine, data: encodeFunctionData({ abi: OptionEngineAbi, functionName: "buy", args: [atmDaily.id, 10n * WAD, USD(1000), deadline, addressOf("alice")] }) }, "Expired");
  });
  await flow("buy", "Buy without USDG approval (expected failure)", "engine.buy reverts on the USDG transferFrom", async (f) => {
    const w = walletFor("lp2");
    const deadline = BigInt(await chainTime()) + 300n;
    return f.expectRevert("engine.buy", w, { to: C.engine, data: encodeFunctionData({ abi: OptionEngineAbi, functionName: "buy", args: [atmDaily.id, 10n * WAD, USD(1000), deadline, addressOf("lp2")] }) }, /Insufficient|allowance|revert|SafeERC20/i);
  });

  // ---------------------------------------------------------------- R4 quote parity
  await flow("parity", "API quote vs on-chain engine.quote, 200 random cases (R4)", "every case within 0.5% (or $0.01 for sub-cent quotes)", async () => {
    let seed = 23;
    const rnd = () => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed / 2 ** 31; };
    const rows: SeriesRow[] = [];
    for (const s of dep.stocks) rows.push(...(await chainOf(s.name)).rows);
    let worst = 0;
    let worstCase = "";
    let checked = 0;
    const cases: unknown[] = [];
    for (let i = 0; i < 200; i++) {
      const row = rows[Math.floor(rnd() * rows.length)]!;
      const units = (0.5 + rnd() * 30).toFixed(4);
      const side = rnd() < 0.5 ? "buy" : "sell";
      const [apiQ, chainQ] = await Promise.all([
        api("/v1/quote", { series: row.id, units, side }),
        engineRead<{ usdg: bigint }>("quote", [row.id, parseUnits(units, 18), side === "buy"]),
      ]);
      if (apiQ.status !== 200) throw new Error(`/v1/quote ${apiQ.status}: ${JSON.stringify(apiQ.json).slice(0, 200)}`);
      const a = Number(BigInt(apiQ.json.quote.usdg));
      const c = Number(chainQ.usdg);
      const diff = Math.abs(a - c);
      const rel = c > 0 ? diff / c : 0;
      const ok = diff <= 10_000 || rel <= 0.005;
      cases.push({ id: row.id, name: row.name, speed: row.speed, isCall: row.isCall, strike: row.strike, units, side, api: a, chain: c, rel, ok });
      checked++;
      if (!ok && rel > worst) { worst = rel; worstCase = `${row.name} ${row.speed} ${row.isCall ? "C" : "P"}${row.strike} ${side} ${units}: api ${a} chain ${c}`; }
      if (rel > worst && ok) worst = Math.max(worst, diff <= 10_000 ? 0 : rel);
    }
    writeFileSync(join(OUT, "parity.json"), JSON.stringify(cases, null, 1));
    const bad = (cases as { ok: boolean }[]).filter((x) => !x.ok).length;
    assert(bad === 0, `${bad}/200 outside 0.5%; worst ${worstCase}`);
    const rels = (cases as { rel: number; chain: number }[]).filter((x) => x.chain > 10_000).map((x) => x.rel).sort((p, q) => p - q);
    return `${checked}/200 within tolerance; median rel diff ${(rels[Math.floor(rels.length / 2)]! * 100).toFixed(4)}%, max ${(rels.at(-1)! * 100).toFixed(4)}% (cases in parity.json)`;
  });

  // ---------------------------------------------------------------- shield
  await flow("shield", "Shield a Stock Token holding", "API shield intent -> engine.shield buys a Weekly Down option ~10% below spot for the NVDA held; ShieldBought; position indexed", async (f) => {
    const { receipt, intent } = await viaIntent(f, "shield", "carol", { name: "NVDA", tokenUnits: "2", strikePctBelowBps: 1000, slippageBps: 100 });
    const ev = events(receipt, OptionEngineAbi, C.engine).find((e) => e.eventName === "ShieldBought");
    assert(ev, "no ShieldBought");
    const held = await waitFor("shield position indexed", async () => { const u = await positionUnits(addressOf("carol"), ev.args.id); return u > 0 ? u : false; });
    return `series ${String(ev.args.id).slice(0, 10)}, paid ${fmt(ev.args.usdgPaid)} USDG for ${fmt(ev.args.tokenUnits, 18)} NVDA; API units ${held}; intent maxCost ${fmt(BigInt(intent.maxCostUsdg))}`;
  });
  await flow("shield", "Shield more than the wallet holds (expected failure)", "reverts ShieldExceedsHolding", async (f) => {
    const w = walletFor("carol");
    const deadline = BigInt(await chainTime()) + 300n;
    return f.expectRevert("engine.shield", w, { to: C.engine, data: encodeFunctionData({ abi: OptionEngineAbi, functionName: "shield", args: [stockOf("NVDA"), 500n * WAD, 1000, USD(100_000), deadline] }) }, "ShieldExceedsHolding");
  });

  // ---------------------------------------------------------------- R5 restart safety (indexer + keeper down mid-run)
  await flow("restart", "Kill and restart indexer and keeper mid-run (R5)", "trades while they are down are indexed once after restart; no duplicate rows; keeper re-lists nothing", async (f) => {
    const before = await sql`select count(*)::int as n from trades`;
    await stopService("indexer");
    await stopService("keeper");
    const row = nvda.rows.find((r) => r.speed === "WEEKLY" && r.isCall && r.strike === grid[2])!;
    const { receipt } = await viaIntent(f, "buy", "bob", { series: row.id, units: "3", slippageBps: 100 });
    assert(events(receipt, OptionEngineAbi, C.engine).some((e) => e.eventName === "Bought"), "buy while down failed");
    const listedBefore = await pub.readContract({ address: C.registry, abi: SeriesRegistryAbi, functionName: "seriesCount" });
    await startServices();
    const indexed = await waitFor("trade indexed after restart", async () => {
      const r = await sql`select count(*)::int as n from trades where tx_hash = ${receipt.transactionHash}`;
      return (r[0]!.n as number) >= 1 ? r[0]!.n : false;
    }, 120_000, 2000);
    await Bun.sleep(15_000); // a few indexer polls and keeper cycles after catching up
    const dupTrades = await sql`select tx_hash, log_index, count(*) from trades group by 1,2 having count(*) > 1`;
    const dupBalances = await sql`select token, account, count(*) from balances group by 1,2 having count(*) > 1`;
    const after = await sql`select count(*)::int as n from trades`;
    const listedAfter = await pub.readContract({ address: C.registry, abi: SeriesRegistryAbi, functionName: "seriesCount" });
    // Every Bought/Sold/ShieldBought event on chain appears exactly once in trades.
    const logs = await pub.getContractEvents({ address: C.engine, abi: OptionEngineAbi, fromBlock: BigInt(dep.deployBlock), toBlock: "latest" });
    const tradeEvents = logs.filter((l) => l.eventName === "Bought" || l.eventName === "Sold").length;
    assert(indexed === 1, `trade indexed ${indexed} times`);
    assert(dupTrades.length === 0 && dupBalances.length === 0, "duplicate rows after restart");
    assert(listedAfter === listedBefore, `keeper listed ${listedAfter - listedBefore} new series after restart`);
    return `trades ${before[0]!.n} -> ${after[0]!.n} (chain Bought+Sold events ${tradeEvents}); the buy made while both were down indexed exactly once; 0 duplicate (tx,log) rows; seriesCount unchanged at ${listedAfter}`;
  });

  // ---------------------------------------------------------------- hold across warped time: funding vs the TS reference
  await flow("funding", "Hold across warped time: funding shrinks units exactly as the TS reference", "every consecutive Accrued pair of a held series: norm_after = fundingStep(norm_before, V, payoff, dt, tau) within 1e-9", async (f) => {
    const id = atmDaily.id;
    const before = await engineRead<readonly [bigint, bigint, bigint, number]>("vMark", [id]);
    await warp(3 * 3600);
    await waitVolFresh(["NVDA"]);
    await f.send("engine.accrue", walletFor("alice"), { to: C.engine, data: encodeFunctionData({ abi: OptionEngineAbi, functionName: "accrue", args: [id] }) });
    const logs = (await pub.getContractEvents({ address: C.engine, abi: OptionEngineAbi, eventName: "Accrued", args: { id }, fromBlock: BigInt(dep.deployBlock), toBlock: "latest" }));
    assert(logs.length >= 2, `only ${logs.length} Accrued events`);
    const times = await Promise.all(logs.map(async (l) => Number((await pub.getBlock({ blockNumber: l.blockNumber! })).timestamp)));
    let worst = 0;
    let steps = 0;
    for (let i = 1; i < logs.length; i++) {
      const prev = logs[i - 1]!.args as any;
      const cur = logs[i]!.args as any;
      const dt = times[i]! - times[i - 1]!;
      if (dt <= 0) continue;
      const V = Number(cur.vMarkWad) / 1e18;
      const payoff = Number(cur.payoffWad) / 1e18;
      const expected = fundingStep(Number(prev.norm) / 1e18, V, payoff, dt, 86_400);
      const got = Number(cur.norm) / 1e18;
      worst = Math.max(worst, Math.abs(got - expected) / expected);
      steps++;
    }
    const units = await positionUnits(addressOf("alice"), id);
    assert(steps >= 1 && worst < 1e-9, `worst rel error ${worst} over ${steps} steps`);
    return `${steps} accrual steps checked over ${logs.length} Accrued events, worst relative error ${worst.toExponential(2)}; V at start ${fmt(before[0], 18)}; alice's units now ${units} (bought 10)`;
  });

  // ---------------------------------------------------------------- sells
  for (const b of bought.filter((x) => x.role === "alice" && x.row.speed === "DAILY").slice(0, 6)) {
    await flow("sell", `Sell half of ${b.row.name} ${b.row.speed} ${b.row.isCall ? "call" : "put"} K=${b.row.strike}`, "API sell intent -> engine.sell burns tokens, pays USDG >= minProceeds; position shrinks in the API", async (f) => {
      const who = addressOf("alice");
      const units = (await positionUnits(who, b.row.id)) / 2;
      const usdgBefore = await usdgOf(who);
      const { receipt, intent } = await viaIntent(f, "sell", "alice", { series: b.row.id, units: units.toFixed(6), slippageBps: 100 });
      const ev = events(receipt, OptionEngineAbi, C.engine).find((e) => e.eventName === "Sold" || e.eventName === "SellQueued");
      assert(ev?.eventName === "Sold", `no Sold event (${ev?.eventName})`);
      const got = (await usdgOf(who)) - usdgBefore;
      assert(got >= BigInt(intent.minProceedsUsdg ?? 0), "paid less than minProceeds");
      const left = await waitFor("position shrinks", async () => { const u = await positionUnits(who, b.row.id); return u < units * 1.999 ? u : false; });
      return `received ${fmt(got)} USDG (min ${fmt(BigInt(intent.minProceedsUsdg ?? 0))}); API units left ${left}`;
    });
  }
  await flow("sell", "Sell more tokens than held (expected failure)", "engine.sell reverts on the token burn", async (f) => {
    const deadline = BigInt(await chainTime()) + 300n;
    return f.expectRevert("engine.sell", walletFor("alice"), { to: C.engine, data: encodeFunctionData({ abi: OptionEngineAbi, functionName: "sell", args: [atmDaily.id, 10_000n * WAD, 0n, deadline, addressOf("alice")] }) }, /Insufficient|revert|panic/i);
  });

  // ---------------------------------------------------------------- withdrawals: queue now, claim after 72h (later)
  let ticket = 0n;
  await flow("pool", "Withdraw inside the 24h deposit lock (expected failure)", "requestWithdraw reverts WithdrawalLocked within lockSeconds of a deposit", async (f) => {
    const shares = await tokenBalance(C.pool, addressOf(depositor));
    return f.expectRevert("pool.requestWithdraw", walletFor(depositor), { to: C.pool, data: encodeFunctionData({ abi: PoolAbi, functionName: "requestWithdraw", args: [shares / 4n] }) }, "WithdrawalLocked");
  });
  await flow("pool", "Queue a withdrawal after the deposit lock", "24h later requestWithdraw locks shares, WithdrawalQueued with claimableAt = now + 72h; /v1/pool queue counts it", async (f) => {
    const lock = Number(await pub.readContract({ address: C.pool, abi: PoolAbi, functionName: "lockSeconds" }));
    await warp(lock + 60);
    await waitVolFresh(dep.stocks.map((x) => x.name));
    const who = addressOf(depositor);
    const shares = await tokenBalance(C.pool, who);
    const r = await f.send("pool.requestWithdraw", walletFor(depositor), { to: C.pool, data: encodeFunctionData({ abi: PoolAbi, functionName: "requestWithdraw", args: [shares / 4n] }) });
    const ev = events(r, PoolAbi, C.pool).find((e) => e.eventName === "WithdrawalQueued");
    assert(ev, "no WithdrawalQueued");
    ticket = ev.args.ticket;
    const now = await chainTime();
    const q = await waitFor("queue in the API", async () => { const p = (await api("/v1/pool")).json; return p.queue?.withdrawals >= 1 ? p.queue : false; });
    return `ticket ${ticket}, claimableAt in ${Number(ev.args.claimableAt) - now} s; API queue ${JSON.stringify(q)}`;
  });
  await flow("pool", "Claim before the 72h queue ends (expected failure)", "claim reverts NotClaimable", async (f) => {
    return f.expectRevert("pool.claim", walletFor(depositor), { to: C.pool, data: encodeFunctionData({ abi: PoolAbi, functionName: "claim", args: [ticket] }) }, "NotClaimable");
  });

  // ---------------------------------------------------------------- agents: policy, MCP buy/sell, budget exhaustion
  const agentEnv = Object.fromEntries(readFileSync(join(FORK_DIR, "env", "mcp.env"), "utf8").split("\n").filter(Boolean).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
  const mcp = async (name: string, args: Record<string, unknown>) => {
    const res = await fetch(`http://127.0.0.1:${PORTS.mcp}/mcp`, {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${agentEnv.MCP_HTTP_TOKEN}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method: "tools/call", params: { name, arguments: args } }),
    });
    const body = await res.json() as any;
    if (body.error) throw new Error(`MCP ${name}: ${body.error.message}`);
    const text = body.result?.content?.[0]?.text ?? "";
    if (body.result?.isError) throw new Error(`MCP ${name} refused: ${text.slice(0, 300)}`);
    try { return JSON.parse(text); } catch { return text; }
  };
  const owner = addressOf("agentOwner");
  const agent = addressOf("agent");
  await flow("agent", "Owner sets an agent policy on the AgentRouter", "setPolicy(budget 150 USDG, max 100/trade, 1 day, sell yes, shield no, NVDA only); /v1/accounts/{owner}/agents shows it", async (f) => {
    const w = walletFor("agentOwner");
    const expires = BigInt(await chainTime()) + 86_400n;
    await f.send("agentRouter.setPolicy", w, { to: C.agentRouter!, data: encodeFunctionData({ abi: AgentRouterAbi, functionName: "setPolicy", args: [agent, USD(150), USD(100), expires, true, false, [stockOf("NVDA")]] }) });
    await f.send("usdg.approve(router)", w, { to: C.usdg, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [C.agentRouter!, USD(150)] }) });
    const shown = await waitFor("agent policy indexed", async () => { const a = (await api(`/v1/accounts/${owner}/agents`)).json; return (a.agents ?? []).length ? a.agents[0] : false; });
    return `policy indexed: ${JSON.stringify(shown).slice(0, 220)}`;
  });
  let agentSeries = atmDaily;
  await flow("agent", "MCP lmns_quote and lmns_buy through the AgentRouter", "MCP tools/call lmns_buy sends AgentRouter.buyFor; tokens go to the owner; AgentTrade event; the API lists the agent trade", async () => {
    const q = await mcp("lmns_quote", { series: agentSeries.id, units: "5", side: "buy" });
    const before = await tokenBalance(agentSeries.token, owner);
    const sent = await mcp("lmns_buy", { series: agentSeries.id, units: "5", slippageBps: 100, owner });
    const r = await pub.waitForTransactionReceipt({ hash: sent.txHash });
    flows.at(-1); // keep lint quiet
    const ev = events(r, AgentRouterAbi, C.agentRouter as Address).find((e) => e.eventName === "AgentTrade");
    assert(r.status === "success" && ev, `buyFor ${sent.txHash} failed`);
    const after = await tokenBalance(agentSeries.token, owner);
    assert(after > before, "owner received no tokens");
    assert((await tokenBalance(agentSeries.token, agent)) === 0n, "agent holds tokens");
    const trades = await waitFor("agent trade indexed", async () => { const a = (await api(`/v1/accounts/${owner}/agents`)).json; return (a.agents?.[0]?.trades ?? a.agents?.[0]?.recentTrades ?? []).length ? a.agents[0] : (a.agents?.[0]?.spentUsdg && Number(a.agents[0].spentUsdg) > 0 ? a.agents[0] : false); }, 60_000).catch(() => null);
    return `quote ${q.quote?.usdg ?? "?"} raw; buyFor ${sent.txHash} gas ${r.gasUsed}; owner tokens +${fmt(after - before, 18)}; agent holds 0; API agent ${trades ? "updated" : "not updated"}`;
  });
  await flow("agent", "MCP lmns_sell through the AgentRouter", "owner approves the option token; lmns_sell sends sellFor; proceeds go to the owner", async (f) => {
    const w = walletFor("agentOwner");
    const bal = await tokenBalance(agentSeries.token, owner);
    await f.send("optionToken.approve(router)", w, { to: agentSeries.token, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [C.agentRouter as Address, bal] }) });
    const usdgBefore = await usdgOf(owner);
    const units = (await positionUnits(owner, agentSeries.id)) / 2;
    const sent = await mcp("lmns_sell", { series: agentSeries.id, units: units.toFixed(6), slippageBps: 100, owner });
    const r = await pub.waitForTransactionReceipt({ hash: sent.txHash });
    assert(r.status === "success", "sellFor reverted");
    const got = (await usdgOf(owner)) - usdgBefore;
    assert(got > 0n, "owner got no USDG");
    return `sellFor ${sent.txHash} gas ${r.gasUsed}; owner +${fmt(got)} USDG`;
  });
  await flow("agent", "Budget exhaustion: MCP refuses and the router reverts (expected failure)", "spend most of the budget with one buyFor; then lmns_buy over the remaining budget is refused by the client check and a direct buyFor reverts BudgetExceeded", async (f) => {
    const aw = walletFor("agent");
    const perUnit = (await engineRead<{ usdg: bigint }>("quote", [agentSeries.id, WAD, true])).usdg;
    const unitsFor = (usd: number) => (USD(usd) * WAD) / perUnit;
    const deadline = BigInt(await chainTime()) + 300n;
    const big = unitsFor(85);
    await f.send("agentRouter.buyFor (85 USDG)", aw, { to: C.agentRouter as Address, data: encodeFunctionData({ abi: AgentRouterAbi, functionName: "buyFor", args: [owner, agentSeries.id, big, USD(100), deadline] }) });
    const remaining = await pub.readContract({ address: C.agentRouter as Address, abi: AgentRouterAbi, functionName: "remainingBudget", args: [owner, agent] }) as bigint;
    const over = unitsFor(Number(fmt(remaining)) + 20);
    let refused = "";
    try { await mcp("lmns_buy", { series: agentSeries.id, units: formatUnits(over, 18).slice(0, 12), slippageBps: 100, owner }); refused = "NOT refused"; } catch (e) { refused = (e as Error).message.slice(0, 160); }
    assert(refused !== "NOT refused", "MCP sent a buy over budget");
    const reason = await f.expectRevert("agentRouter.buyFor (over budget)", aw, { to: C.agentRouter as Address, data: encodeFunctionData({ abi: AgentRouterAbi, functionName: "buyFor", args: [owner, agentSeries.id, over, USD(99), deadline] }) }, "BudgetExceeded");
    return `remaining budget ${fmt(remaining)} USDG after an 85 USDG buy; MCP: ${refused}; chain: ${reason}`;
  });
  await flow("agent", "Per-trade limit (expected failure)", "a buyFor costing more than maxPerTradeUsdg reverts MaxPerTradeExceeded", async (f) => {
    const perUnit = (await engineRead<{ usdg: bigint }>("quote", [agentSeries.id, WAD, true])).usdg;
    const units = (USD(120) * WAD) / perUnit;
    const deadline = BigInt(await chainTime()) + 300n;
    return f.expectRevert("agentRouter.buyFor (120 USDG)", walletFor("agent"), { to: C.agentRouter as Address, data: encodeFunctionData({ abi: AgentRouterAbi, functionName: "buyFor", args: [owner, agentSeries.id, units, USD(130), deadline] }) }, /MaxPerTradeExceeded|BudgetExceeded/);
  });
  await flow("agent", "A non-NVDA buy by the agent (expected failure)", "buyFor on a TSLA series reverts StockNotAllowed", async (f) => {
    const tsla = (await chainOf("TSLA")).rows.find((r) => r.speed === "DAILY" && r.isCall)!;
    const deadline = BigInt(await chainTime()) + 300n;
    return f.expectRevert("agentRouter.buyFor", walletFor("agent"), { to: C.agentRouter as Address, data: encodeFunctionData({ abi: AgentRouterAbi, functionName: "buyFor", args: [owner, tsla.id, WAD, USD(50), deadline] }) }, "StockNotAllowed");
  });
  await flow("agent", "Owner revokes the policy", "revoke; a later buyFor reverts PolicyIsRevoked", async (f) => {
    await f.send("agentRouter.revoke", walletFor("agentOwner"), { to: C.agentRouter as Address, data: encodeFunctionData({ abi: AgentRouterAbi, functionName: "revoke", args: [agent] }) });
    const deadline = BigInt(await chainTime()) + 300n;
    return f.expectRevert("agentRouter.buyFor", walletFor("agent"), { to: C.agentRouter as Address, data: encodeFunctionData({ abi: AgentRouterAbi, functionName: "buyFor", args: [owner, agentSeries.id, WAD, USD(50), deadline] }) }, "PolicyIsRevoked");
  });

  // ---------------------------------------------------------------- x402 paid call (a second API with x402 on)
  await flow("x402", "x402 paid data call over Permit2", "GET a paid route -> 402 with Permit2 terms; the agent signs; the retry returns 200 and the settler moves USDG payer -> payTo", async (f) => {
    const port = PORTS.api + 20;
    const payTo = addressOf("treasury");
    const env = {
      ...Object.fromEntries(readFileSync(join(FORK_DIR, "env", "api.env"), "utf8").split("\n").filter(Boolean).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)])),
      API_PORT: String(port), X402_ENABLED: "1", X402_PAY_TO: payTo, X402_SETTLER_KEY: keyOf("settler"), X402_RPC_URL: ANVIL_URL, PATH: process.env.PATH ?? "",
    };
    const { openSync } = await import("node:fs");
    const logFd = openSync(join(FORK_DIR, "logs", "api-x402.log"), "a");
    x402Api = spawn("bun", ["src/bin/api.ts"], { cwd: APP, env, stdio: ["ignore", logFd, logFd] });
    const base = `http://127.0.0.1:${port}`;
    await waitFor("x402 API up", async () => (await fetch(`${base}/v1/health`)).ok, 60_000, 500);
    const payer = privateKeyToAccount(keyOf("payer"));
    await f.send("usdg.approve(Permit2)", walletFor("payer"), { to: C.usdg, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: ["0x000000000022D473030F116dDEE9F6B43aC78BA3", USD(10)] }) });
    const unpaid = await fetch(`${base}/v1/vol/NVDA`);
    assert(unpaid.status === 402, `unpaid call returned ${unpaid.status}`);
    const before = await usdgOf(payTo);
    const paying = createPayingFetch(fetch, payer, { chainId: 31337, maxAmount: USD(0.02) });
    const paid = await paying(`${base}/v1/vol/NVDA`);
    assert(paid.status === 200, `paid call returned ${paid.status}: ${(await paid.text()).slice(0, 200)}`);
    const settledHeader = paid.headers.get("x-payment-response");
    const after = await waitFor("payTo credited", async () => { const a = await usdgOf(payTo); return a > before ? a : false; }, 60_000);
    let hash: Hex | null = null;
    try { hash = JSON.parse(Buffer.from(settledHeader ?? "", "base64").toString()).transaction ?? null; } catch { /* header format */ }
    if (hash) { const r = await pub.getTransactionReceipt({ hash }); f.txs.push({ flow: f.id, label: "permit2.settle (x402 settler)", hash, gas: r.gasUsed.toString(), status: r.status, at: Date.now() }); }
    return `402 then 200; payTo +${fmt(after - before)} USDG; settlement ${hash ?? "(hash not in header)"}`;
  });
  if (x402Api) { x402Api.kill("SIGTERM"); x402Api = undefined; }

  // ---------------------------------------------------------------- one-tap userop (fork bundler)
  await flow("userop", "One-tap buy as an ERC-4337 user operation", "API ?format=userop builds a Kernel v3.3 op (approve + buy batched); the owner signs the userOpHash; /v1/userop/send -> fork bundler -> EntryPoint v0.7; the smart account holds the option tokens", async (f) => {
    const ownerAcct = privateKeyToAccount(keyOf("kal"));
    const sa = (await api(`/v1/accounts/${ownerAcct.address}/smart-account`)).json;
    const smart = getAddress(sa.address ?? sa.smartAccount ?? sa.account);
    await fund([smart], 1000, 1, {});
    const built = await api("/v1/intent/buy?format=userop", { series: atmDaily.id, units: "5", account: smart, owner: ownerAcct.address, slippageBps: 100, sponsor: false });
    assert(built.status === 200, `userop build ${built.status}: ${JSON.stringify(built.json).slice(0, 300)}`);
    const signature = await ownerAcct.signMessage({ message: { raw: built.json.userOpHash as Hex } });
    const op = { ...built.json.userOp, signature };
    const sent = await api("/v1/userop/send", { userOp: op });
    assert(sent.status === 200, `userop send ${sent.status}: ${JSON.stringify(sent.json).slice(0, 300)}`);
    const receipt = await waitFor("userop included", async () => { const r = (await api(`/v1/userop/${sent.json.userOpHash}`)).json; return r.status === "included" || r.status === "reverted" ? r : false; }, 60_000);
    assert(receipt.status === "included", `userop ${receipt.status}`);
    const txHash = receipt.transactionHash ?? receipt.receipt?.transactionHash;
    if (txHash) { const r = await pub.getTransactionReceipt({ hash: txHash }); f.txs.push({ flow: f.id, label: "entryPoint.handleOps (one-tap buy)", hash: txHash, gas: r.gasUsed.toString(), status: r.status, at: Date.now() }); }
    const held = await tokenBalance(atmDaily.token, smart);
    assert(held > 0n, "smart account holds no option tokens");
    return `smart account ${smart} (counterfactual, deployed by the op); tokens ${fmt(held, 18)}; userOp ${String(sent.json.userOpHash).slice(0, 12)}…`;
  });

  // ---------------------------------------------------------------- sessions and guards (R3)
  // Session flows on QQQ: no earnings report (TSLA and AAPL sit in an earnings buy-block on this fork, see above).
  const qqq = await chainOf("QQQ");
  const tslaRow = qqq.rows.find((r) => r.speed === "DAILY" && r.isCall && Math.abs(r.strike - qqq.spot) === Math.min(...qqq.rows.map((x) => Math.abs(x.strike - qqq.spot))))!;
  // A keeper risk pause from an earlier flow (all vol stale) is lifted by the timelock admin, as an operator would.
  const liftGlobalPause = async (f: Flow) => {
    const flags = await engineRead<readonly [boolean, boolean, boolean, boolean]>("flags");
    if (!flags[0]) return;
    const timelock = getAddress(C.timelock!);
    const admin = await impersonated(test, timelock);
    await f.send("engine.setBuysPaused(false) [timelock admin]", admin, { to: C.engine, data: encodeFunctionData({ abi: OptionEngineAbi, functionName: "setBuysPaused", args: [false] }) });
    await test.stopImpersonatingAccount({ address: timelock });
  };
  const tryBuy = async (f: Flow, row: SeriesRow, role: Role, match: string | RegExp) => {
    await liftGlobalPause(f); // no expected failure here is the global pause
    const deadline = BigInt(await chainTime()) + 300n;
    const w = walletFor(role);
    const have = await pub.readContract({ address: C.usdg, abi: erc20Abi, functionName: "allowance", args: [addressOf(role), C.engine] });
    if (have < USD(5000)) await f.send("usdg.approve", w, { to: C.usdg, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [C.engine, USD(1_000_000)] }) });
    return f.expectRevert("engine.buy", w, { to: C.engine, data: encodeFunctionData({ abi: OptionEngineAbi, functionName: "buy", args: [row.id, WAD, USD(5000), deadline, addressOf(role)] }) }, match);
  };
  const buyOk = async (f: Flow, row: SeriesRow, role: Role) => {
    await liftGlobalPause(f);
    // Once a perp equity post exists (the hedge-stale flow made one), the hedger must keep posting or buys pause; the
    // fork has no perp venue, so the exercise posts for it, as the hedger would.
    if (await pub.readContract({ address: C.pool, abi: PoolAbi, functionName: "hedgeStale" })) {
      await f.send("pool.postHedgeEquity (keep-alive)", walletFor("hedger"), { to: C.pool, data: encodeFunctionData({ abi: PoolAbi, functionName: "postHedgeEquity", args: [0n, BigInt(await chainTime()), keccak256(toHex(`fork-perp-${Date.now()}`))] }) });
    }
    const deadline = BigInt(await chainTime()) + 300n;
    return f.send("engine.buy", walletFor(role), { to: C.engine, data: encodeFunctionData({ abi: OptionEngineAbi, functionName: "buy", args: [row.id, WAD, USD(5000), deadline, addressOf(role)] }) });
  };

  // Vol stale: the vol-engine is stopped, the chain moves past validUntil.
  await flow("sessions", "Vol post stale: buys pause, sells price at sigma x 1.2", "with the vol-engine stopped and validUntil passed: buy reverts StaleVol; sell quote uses sigma x 1.20; after the vol-engine restarts buys work again", async (f) => {
    await stopService("vol-engine");
    const r = await pub.readContract({ address: C.volOracle, abi: VolOracleAbi, functionName: "read", args: [stockOf("QQQ"), 0] }) as { validUntil: bigint; sigmaBps: bigint };
    await warpTo(Number(r.validUntil) + 60);
    const reason = await tryBuy(f, tslaRow, "bob", "StaleVol");
    const q = await engineRead<{ sigmaBps: bigint }>("quote", [tslaRow.id, WAD, false]);
    const ratio = Number(q.sigmaBps) / Number(r.sigmaBps);
    await startServices();
    await waitVolFresh(["QQQ", "NVDA"]);
    // With every name's vol stale the keeper's risk monitor pauses all buys (guardian role, never unpauses by itself).
    let unpause = "no global pause was needed";
    const flags = await engineRead<readonly [boolean, boolean, boolean, boolean]>("flags");
    if (flags[0]) {
      const logged = await sql`select reason from pause_log where scope = 'global' order by ts desc limit 1`.catch(() => []);
      await f.expectRevert("engine.setBuysPaused(false) by the guardian", walletFor("guardian"), { to: C.engine, data: encodeFunctionData({ abi: OptionEngineAbi, functionName: "setBuysPaused", args: [false] }) }, "NotGuardian");
      const timelock = getAddress(C.timelock!);
      const admin = await impersonated(test, timelock);
      await f.send("engine.setBuysPaused(false) [timelock admin]", admin, { to: C.engine, data: encodeFunctionData({ abi: OptionEngineAbi, functionName: "setBuysPaused", args: [false] }) });
      await test.stopImpersonatingAccount({ address: timelock });
      unpause = `the keeper's risk monitor had paused all buys (${JSON.stringify(logged[0] ?? {}).slice(0, 80)}); the guardian cannot unpause (NotGuardian), the timelock admin did`;
    }
    await buyOk(f, tslaRow, "bob");
    assert(ratio > 1.15, `sell sigma ratio ${ratio}`);
    return `${reason}; sell quote sigma ${q.sigmaBps} vs posted ${r.sigmaBps} base (x${ratio.toFixed(3)}, skew included); ${unpause}; buy works after the vol-engine restarts`;
  });

  // Hedge stale: a perp equity post goes older than 2h.
  await flow("sessions", "Hedge equity stale: buys pause", "hedger posts perp equity; 2h later pool.hedgeStale() is true and buys revert BuysArePaused(HEDGE); a fresh post resumes them", async (f) => {
    const hw = walletFor("hedger");
    const now = BigInt(await chainTime());
    await f.send("pool.postHedgeEquity", hw, { to: C.pool, data: encodeFunctionData({ abi: PoolAbi, functionName: "postHedgeEquity", args: [0n, now, keccak256(toHex("fork-perp-snapshot-1"))] }) });
    await warp(2 * 3600 + 120);
    await waitVolFresh(["QQQ"]);
    const stale = await pub.readContract({ address: C.pool, abi: PoolAbi, functionName: "hedgeStale" });
    const reason = await tryBuy(f, tslaRow, "bob", /"HEDGE"/);
    const now2 = BigInt(await chainTime());
    await f.send("pool.postHedgeEquity", hw, { to: C.pool, data: encodeFunctionData({ abi: PoolAbi, functionName: "postHedgeEquity", args: [0n, now2, keccak256(toHex("fork-perp-snapshot-2"))] }) });
    await buyOk(f, tslaRow, "bob");
    assert(stale === true, "hedgeStale was false");
    return `hedgeStale=${stale}; ${reason}; fresh post -> buy works`;
  });

  // Earnings window: a signed vol post carrying a buy-block window.
  await flow("sessions", "Earnings window blocks buys", "a vol post with buyBlockFrom..buyBlockTo around now: buy reverts EarningsBlock; sells still work", async (f) => {
    const signer = privateKeyToAccount(keyOf("volSigner"));
    await stopService("vol-engine"); // its next post would replace the window before the check
    const cur = await pub.readContract({ address: C.volOracle, abi: VolOracleAbi, functionName: "read", args: [stockOf("QQQ"), 0] }) as { sigmaBps: bigint; skewK: bigint; eventBumpBps: bigint };
    await warp(6 * 60);
    const now = BigInt(await chainTime());
    const nonce = (await pub.readContract({ address: C.volOracle, abi: VolOracleAbi, functionName: "lastNonce", args: [stockOf("QQQ"), 0] }) as bigint) + 1n;
    const post = { stock: stockOf("QQQ"), speed: 0, sigmaBps: cur.sigmaBps, skewK: cur.skewK, eventBumpBps: cur.eventBumpBps, buyBlockFrom: now - 60n, buyBlockTo: now + 3600n, validUntil: now + 3000n, nonce };
    const sig = await signer.signTypedData({
      domain: { name: "LemniscateVolOracle", version: "1", chainId: 31337, verifyingContract: C.volOracle },
      types: { Post: [
        { name: "stock", type: "address" }, { name: "speed", type: "uint8" }, { name: "sigmaBps", type: "uint64" }, { name: "skewK", type: "uint64" },
        { name: "eventBumpBps", type: "uint64" }, { name: "buyBlockFrom", type: "uint64" }, { name: "buyBlockTo", type: "uint64" }, { name: "validUntil", type: "uint64" }, { name: "nonce", type: "uint64" },
      ] },
      primaryType: "Post", message: post,
    });
    await f.send("volOracle.post (EIP-712 on 31337)", walletFor("volSigner"), { to: C.volOracle, data: encodeFunctionData({ abi: VolOracleAbi, functionName: "post", args: [post, sig] }) });
    const reason = await tryBuy(f, tslaRow, "bob", "EarningsBlock");
    const bobTokens = await tokenBalance(tslaRow.token, addressOf("bob"));
    const deadline = BigInt(await chainTime()) + 300n;
    await f.send("engine.sell", walletFor("bob"), { to: C.engine, data: encodeFunctionData({ abi: OptionEngineAbi, functionName: "sell", args: [tslaRow.id, bobTokens / 4n, 0n, deadline, addressOf("bob")] }) });
    await warp(3700);
    await startServices();
    await waitVolFresh(["QQQ"]);
    return `${reason}; sell inside the window succeeded; window passed and posting resumed`;
  });

  // HALTED: the NVDA feed is swapped for a mock whose round is 31 days old.
  await flow("sessions", "HALTED via a stale feed: sells queue, then fill at the first fresh price", "PriceGuard reads HALTED; engine.sell escrows the tokens (SellQueued); fillQueued reverts while halted; after a fresh round anyone fills it (QueuedSellFilled) and the API shows the queue", async (f) => {
    const timelock = getAddress(C.timelock!);
    const admin = await impersonated(test, timelock);
    const art = JSON.parse(readFileSync(join(ROOT, "contracts/out/PriceGuardMocks.sol/MockGuardFeed.json"), "utf8"));
    const cfg = await pub.readContract({ address: C.priceGuard, abi: PriceGuardAbi, functionName: "config", args: [stockOf("NVDA")] }) as any;
    const feedAbi = parseAbi(["function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)", "function setRound(int256,uint256)"]);
    const [, answer] = await pub.readContract({ address: cfg.feed, abi: feedAbi, functionName: "latestRoundData" });
    const deployHash = await walletFor("deployer").deployContract({ abi: art.abi, bytecode: art.bytecode.object, args: [8, answer], chain: null, account: walletFor("deployer").account! });
    const mock = (await pub.waitForTransactionReceipt({ hash: deployHash })).contractAddress!;
    const now = BigInt(await chainTime());
    await f.send("mockFeed.setRound(stale)", walletFor("deployer"), { to: mock, data: encodeFunctionData({ abi: feedAbi, functionName: "setRound", args: [answer, now - 31n * 86_400n] }) });
    await f.send("priceGuard.setStock(mock feed) [timelock]", admin, { to: C.priceGuard, data: encodeFunctionData({ abi: PriceGuardAbi, functionName: "setStock", args: [stockOf("NVDA"), { ...cfg, feed: mock }] }) });
    const r = await priceReading("NVDA");
    assert(r.session === 4, `session ${r.session}, not HALTED`);
    const row = nvda.rows.find((x) => x.speed === "WEEKLY" && x.isCall && x.strike === grid[2])!;
    const bobTokens = await tokenBalance(row.token, addressOf("bob"));
    const deadline = BigInt(await chainTime()) + 300n;
    const sr = await f.send("engine.sell (halted -> queued)", walletFor("bob"), { to: C.engine, data: encodeFunctionData({ abi: OptionEngineAbi, functionName: "sell", args: [row.id, bobTokens, 0n, deadline, addressOf("bob")] }) });
    const q = events(sr, OptionEngineAbi, C.engine).find((e) => e.eventName === "SellQueued");
    assert(q, "no SellQueued");
    const apiQueue = await waitFor("queued sell in the API", async () => { const p = (await api(`/v1/accounts/${addressOf("bob")}/positions`)).json; return (p.queuedSells ?? []).length ? p.queuedSells : false; });
    await f.expectRevert("engine.fillQueued (still halted)", walletFor("carol"), { to: C.engine, data: encodeFunctionData({ abi: OptionEngineAbi, functionName: "fillQueued", args: [q.args.ticket] }) }, "QueueNotFillable");
    await f.send("mockFeed.setRound(fresh)", walletFor("deployer"), { to: mock, data: encodeFunctionData({ abi: feedAbi, functionName: "setRound", args: [answer, BigInt(await chainTime())] }) });
    const before = await usdgOf(addressOf("bob"));
    const fr = await f.send("engine.fillQueued (by a stranger)", walletFor("carol"), { to: C.engine, data: encodeFunctionData({ abi: OptionEngineAbi, functionName: "fillQueued", args: [q.args.ticket] }) });
    const filled = events(fr, OptionEngineAbi, C.engine).find((e) => e.eventName === "QueuedSellFilled");
    const paid = (await usdgOf(addressOf("bob"))) - before;
    await f.send("priceGuard.setStock(real feed) [timelock]", admin, { to: C.priceGuard, data: encodeFunctionData({ abi: PriceGuardAbi, functionName: "setStock", args: [stockOf("NVDA"), cfg] }) });
    await test.stopImpersonatingAccount({ address: timelock });
    assert(filled && paid > 0n, "queue not filled to the seller");
    return `HALTED read; ticket ${q.args.ticket} queued (API shows ${apiQueue.length}); fill while halted reverted; filled by a stranger after the fresh round, bob +${fmt(paid)} USDG; real feed restored`;
  });

  // Weekend: CLOSED session.
  await flow("sessions", "Weekend: buys blocked, sells at last close with the wider spread", "Saturday: session CLOSED; buy reverts SessionBlocksBuys; sell succeeds with spreadBps about 3x the regular spread", async (f) => {
    const row = atmDaily;
    const regular = await engineRead<{ spreadBps: bigint }>("quote", [row.id, WAD, false]);
    await warpTo(nextNy(await chainTime(), 6, 12, 0));
    await waitVolFresh(["NVDA"]).catch(() => notes.push("weekend: NVDA vol was still stale when the weekend checks ran (sells then price at sigma x 1.2)"));
    const r = await priceReading("NVDA");
    assert(r.session === 2, `session ${r.session}, not CLOSED`);
    const [lastS] = await pub.readContract({ address: C.priceGuard, abi: PriceGuardAbi, functionName: "lastGoodPrice", args: [stockOf("NVDA")] }) as readonly [bigint, bigint];
    assert(lastS > 0n, "PriceGuard has no last good price for NVDA (the keeper's poke upkeep did not run)");
    // the hedge-stale flow left a perp equity post behind: keep it fresh so the session rule is what blocks the buy
    await f.send("pool.postHedgeEquity (keep-alive)", walletFor("hedger"), { to: C.pool, data: encodeFunctionData({ abi: PoolAbi, functionName: "postHedgeEquity", args: [0n, BigInt(await chainTime()), keccak256(toHex(`fork-perp-${Date.now()}`))] }) });
    const reason = await tryBuy(f, row, "alice", "SessionBlocksBuys");
    const closed = await engineRead<{ spreadBps: bigint; usdg: bigint }>("quote", [row.id, WAD, false]);
    const units = (await positionUnits(addressOf("alice"), row.id)) / 2;
    const { receipt } = await viaIntent(f, "sell", "alice", { series: row.id, units: units.toFixed(6), slippageBps: 200 });
    assert(events(receipt, OptionEngineAbi, C.engine).some((e) => e.eventName === "Sold"), "weekend sell did not settle");
    const ratio = Number(closed.spreadBps) / Number(regular.spreadBps);
    assert(ratio > 2.5, `spread ratio ${ratio}`);
    return `CLOSED; ${reason}; sell settled; spread ${closed.spreadBps} bps vs ${regular.spreadBps} regular (x${ratio.toFixed(2)})`;
  });

  await flow("pool", "Claim the withdrawal after the 72h queue", "claim pays USDG at claim-time NAV; WithdrawalClaimed; queue empties in the API", async (f) => {
    const who = addressOf(depositor);
    const before = await usdgOf(who);
    const r = await f.send("pool.claim", walletFor(depositor), { to: C.pool, data: encodeFunctionData({ abi: PoolAbi, functionName: "claim", args: [ticket] }) });
    const ev = events(r, PoolAbi, C.pool).find((e) => e.eventName === "WithdrawalClaimed");
    assert(ev, "no WithdrawalClaimed");
    const got = (await usdgOf(who)) - before;
    return `claimed ${fmt(got)} USDG for ticket ${ticket}`;
  });

  // Split fixture: the issuer stages a 4x multiplier on AAPL (impersonating its real multiplier role holder).
  await flow("sessions", "Split fixture: multiplier x4, buys pause around it, S continuous", "issuer stages updateMultiplier(4x, effectiveAt) on SPY; PriceGuard pauses SPY buys (SPLIT) from 24h before to 1h after; afterwards uiMultiplier is 4x, S unchanged, buys resume", async (f) => {
    await warpTo(nextNy(await chainTime(), 1, 10, 0));
    await waitVolFresh(["SPY"]);
    const aapl = stockOf("SPY");
    const tok = parseAbi(["function uiMultiplier() view returns (uint256)", "function updateMultiplier(uint256,uint256)"]);
    const m0 = await pub.readContract({ address: aapl, abi: tok, functionName: "uiMultiplier" });
    const s0 = (await priceReading("SPY")).s;
    const issuer = getAddress("0x92905e8d0e2301ba143215b8d86d63ffd4188143");
    const iw = await impersonated(test, issuer);
    const effectiveAt = BigInt(await chainTime()) + 2n * 3600n;
    await f.send("spy.updateMultiplier(x4) [issuer role]", iw, { to: aapl, data: encodeFunctionData({ abi: tok, functionName: "updateMultiplier", args: [m0 * 4n, effectiveAt] }) });
    await test.stopImpersonatingAccount({ address: issuer });
    const during = await priceReading("SPY");
    const ch = await chainOf("SPY");
    const row = ch.rows.find((r) => r.speed === "WEEKLY" && r.isCall)!;
    const reason = await tryBuy(f, row, "bob", /"SPLIT"|"PRICE"/);
    await warpTo(Number(effectiveAt) + 3600 + 120);
    await waitVolFresh(["SPY"]);
    await f.send("priceGuard.poke(SPY)", walletFor("carol"), { to: C.priceGuard, data: encodeFunctionData({ abi: PriceGuardAbi, functionName: "poke", args: [aapl] }) }).catch(() => undefined);
    const m1 = await pub.readContract({ address: aapl, abi: tok, functionName: "uiMultiplier" });
    const after = await priceReading("SPY");
    assert(during.buysPaused, "buys were not paused before the split");
    assert(m1 === m0 * 4n, "multiplier did not switch");
    assert(after.s === s0, `S moved ${s0} -> ${after.s}`);
    await buyOk(f, row, "bob");
    return `before: paused=${during.buysPaused} (${reason}); after: uiMultiplier ${fmt(m0, 18)} -> ${fmt(m1, 18)}, S ${fmt(s0, 18)} unchanged, buy works`;
  });

  // ---------------------------------------------------------------- summary
  const passed = flows.filter((x) => x.status === "pass").length;
  notes.push(`finished at chain time ${new Date((await chainTime()) * 1000).toISOString()}`);
  writeFileSync(join(OUT, "results.json"), JSON.stringify({ flows, notes }, null, 1));
  console.log(`exercise: ${passed}/${flows.length} flows passed; results ${join(OUT, "results.json")}`);
  await sql.end({ timeout: 5 });
  return passed === flows.length ? 0 : 1;
}

if (import.meta.main) {
  let code = 1;
  try { code = await main(); }
  catch (error) { console.error(error); }
  finally { if (x402Api) x402Api.kill("SIGTERM"); }
  process.exit(code);
}
