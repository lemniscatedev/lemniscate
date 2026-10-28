// Exercise every user and admin action on Robinhood Chain TESTNET (46630) in REAL time (crypto-local-testing section 5):
// the fork exercise (scripts/fork/exercise.ts) without time travel or impersonation. Success and expected-failure paths,
// each asserting the chain effect AND the API's view after indexing; every transaction is recorded with its explorer link.
// Admin calls go through the 2-of-3 owner Safe; the mock tokens and feeds are driven by their owner, the deployer.
//
//   bun scripts/testnet/exercise.ts            (deploy.sh, fund.ts and up.sh first; run inside a REGULAR or EXTENDED session)
//   bun scripts/testnet/exercise.ts --report   only rewrite the report from $TESTNET_DIR/exercise/results.json
//
// What the testnet cannot do in a day (no clock to move) stays proven by the fork run and is listed, not faked:
// the 2h hedge-equity staleness (contract constant), a 26h stale feed / HALTED, the 7-day settleHalted delay, the weekend.
// Timers that ARE short here (deploy-time immutables at their hard minimums): deposit lock 60 s, withdrawal queue 5 min,
// fee period 5 min, split pause 10 min before / 5 min after. Writes $TESTNET_DIR/exercise/results.json and report.md.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  decodeErrorResult, decodeEventLog, encodeFunctionData, formatUnits, getAddress, keccak256, parseAbi, parseEther, parseUnits, toBytes, toHex,
  type Abi, type Address, type Hex, type TransactionReceipt, type WalletClient,
} from "viem";
import { entryPoint07Abi } from "viem/account-abstraction";
import postgres from "postgres";
import { AgentRouterAbi, OptionEngineAbi, PoolAbi, PriceGuardAbi, SeriesRegistryAbi, VolOracleAbi } from "@/abi";
import { fundingStep } from "@/pricing";
import { compareWithEngine, type EngineState } from "@/sim/engine-check";
import { fromEngineStruct } from "@/api/quote/parity";
import { createPayingFetch } from "@/x402";
import { SELL_LANE_PROOF_MAX_SECONDS, sellLaneProofMessage, verifySellLaneProof } from "@/api/sell-lane-proof";
import { KERNEL_V33_IMPLEMENTATION } from "@/aa/counterfactual";
import { safeAbi, safeExec, signSafeTx } from "./safe";
import { fundingPlan, USER_TOKENS } from "./fund";
import {
  accountOf, addressOf, API_URL, APP, DATABASE_URL, EXPLORER, erc20Abi, isLocalRpc, loadConfig, loadDeployment, PORTS, publicClient, RPC,
  TESTNET_CHAIN_ID, TESTNET_DIR, testnetFeedAbi, testnetStockAbi, txLink, walletFor, type TestnetRole,
} from "./lib";

// ------------------------------------------------------------------------------------------------ records
export interface TxRec { flow: string; label: string; hash: Hex | null; gas: string | null; status: "success" | "reverted" | "not-sent"; revert?: string; at: number; from?: string; value?: string }
export interface FlowRec {
  id: string; area: string; name: string; expected: string; actual: string; status: "pass" | "fail" | "skip"; error?: string;
  txs: TxRec[]; startedAt: number; chainTime: number; ms: number;
}
const OUT = join(TESTNET_DIR, "exercise");
const flows: FlowRec[] = [];
const notes: string[] = [];
const WAD = 10n ** 18n;
const USD = (n: number) => parseUnits(n.toFixed(6), 6);
const fmt = (raw: bigint, d = 6) => formatUnits(raw, d);
const SESS = ["REGULAR", "EXTENDED", "CLOSED", "UNKNOWN", "HALTED"] as const;
const DEFAULT_ADMIN_ROLE = `0x${"00".repeat(32)}` as Hex;

const extraErrors = parseAbi([
  "error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)",
  "error ERC20InsufficientAllowance(address spender, uint256 allowance, uint256 needed)",
  "error FailedOp(uint256 opIndex, string reason)",
  "error FailedOpWithRevert(uint256 opIndex, string reason, bytes inner)",
]);
const ERRORS: Abi = [...OptionEngineAbi, ...PoolAbi, ...AgentRouterAbi, ...SeriesRegistryAbi, ...PriceGuardAbi, ...VolOracleAbi, ...extraErrors, ...entryPoint07Abi]
  .filter((x) => (x as { type: string }).type === "error") as Abi;

export function revertName(error: unknown): string {
  const e = error as { shortMessage?: string; message?: string };
  let data: Hex | undefined;
  let cursor: unknown = e;
  for (let i = 0; i < 8 && cursor; i++) {
    const c = cursor as { data?: unknown; cause?: unknown };
    if (typeof c.data === "string" && c.data.startsWith("0x") && c.data.length >= 10) { data = c.data as Hex; break; }
    if (c.data && typeof c.data === "object" && typeof (c.data as { data?: unknown }).data === "string") { data = (c.data as { data: Hex }).data; break; }
    cursor = c.cause;
  }
  const text = `${e.shortMessage ?? ""} ${e.message ?? ""}`;
  // Only structured revert data counts: viem's message text also prints the request ("data: 0x<calldata>"), whose
  // selector would otherwise be reported as the revert (seen in the todo 26 dry run as "revert 0xbeae97c9" = engine.buy).
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

// ------------------------------------------------------------------------------------------------ report
const md = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");
export function writeReport(all: FlowRec[], extraNotes: string[], out = join(OUT, "report.md")): string {
  const passed = all.filter((f) => f.status === "pass").length;
  const skipped = all.filter((f) => f.status === "skip").length;
  const txs = all.flatMap((f) => f.txs);
  const link = (h: string | null) => (h ? (isLocalRpc() ? `\`${h}\` (dry run)` : `[${h.slice(0, 10)}…](${EXPLORER}/tx/${h})`) : "not sent");
  const lines = [
    `# Lemniscate testnet run (chain ${TESTNET_CHAIN_ID}${isLocalRpc() ? ", DRY RUN on a local fork of the testnet" : ""})`, "",
    `**${passed}/${all.length - skipped} flows passed** (${skipped} listed as fork-only), ${txs.filter((t) => t.hash).length} transactions, ${txs.reduce((a, t) => a + Number(t.gas ?? 0), 0).toLocaleString("en-US")} gas.`, "",
    ...extraNotes.map((n) => `- ${n}`), "",
    "| # | Flow | Expected | Actual | Result |", "|---|---|---|---|---|",
    ...all.map((f) => `| ${f.id} | ${md(f.name)} | ${md(f.expected)} | ${md(f.actual).slice(0, 600)} | ${f.status.toUpperCase()} |`), "",
    "## Every transaction", "", "| Flow | Call | From | Tx | Gas | Status | Revert (decoded) |", "|---|---|---|---|---|---|---|",
    ...txs.map((t) => `| ${t.flow} | ${md(t.label)} | ${t.from ?? ""} | ${link(t.hash)} | ${t.gas ?? ""} | ${t.status} | ${md(t.revert ?? "")} |`), "",
  ];
  writeFileSync(out, lines.join("\n"));
  return out;
}

// ------------------------------------------------------------------------------------------------ the run
async function main() {
  mkdirSync(OUT, { recursive: true });
  const pub = publicClient();
  const dep = loadDeployment();
  const cfg = loadConfig();
  const C = dep.contracts as Record<string, Address> & typeof dep.contracts;
  const sql = postgres(DATABASE_URL, { max: 2, onnotice: () => undefined });
  const stockOf = (name: string): Address => getAddress(dep.stocks.find((s) => s.name === name)!.stock);
  const feedOf = (name: string): Address => getAddress(dep.stocks.find((s) => s.name === name)!.feed!);
  const chainTime = async () => Number((await pub.getBlock()).timestamp);
  const assert: (cond: unknown, message: string) => asserts cond = (cond, message) => { if (!cond) throw new Error(message); };

  class Flow {
    readonly txs: TxRec[] = [];
    actual = "";
    constructor(readonly id: string) {}
    /** Sends from `role`; simulates first and throws the decoded revert if it would fail. */
    async send(label: string, role: TestnetRole | WalletClient, call: { to: Address; data: Hex; value?: bigint }, gas?: bigint): Promise<TransactionReceipt> {
      const wallet = typeof role === "string" ? walletFor(role) : role;
      const account = wallet.account!;
      let estimate: bigint;
      try {
        estimate = gas ?? await pub.estimateGas({ account, to: call.to, data: call.data, value: call.value ?? 0n });
      } catch (error) {
        const reason = revertName(error);
        this.txs.push({ flow: this.id, label, hash: null, gas: null, status: "not-sent", revert: reason, at: Date.now(), from: typeof role === "string" ? role : account.address });
        throw new Error(`${label} would revert: ${reason}`);
      }
      const hash = await wallet.sendTransaction({ account, chain: wallet.chain, to: call.to, data: call.data, value: call.value ?? 0n, gas: (estimate * 13n) / 10n + 50_000n });
      const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 180_000 });
      this.txs.push({ flow: this.id, label, hash, gas: receipt.gasUsed.toString(), status: receipt.status, at: Date.now(), from: typeof role === "string" ? role : account.address, ...(call.value ? { value: call.value.toString() } : {}) });
      if (receipt.status !== "success") throw new Error(`${label} reverted on chain (${txLink(hash)})`);
      return receipt;
    }
    /** Expected failure: must revert with `match`. Mined anyway (fixed gas) so the report has the failing transaction. */
    async expectRevert(label: string, role: TestnetRole, call: { to: Address; data: Hex }, match: string | RegExp): Promise<string> {
      const wallet = walletFor(role);
      const account = wallet.account!;
      let reason = "";
      try { await pub.call({ account, to: call.to, data: call.data }); reason = "did not revert"; } catch (error) { reason = revertName(error); }
      let hash: Hex | null = null;
      let gas: string | null = null;
      try {
        hash = await wallet.sendTransaction({ account, chain: wallet.chain, to: call.to, data: call.data, gas: 1_500_000n });
        const r = await pub.waitForTransactionReceipt({ hash, timeout: 180_000 });
        gas = r.gasUsed.toString();
        if (r.status === "success") reason = `${reason} / MINED SUCCESSFULLY`;
      } catch { /* refused by the node: keep the simulated reason */ }
      this.txs.push({ flow: this.id, label, hash, gas, status: hash ? "reverted" : "not-sent", revert: reason, at: Date.now(), from: role });
      const ok = typeof match === "string" ? reason.includes(match) : match.test(reason);
      if (!ok) throw new Error(`${label}: expected revert ${String(match)}, got ${reason}`);
      return reason;
    }
    /** An admin call through the 2-of-3 owner Safe (owner-1 + owner-2 sign, owner-1 submits). */
    async admin(label: string, to: Address, data: Hex): Promise<TransactionReceipt> {
      const r = await safeExec(to, data, { pub });
      this.txs.push({ flow: this.id, label: `${label} [owner Safe 2-of-3]`, hash: r.hash, gas: r.receipt.gasUsed.toString(), status: "success", at: Date.now(), from: "owner-1 (Safe)" });
      return r.receipt;
    }
  }

  const save = () => writeFileSync(join(OUT, "results.json"), JSON.stringify({ flows, notes }, null, 1));
  async function flow(area: string, name: string, expected: string, fn: (f: Flow) => Promise<string | void>): Promise<FlowRec> {
    const id = `${area}.${flows.filter((x) => x.area === area).length + 1}`;
    const f = new Flow(id);
    const started = Date.now();
    const rec: FlowRec = { id, area, name, expected, actual: "", status: "pass", txs: f.txs, startedAt: started, chainTime: await chainTime(), ms: 0 };
    try { rec.actual = (await fn(f)) ?? f.actual; } catch (error) {
      rec.status = "fail";
      rec.error = (error as Error).message.split("\n").slice(0, 3).join(" ").slice(0, 600);
      rec.actual = f.actual || rec.error;
    }
    rec.ms = Date.now() - started;
    flows.push(rec);
    save();
    console.log(`${rec.status === "pass" ? "PASS" : "FAIL"} ${id} ${name}${rec.status === "fail" ? ` :: ${rec.error}` : ""} (${Math.round(rec.ms / 1000)} s)`);
    return rec;
  }
  function forkOnly(area: string, name: string, why: string) {
    const id = `${area}.${flows.filter((x) => x.area === area).length + 1}`;
    flows.push({ id, area, name, expected: "fork run only", actual: why, status: "skip", txs: [], startedAt: Date.now(), chainTime: 0, ms: 0 });
    save();
    console.log(`SKIP ${id} ${name} (fork-only: ${why})`);
  }

  async function api<T = any>(path: string, body?: unknown, base = API_URL): Promise<{ status: number; json: T }> {
    const res = await fetch(`${base}${path}`, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const text = await res.text();
    let json: any = text;
    try { json = JSON.parse(text); } catch { /* keep text */ }
    return { status: res.status, json };
  }
  async function waitFor<T>(what: string, fn: () => Promise<T | undefined | false | null>, timeoutMs = 120_000, everyMs = 2000): Promise<T> {
    const end = Date.now() + timeoutMs;
    let last: unknown;
    while (Date.now() < end) {
      try { const v = await fn(); if (v) return v as T; } catch (e) { last = e; }
      await Bun.sleep(everyMs);
    }
    throw new Error(`timed out waiting for ${what}${last ? ` (${(last as Error).message})` : ""}`);
  }
  const untilChainTime = async (t: number, what: string) => waitFor(what, async () => (await chainTime()) >= t, Math.max(60_000, (t - (await chainTime())) * 1000 + 120_000), 5000);
  const engineRead = <T>(functionName: string, args: unknown[] = []) => pub.readContract({ address: C.engine, abi: OptionEngineAbi, functionName: functionName as never, args: args as never }) as Promise<T>;
  const priceReading = (name: string) => pub.readContract({ address: C.priceGuard, abi: PriceGuardAbi, functionName: "read", args: [stockOf(name)] }) as Promise<{ s: bigint; session: number; fresh: boolean; buysPaused: boolean; updatedAt: bigint }>;
  const volRead = (name: string, speed: 0 | 1) => pub.readContract({ address: C.volOracle, abi: VolOracleAbi, functionName: "read", args: [stockOf(name), speed] }) as Promise<{ stale: boolean; sigmaBps: bigint; validUntil: bigint; skewK: bigint; eventBumpBps: bigint; buyBlockFrom: bigint; buyBlockTo: bigint }>;
  const waitVolFresh = (names: string[], timeoutMs = 900_000) => waitFor(`fresh vol for ${names.join(",")}`, async () => {
    for (const n of names) for (const sp of [0, 1] as const) { const r = await volRead(n, sp); if (r.stale || r.sigmaBps === 0n) return false; }
    return true;
  }, timeoutMs, 5000);
  interface SeriesRow { id: Hex; name: string; isCall: boolean; speed: "DAILY" | "WEEKLY"; strike: number; token: Address; buyable: boolean }
  async function chainOf(name: string): Promise<{ spot: number; rows: SeriesRow[] }> {
    const { json } = await api(`/v1/chains/${name}`);
    const rows: SeriesRow[] = [];
    for (const sp of json.speeds ?? []) for (const k of sp.strikes ?? []) for (const side of ["call", "put"] as const) {
      const o = k[side];
      if (o) rows.push({ id: o.id, name, isCall: side === "call", speed: sp.speed, strike: Number(k.strike), token: getAddress(o.token), buyable: o.buyable });
    }
    return { spot: Number(json.spot), rows };
  }
  const tokenBalance = (token: Address, who: Address) => pub.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [who] });
  const usdgOf = (who: Address) => tokenBalance(C.usdg, who);
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
  async function viaIntent(f: Flow, kind: "buy" | "sell" | "shield", role: TestnetRole, body: Record<string, unknown>) {
    const account = addressOf(role);
    const { status, json } = await api(`/v1/intent/${kind}`, { account, ...body });
    if (status !== 200) throw new Error(`/v1/intent/${kind} ${status}: ${JSON.stringify(json).slice(0, 300)}`);
    for (const a of json.approvals ?? []) {
      const have = await pub.readContract({ address: getAddress(a.token), abi: erc20Abi, functionName: "allowance", args: [account, getAddress(a.spender)] });
      if (have < BigInt(a.amount)) await f.send(`${kind}:approve`, role, { to: getAddress(a.token), data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [getAddress(a.spender), BigInt(a.amount)] }) });
    }
    const receipt = await f.send(`engine.${kind}`, role, { to: getAddress(json.to), data: json.data as Hex });
    return { receipt, intent: json };
  }
  // Service control: only this stack's own processes (pid files in TESTNET_DIR).
  const pidOf = (name: string) => { const file = join(TESTNET_DIR, "pids", `${name}.pid`); return existsSync(file) ? Number(readFileSync(file, "utf8").trim()) : undefined; };
  const alive = (pid?: number) => { if (!pid) return false; try { process.kill(pid, 0); return true; } catch { return false; } };
  async function stopService(name: string) {
    const pid = pidOf(name);
    if (!alive(pid)) return;
    process.kill(pid!, "SIGTERM");
    try { await waitFor(`${name} to stop`, async () => !alive(pid), 60_000, 250); } catch { process.kill(pid!, "SIGKILL"); }
  }
  async function startServices() {
    await new Promise<void>((resolve, reject) => {
      const p = spawn("bash", [join(APP, "scripts/testnet/up.sh")], { cwd: APP, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      p.stdout.on("data", (d) => { out += d; });
      p.stderr.on("data", (d) => { out += d; });
      p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`up.sh exited ${code}: ${out.slice(-400)}`))));
    });
  }
  /** A keeper risk pause lifted by the owner Safe, as an operator would (the monitor never unpauses by itself). */
  async function liftPauses(f: Flow, name?: string): Promise<number> {
    let n = 0;
    const flags = await engineRead<readonly [boolean, boolean, boolean, boolean]>("flags");
    if (flags[0]) { await f.admin("engine.setBuysPaused(false)", C.engine, encodeFunctionData({ abi: OptionEngineAbi, functionName: "setBuysPaused", args: [false] })); n++; }
    for (const s of name ? [name] : dep.stocks.map((x) => x.name)) {
      for (const r of (await chainOf(s)).rows) {
        if (await engineRead<boolean>("seriesBuysPaused", [r.id])) {
          await f.admin("engine.setSeriesBuysPaused(false)", C.engine, encodeFunctionData({ abi: OptionEngineAbi, functionName: "setSeriesBuysPaused", args: [r.id, false] }));
          n++;
        }
      }
    }
    return n;
  }

  let keeperLogStart = 0;
  { const file = join(TESTNET_DIR, "logs", "keeper.log"); keeperLogStart = existsSync(file) ? readFileSync(file).length : 0; }
  console.log(`exercise: testnet ${RPC}${isLocalRpc() ? " (DRY RUN fork)" : ""}, API ${API_URL}, chain time ${new Date((await chainTime()) * 1000).toISOString()}`);
  assert((await api("/v1/health")).status === 200, "API is not healthy: run up.sh");
  notes.push(`chain ${TESTNET_CHAIN_ID} via ${isLocalRpc() ? "a local anvil fork of the testnet (dry run)" : RPC}; explorer ${EXPLORER}`);
  notes.push(`owner = 2-of-3 Safe ${cfg.roles.owner} (no timelock on testnet); timers at the contracts' hard minimums: deposit lock 60 s, queue 5 min, fee period 5 min, split lead 10 min / tail 5 min, vol validity 30 min`);
  notes.push("no hedger on testnet (no Uniswap v3 there); mock feeds follow the mainnet Chainlink rounds through the feed-mirror service");

  // ---------------------------------------------------------------- setup
  await flow("setup", "Deploy + post-deploy check, owner is a real 2-of-3 Safe", "DeploySystem testnet profile [PASS], PostDeployCheck [PASS] every check; the Safe holds DEFAULT_ADMIN on the engine, threshold 2 of 3, no module; the deployer holds no role; API /v1/config says 46630 testnet", async () => {
    const deployLog = readFileSync(join(TESTNET_DIR, "logs", "deploy.log"), "utf8");
    const checkLog = readFileSync(join(TESTNET_DIR, "logs", "post-deploy-check.log"), "utf8");
    assert(deployLog.includes("[PASS] post-deploy check"), "deploy log has no [PASS]");
    assert(checkLog.includes("[PASS] every check"), "PostDeployCheck did not pass");
    const safe = getAddress(cfg.roles.owner);
    const admin = await pub.readContract({ address: C.engine, abi: parseAbi(["function hasRole(bytes32,address) view returns (bool)"]), functionName: "hasRole", args: [DEFAULT_ADMIN_ROLE, safe] });
    const deployerAdmin = await pub.readContract({ address: C.engine, abi: parseAbi(["function hasRole(bytes32,address) view returns (bool)"]), functionName: "hasRole", args: [DEFAULT_ADMIN_ROLE, addressOf("deployer")] });
    const threshold = await pub.readContract({ address: safe, abi: safeAbi, functionName: "getThreshold" });
    const owners = await pub.readContract({ address: safe, abi: safeAbi, functionName: "getOwners" });
    const c = await api("/v1/config");
    assert(admin && !deployerAdmin, "engine admin is not the Safe alone");
    assert(threshold === 2n && owners.length === 3, `Safe is ${threshold} of ${owners.length}`);
    assert(c.json.chainId === TESTNET_CHAIN_ID && c.json.network === "testnet", `API config ${c.json.chainId} ${c.json.network}`);
    return `deploy [PASS], PostDeployCheck [PASS]; Safe ${safe} ${threshold}-of-${owners.length} administers, deployer holds no role; API ${c.json.chainId} ${c.json.network}`;
  });
  await flow("setup", "A single Safe owner cannot administer (expected failure)", "execTransaction with one owner signature reverts GS020 (signatures data too short); nothing changes", async (f) => {
    const safe = getAddress(cfg.roles.owner);
    const data = encodeFunctionData({ abi: OptionEngineAbi, functionName: "setBuysPaused", args: [true] });
    const nonce = await pub.readContract({ address: safe, abi: safeAbi, functionName: "nonce" });
    const Z = "0x0000000000000000000000000000000000000000" as Address;
    const h = await pub.readContract({ address: safe, abi: safeAbi, functionName: "getTransactionHash", args: [C.engine, 0n, data, 0, 0n, 0n, 0n, Z, Z, nonce] });
    const one = await signSafeTx(h, ["owner-1"]);
    const reason = await f.expectRevert("safe.execTransaction (1 of 3 signatures)", "owner-1", { to: safe, data: encodeFunctionData({ abi: safeAbi, functionName: "execTransaction", args: [C.engine, 0n, data, 0, 0n, 0n, 0n, Z, Z, one] }) }, /GS020|GS026|revert/);
    const flags = await engineRead<readonly [boolean, boolean, boolean, boolean]>("flags");
    assert(!flags[0], "buys got paused by one owner");
    return `one signature refused: ${reason}; buys still open`;
  });
  await flow("setup", "Test wallets funded from the deployer (the only faucet wallet)", "every sending wallet holds gas ETH; test users hold tUSDG (minted by the deployer, the mock's owner, topped up here so a re-run starts from the same balances); carol holds test NVDA", async (f) => {
    // Gas ETH back up to the ledger's amount for the exercise's own wallets (a re-run starts funded too).
    for (const [role, eth] of Object.entries(fundingPlan()) as [TestnetRole, string][]) {
      if (["keeper", "vol-signer", "feed-mirror", "bundler", "x402-settler", "hedger"].includes(role)) continue; // bots: fund.ts
      const want = parseEther(eth);
      const have = await pub.getBalance({ address: addressOf(role) });
      if (have * 2n < want) await f.send(`gas top-up ${role}`, "deployer", { to: addressOf(role), data: "0x", value: want - have });
    }
    for (const [role, t] of Object.entries(USER_TOKENS) as [TestnetRole, { usdg: number; stocks?: Record<string, number> }][]) {
      const want = USD(t.usdg);
      const have = await usdgOf(addressOf(role));
      if (have < want) await f.send(`tUSDG top-up ${role} [mock owner]`, "deployer", { to: C.usdg, data: encodeFunctionData({ abi: erc20Abi, functionName: "mint", args: [addressOf(role), want - have] }) });
      for (const [name, n] of Object.entries(t.stocks ?? {})) {
        const held = await tokenBalance(stockOf(name), addressOf(role));
        if (held < BigInt(n) * WAD) await f.send(`test ${name} top-up ${role} [mock owner]`, "deployer", { to: stockOf(name), data: encodeFunctionData({ abi: testnetStockAbi, functionName: "mint", args: [addressOf(role), BigInt(n) * WAD - held] }) });
      }
    }
    const low: string[] = [];
    for (const r of ["keeper", "vol-signer", "feed-mirror", "bundler", "owner-1", "alice", "bob", "carol", "depositor", "agent", "agent-owner", "payer", "lp2", "x402-settler"] as TestnetRole[]) {
      if ((await pub.getBalance({ address: addressOf(r) })) === 0n) low.push(r);
    }
    assert(!low.length, `no gas ETH: ${low.join(", ")} (run fund.ts)`);
    const nvda = await tokenBalance(stockOf("NVDA"), addressOf("carol"));
    const u = await usdgOf(addressOf("depositor"));
    assert(nvda >= 25n * WAD && u >= USD(200_000), "test users not funded (run fund.ts)");
    return `all sending wallets hold gas; depositor ${fmt(u)} tUSDG; carol ${fmt(nvda, 18)} test NVDA`;
  });
  await flow("setup", "In a trading session with fresh vol", "PriceGuard reads REGULAR or EXTENDED for every name (real NYSE 24/5 calendar pushed by the keeper) and the vol-engine has posted every name and speed", async () => {
    const r = await priceReading("NVDA");
    if (r.session > 1) throw new Error(`NVDA session is ${SESS[r.session]}: buys need REGULAR or EXTENDED (Sun 20:00 to Fri 20:00 New York time). Re-run then.`);
    await waitVolFresh(dep.stocks.map((s) => s.name));
    return `session ${SESS[r.session]}; vol fresh for ${dep.stocks.map((s) => s.name).join(", ")}`;
  });
  await flow("setup", "Keeper lists the grid and turns it buyable", "every launch name has Daily+Weekly calls and puts on the strike grid, buyable, visible in /v1/chains", async () => {
    await waitFor("the whole grid listed and buyable", async () => {
      const done = await sql`select count(*) filter (where buyable)::int as b from series`;
      if ((done[0]!.b as number) < dep.stocks.length * 20) return false;
      const names = (await api("/v1/chains")).json.names ?? [];
      return names.length === dep.stocks.length && names.every((n: any) => n.buyable);
    }, 1_800_000, 10_000);
    const counts = await sql`select name, count(*)::int as n, count(*) filter (where buyable)::int as b from series group by name order by name`;
    return `${counts.reduce((a, r) => a + (r.n as number), 0)} series (${counts.map((r) => `${r.name} ${r.b}/${r.n}`).join(", ")})`;
  });

  // ---------------------------------------------------------------- pool (60 s lock, 5 min queue)
  let ticket = 0n;
  let depositedAt = 0;
  await flow("pool", "Allowlisted deposit", "deposit 200,000 tUSDG mints shares at NAV + 10 bps; /v1/pool NAV shows it after indexing", async (f) => {
    const who = addressOf("depositor");
    await f.send("usdg.approve", "depositor", { to: C.usdg, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [C.pool, USD(200_000)] }) });
    const r = await f.send("pool.deposit", "depositor", { to: C.pool, data: encodeFunctionData({ abi: PoolAbi, functionName: "deposit", args: [USD(200_000), who] }) });
    depositedAt = Number((await pub.getBlock({ blockNumber: r.blockNumber })).timestamp);
    const ev = events(r, PoolAbi, C.pool).find((e) => e.eventName === "Deposit");
    assert(ev && ev.args.shares > 0n, "no Deposit event");
    const nav = await waitFor("pool NAV in the API", async () => { const p = (await api("/v1/pool")).json; return Number(p.nav) >= 199_000 ? p : false; });
    return `shares ${fmt(ev.args.shares, 12)}; API NAV ${nav.nav}, navPerShare ${nav.navPerShare}`;
  });
  await flow("pool", "Withdraw inside the 60 s deposit lock (expected failure)", "requestWithdraw reverts WithdrawalLocked within lockSeconds of a deposit", async (f) => {
    const shares = await pub.readContract({ address: C.pool, abi: erc20Abi, functionName: "balanceOf", args: [addressOf("depositor")] });
    return f.expectRevert("pool.requestWithdraw", "depositor", { to: C.pool, data: encodeFunctionData({ abi: PoolAbi, functionName: "requestWithdraw", args: [shares / 4n] }) }, "WithdrawalLocked");
  });
  await flow("pool", "Deposit from a wallet not on the allowlist (expected failure)", "reverts NotDepositor (closed beta)", async (f) => {
    await f.send("usdg.approve", "lp2", { to: C.usdg, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [C.pool, USD(1000)] }) });
    return f.expectRevert("pool.deposit", "lp2", { to: C.pool, data: encodeFunctionData({ abi: PoolAbi, functionName: "deposit", args: [USD(1000), addressOf("lp2")] }) }, "NotDepositor");
  });

  // ---------------------------------------------------------------- replay R3: simulator vs engine (reads only)
  await flow("replay", "The simulator's quote vs the deployed engine, 20 testnet states", "for 20 listed series (every name, both speeds, calls and puts, buys and sells) the sim quote model on the chain's own S, sigma, skew and session matches IOptionEngine.quote (0.5%, sigma exact)", async () => {
    const states: (EngineState & { id: string })[] = [];
    let k = 0;
    for (const s of dep.stocks) {
      const ch = await chainOf(s.name);
      const pr = await priceReading(s.name);
      const picks = [...ch.rows].sort((a, b) => a.strike - b.strike).filter((_, i) => i % 5 === k % 5).slice(0, 4);
      k++;
      for (const [j, row] of picks.entries()) {
        const vol = await volRead(s.name, row.speed === "DAILY" ? 0 : 1);
        const now = await chainTime();
        const tradeTwap = Number(await pub.readContract({ address: C.priceGuard, abi: PriceGuardAbi, functionName: "tradeTwap", args: [stockOf(s.name)] }) as bigint) / 1e18;
        states.push({
          id: row.id, name: s.name, unitsWad: parseUnits(String(1 + j * 3.5), 18), isBuy: j % 2 === 0,
          series: { isCall: row.isCall, speed: row.speed, strike: row.strike, buyable: row.buyable, archived: false },
          market: {
            spot: Number(pr.s) / 1e18, session: SESS[pr.session]!, fresh: pr.fresh, priceBuysPaused: pr.buysPaused, engineBuysPaused: false,
            sigmaBps: Number(vol.sigmaBps), skewK: BigInt(vol.skewK), volStale: vol.stale, nowMs: now * 1000, tradeTwap: tradeTwap || null,
            buyBlockFromMs: Number(vol.buyBlockFrom) ? Number(vol.buyBlockFrom) * 1000 : null, buyBlockToMs: Number(vol.buyBlockTo) ? Number(vol.buyBlockTo) * 1000 : null,
          },
        });
      }
    }
    const r = await compareWithEngine(async ({ id, unitsWad, isBuy }) => fromEngineStruct(await engineRead("quote", [id, unitsWad, isBuy])), (st) => (st as EngineState & { id: string }).id, async () => undefined, states.slice(0, 20));
    assert(r.status === "pass", `${r.failures.length}/${r.compared} differ: ${JSON.stringify(r.failures.slice(0, 3))}`);
    return `${r.compared}/${r.compared} states match`;
  });

  // ---------------------------------------------------------------- buys
  const nvda = await chainOf("NVDA");
  const byDist = (rows: SeriesRow[], spot: number) => [...rows].sort((a, b) => Math.abs(a.strike - spot) - Math.abs(b.strike - spot));
  const atmDaily = byDist(nvda.rows.filter((r) => r.speed === "DAILY" && r.isCall), nvda.spot)[0]!;
  const bought: { role: TestnetRole; row: SeriesRow }[] = [];
  const nvdaPicks: SeriesRow[] = [];
  for (const speed of ["DAILY", "WEEKLY"] as const) for (const isCall of [true, false]) {
    const rows = byDist(nvda.rows.filter((r) => r.speed === speed && r.isCall === isCall), nvda.spot);
    nvdaPicks.push(rows[0]!, rows[2]!);
  }
  for (const row of nvdaPicks) {
    const pct = ((row.strike / nvda.spot - 1) * 100).toFixed(1);
    await flow("buy", `NVDA ${row.speed} ${row.isCall ? "call" : "put"} K=${row.strike} (${pct}% from spot)`, "API intent -> approve + engine.buy; Bought event; tokens minted; position in the API after indexing", async (f) => {
      const q10 = await engineRead<{ usdg: bigint }>("quote", [row.id, 10n * WAD, true]);
      const units = q10.usdg >= 1_500_000n ? "10" : String(Math.ceil((10 * 1.5e6) / Math.max(1, Number(q10.usdg))));
      const { receipt, intent } = await viaIntent(f, "buy", "alice", { series: row.id, units, slippageBps: 100 });
      const ev = events(receipt, OptionEngineAbi, C.engine).find((e) => e.eventName === "Bought");
      assert(ev, "no Bought event");
      assert(BigInt(ev.args.usdgPaid) <= BigInt(intent.maxCostUsdg), "paid more than maxCost");
      bought.push({ role: "alice", row });
      const held = await waitFor("position indexed", async () => { const u = await positionUnits(addressOf("alice"), row.id); return u > 0 ? u : false; });
      return `paid ${fmt(ev.args.usdgPaid)} tUSDG (spread ${intent.quote.spreadBps} bps, sigma ${intent.quote.sigmaBps}); tokens ${fmt(ev.args.tokens, 18)}; API units ${held}`;
    });
  }
  for (const s of dep.stocks.filter((x) => x.name !== "NVDA")) {
    const ch = await chainOf(s.name);
    const vol = await volRead(s.name, 0);
    const now = BigInt(await chainTime());
    if (vol.buyBlockFrom <= now && now <= vol.buyBlockTo && vol.buyBlockTo > 0n) {
      const row = byDist(ch.rows.filter((r) => r.speed === "DAILY" && r.isCall), ch.spot)[0]!;
      await flow("buy", `${s.name}: earnings buy-block from the vol-engine (expected failure)`, "API 409 EARNINGS_BLOCK, engine.buy reverts EarningsBlock", async (f) => {
        const r = await api("/v1/intent/buy", { account: addressOf("bob"), series: row.id, units: "1", slippageBps: 100 });
        assert(r.status === 409 && r.json.reason === "EARNINGS_BLOCK", `API answered ${r.status}`);
        await f.send("usdg.approve", "bob", { to: C.usdg, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [C.engine, USD(1_000_000)] }) });
        return f.expectRevert("engine.buy", "bob", { to: C.engine, data: encodeFunctionData({ abi: OptionEngineAbi, functionName: "buy", args: [row.id, WAD, USD(5000), BigInt(await chainTime()) + 300n, addressOf("bob")] }) }, "EarningsBlock");
      });
      continue;
    }
    for (const [speed, isCall] of [["DAILY", true], ["WEEKLY", false]] as const) {
      const row = byDist(ch.rows.filter((r) => r.speed === speed && r.isCall === isCall), ch.spot)[0]!;
      await flow("buy", `${s.name} ${speed} ${isCall ? "call" : "put"} ATM K=${row.strike}`, "buy through the API intent; Bought; position indexed", async (f) => {
        const units = s.name === "SPY" || s.name === "QQQ" ? "2" : "5";
        const { receipt } = await viaIntent(f, "buy", "bob", { series: row.id, units, slippageBps: 100 });
        const ev = events(receipt, OptionEngineAbi, C.engine).find((e) => e.eventName === "Bought");
        assert(ev, "no Bought event");
        bought.push({ role: "bob", row });
        const held = await waitFor("position indexed", async () => { const u = await positionUnits(addressOf("bob"), row.id); return u > 0 ? u : false; });
        return `paid ${fmt(ev.args.usdgPaid)} tUSDG, API units ${held}`;
      });
    }
  }
  await flow("buy", "Slippage limit below the price (expected failure)", "engine.buy reverts Slippage when maxCost is under the ask", async (f) => {
    const q = await engineRead<{ usdg: bigint }>("quote", [atmDaily.id, 10n * WAD, true]);
    return f.expectRevert("engine.buy", "alice", { to: C.engine, data: encodeFunctionData({ abi: OptionEngineAbi, functionName: "buy", args: [atmDaily.id, 10n * WAD, q.usdg / 2n, BigInt(await chainTime()) + 300n, addressOf("alice")] }) }, "Slippage");
  });
  await flow("buy", "Deadline in the past (expected failure)", "engine.buy reverts Expired", async (f) =>
    f.expectRevert("engine.buy", "alice", { to: C.engine, data: encodeFunctionData({ abi: OptionEngineAbi, functionName: "buy", args: [atmDaily.id, 10n * WAD, USD(1000), BigInt(await chainTime()) - 10n, addressOf("alice")] }) }, "Expired"));
  await flow("buy", "Buy without tUSDG approval (expected failure)", "engine.buy reverts on the transferFrom", async (f) =>
    f.expectRevert("engine.buy", "lp2", { to: C.engine, data: encodeFunctionData({ abi: OptionEngineAbi, functionName: "buy", args: [atmDaily.id, 10n * WAD, USD(1000), BigInt(await chainTime()) + 300n, addressOf("lp2")] }) }, /Insufficient|allowance|revert|SafeERC20/i));

  // ---------------------------------------------------------------- parity (reads only)
  await flow("parity", "API quote vs on-chain engine.quote, 100 random cases", "every case within 0.5% (or $0.01 for sub-cent quotes)", async () => {
    let seed = 26;
    const rnd = () => { seed = (seed * 1103515245 + 12345) % 2 ** 31; return seed / 2 ** 31; };
    const rows: SeriesRow[] = [];
    for (const s of dep.stocks) rows.push(...(await chainOf(s.name)).rows);
    const cases: { ok: boolean; rel: number; chain: number }[] = [];
    let worst = "";
    for (let i = 0; i < 100; i++) {
      const row = rows[Math.floor(rnd() * rows.length)]!;
      const units = (0.5 + rnd() * 30).toFixed(4);
      const side = rnd() < 0.5 ? "buy" : "sell";
      const [a, c] = await Promise.all([api("/v1/quote", { series: row.id, units, side }), engineRead<{ usdg: bigint }>("quote", [row.id, parseUnits(units, 18), side === "buy"])]);
      if (a.status !== 200) throw new Error(`/v1/quote ${a.status}: ${JSON.stringify(a.json).slice(0, 200)}`);
      const av = Number(BigInt(a.json.quote.usdg));
      const cv = Number(c.usdg);
      const rel = cv > 0 ? Math.abs(av - cv) / cv : 0;
      const ok = Math.abs(av - cv) <= 10_000 || rel <= 0.005;
      if (!ok) worst = `${row.name} ${row.speed} ${row.isCall ? "C" : "P"}${row.strike} ${side} ${units}: api ${av} chain ${cv}`;
      cases.push({ ok, rel, chain: cv });
    }
    writeFileSync(join(OUT, "parity.json"), JSON.stringify(cases));
    const bad = cases.filter((x) => !x.ok).length;
    assert(bad === 0, `${bad}/100 outside 0.5%; e.g. ${worst}`);
    const rels = cases.filter((x) => x.chain > 10_000).map((x) => x.rel).sort((p, q) => p - q);
    return `100/100 within tolerance; median ${(rels[Math.floor(rels.length / 2)]! * 100).toFixed(4)}%, max ${(rels.at(-1)! * 100).toFixed(4)}%`;
  });

  // ---------------------------------------------------------------- shield
  await flow("shield", "Shield a test Stock Token holding", "API shield intent -> engine.shield buys a Weekly Down option ~10% below spot for the NVDA held; ShieldBought; position indexed", async (f) => {
    const probe = await api("/v1/intent/shield", { account: addressOf("carol"), name: "NVDA", tokenUnits: "5", strikePctBelowBps: 1000, slippageBps: 100 });
    if (probe.status !== 200) throw new Error(`/v1/intent/shield ${probe.status}: ${JSON.stringify(probe.json).slice(0, 300)}`);
    const per5 = Number(probe.json.quote?.usdg ?? probe.json.maxCostUsdg);
    const tokenUnits = per5 >= 1_500_000 ? "5" : String(Math.min(25, Math.ceil((5 * 1.5e6) / Math.max(1, per5))));
    const { receipt } = await viaIntent(f, "shield", "carol", { name: "NVDA", tokenUnits, strikePctBelowBps: 1000, slippageBps: 100 });
    const ev = events(receipt, OptionEngineAbi, C.engine).find((e) => e.eventName === "ShieldBought");
    assert(ev, "no ShieldBought");
    const held = await waitFor("shield position indexed", async () => { const u = await positionUnits(addressOf("carol"), ev.args.id); return u > 0 ? u : false; });
    return `paid ${fmt(ev.args.usdgPaid)} tUSDG for ${fmt(ev.args.tokenUnits, 18)} NVDA; API units ${held}`;
  });
  await flow("shield", "Shield more than the wallet holds (expected failure)", "reverts ShieldExceedsHolding", async (f) =>
    f.expectRevert("engine.shield", "carol", { to: C.engine, data: encodeFunctionData({ abi: OptionEngineAbi, functionName: "shield", args: [stockOf("NVDA"), 500n * WAD, 1000, USD(100_000), BigInt(await chainTime()) + 300n] }) }, "ShieldExceedsHolding"));

  // ---------------------------------------------------------------- restart safety
  await flow("restart", "Kill and restart indexer and keeper mid-run", "a trade made while both are down is indexed once after restart; no duplicate rows; keeper re-lists nothing", async (f) => {
    const row = nvdaPicks[0]!; // at the money: 3 units are well above the $1 minimum
    const q3 = await engineRead<{ usdg: bigint }>("quote", [row.id, 3n * WAD, true]);
    const units = q3.usdg >= 1_500_000n ? "3" : String(Math.ceil((3 * 1.5e6) / Math.max(1, Number(q3.usdg))));
    const listedBefore = await pub.readContract({ address: C.registry, abi: SeriesRegistryAbi, functionName: "seriesCount" });
    await stopService("indexer");
    await stopService("keeper");
    let receipt: TransactionReceipt;
    try {
      receipt = (await viaIntent(f, "buy", "bob", { series: row.id, units, slippageBps: 100 })).receipt;
    } finally {
      await startServices(); // never leave the indexer and keeper down for the flows after this one
    }
    await waitFor("trade indexed after restart", async () => (await sql`select count(*)::int as n from trades where tx_hash = ${receipt.transactionHash}`)[0]!.n === 1, 300_000, 3000);
    await Bun.sleep(20_000);
    const dup = await sql`select tx_hash, log_index, count(*) from trades group by 1,2 having count(*) > 1`;
    const listedAfter = await pub.readContract({ address: C.registry, abi: SeriesRegistryAbi, functionName: "seriesCount" });
    assert(dup.length === 0, "duplicate trade rows");
    assert(listedAfter === listedBefore, `keeper listed ${listedAfter - listedBefore} new series after restart`);
    return `the buy made while both were down was indexed exactly once; 0 duplicate rows; seriesCount ${listedAfter}`;
  });

  // ---------------------------------------------------------------- withdrawal queue (5 min)
  await flow("pool", "Queue a withdrawal after the 60 s lock", "requestWithdraw locks shares, WithdrawalQueued with claimableAt = now + 300 s; /v1/pool queue counts it", async (f) => {
    await untilChainTime(depositedAt + 61, "the deposit lock to pass");
    const shares = await pub.readContract({ address: C.pool, abi: erc20Abi, functionName: "balanceOf", args: [addressOf("depositor")] });
    const r = await f.send("pool.requestWithdraw", "depositor", { to: C.pool, data: encodeFunctionData({ abi: PoolAbi, functionName: "requestWithdraw", args: [shares / 4n] }) });
    const ev = events(r, PoolAbi, C.pool).find((e) => e.eventName === "WithdrawalQueued");
    assert(ev, "no WithdrawalQueued");
    ticket = BigInt(ev.args.ticket ?? ev.args.id);
    const at = Number((await pub.getBlock({ blockNumber: r.blockNumber })).timestamp);
    const claimableAt = Number(ev.args.claimableAt);
    assert(claimableAt - at === 300, `claimableAt in ${claimableAt - at} s, expected 300`);
    const q = await waitFor("queue in the API", async () => { const p = (await api("/v1/pool")).json; return p.queue?.withdrawals >= 1 ? p.queue : false; }).catch(() => null);
    return `ticket ${ticket}, claimable in 300 s; API queue ${JSON.stringify(q)}`;
  });
  await flow("pool", "Claim before the 5-minute queue ends (expected failure)", "claim reverts NotClaimable", async (f) =>
    f.expectRevert("pool.claim", "depositor", { to: C.pool, data: encodeFunctionData({ abi: PoolAbi, functionName: "claim", args: [ticket] }) }, "NotClaimable"));

  // ---------------------------------------------------------------- funding in real time
  await flow("funding", "Hold across real time: funding shrinks units exactly as the TS reference", "every consecutive Accrued pair of a held series: norm_after = fundingStep(norm_before, V, payoff, dt, tau) within 1e-9", async (f) => {
    const id = atmDaily.id;
    await f.send("engine.accrue", "alice", { to: C.engine, data: encodeFunctionData({ abi: OptionEngineAbi, functionName: "accrue", args: [id] }) }, 3_000_000n);
    await Bun.sleep(90_000);
    await f.send("engine.accrue", "alice", { to: C.engine, data: encodeFunctionData({ abi: OptionEngineAbi, functionName: "accrue", args: [id] }) }, 3_000_000n);
    const logs = await pub.getContractEvents({ address: C.engine, abi: OptionEngineAbi, eventName: "Accrued", args: { id }, fromBlock: BigInt(dep.deployBlock), toBlock: "latest" });
    const times = await Promise.all(logs.map(async (l) => Number((await pub.getBlock({ blockNumber: l.blockNumber! })).timestamp)));
    let worst = 0;
    let steps = 0;
    for (let i = 1; i < logs.length; i++) {
      const prev = logs[i - 1]!.args as any;
      const cur = logs[i]!.args as any;
      const dt = times[i]! - times[i - 1]!;
      if (dt <= 0) continue;
      const expected = fundingStep(Number(prev.norm) / 1e18, Number(cur.vMarkWad) / 1e18, Number(cur.payoffWad) / 1e18, dt, 86_400);
      worst = Math.max(worst, Math.abs(Number(cur.norm) / 1e18 - expected) / expected);
      steps++;
    }
    assert(steps >= 1 && worst < 1e-9, `worst rel error ${worst} over ${steps} steps`);
    return `${steps} accrual steps over ${logs.length} Accrued events, worst relative error ${worst.toExponential(2)}`;
  });

  // ---------------------------------------------------------------- sells
  for (const [i, b] of bought.filter((x) => x.role === "alice").slice(0, 3).entries()) {
    await flow("sell", `Sell half (whole when half is under $1) of NVDA ${b.row.speed} ${b.row.isCall ? "call" : "put"} K=${b.row.strike}`, "API sell intent -> engine.sell burns tokens, pays tUSDG >= minProceeds; position shrinks in the API", async (f) => {
      const all = await positionUnits(addressOf("alice"), b.row.id);
      const half = await engineRead<{ usdg: bigint }>("quote", [b.row.id, parseUnits((all / 2).toFixed(6), 18), false]);
      const whole = half.usdg < 1_200_000n;
      const before = await usdgOf(addressOf("alice"));
      const receipt = whole
        ? await f.send("engine.sell (whole balance)", "alice", { to: C.engine, data: encodeFunctionData({ abi: OptionEngineAbi, functionName: "sell", args: [b.row.id, await tokenBalance(b.row.token, addressOf("alice")), 0n, BigInt(await chainTime()) + 600n, addressOf("alice")] }) })
        : (await viaIntent(f, "sell", "alice", { series: b.row.id, units: (all / 2).toFixed(6), slippageBps: 100 })).receipt;
      assert(events(receipt, OptionEngineAbi, C.engine).some((e) => e.eventName === "Sold"), "no Sold");
      const got = (await usdgOf(addressOf("alice"))) - before;
      const left = await waitFor("position shrinks", async () => { const u = await positionUnits(addressOf("alice"), b.row.id); return u < all ? String(u) : false; });
      return `${whole ? "whole" : "half"}: received ${fmt(got)} tUSDG; API units left ${left}${i === 0 ? "" : ""}`;
    });
  }
  await flow("sell", "Sell more tokens than held (expected failure)", "engine.sell reverts on the token burn", async (f) =>
    f.expectRevert("engine.sell", "alice", { to: C.engine, data: encodeFunctionData({ abi: OptionEngineAbi, functionName: "sell", args: [atmDaily.id, 10_000n * WAD, 0n, BigInt(await chainTime()) + 300n, addressOf("alice")] }) }, /ERC20InsufficientBalance|revert/));

  // ---------------------------------------------------------------- claim after the 5-minute queue
  await flow("pool", "Claim the withdrawal after the 5-minute queue", "claim pays tUSDG at claim-time NAV; WithdrawalClaimed", async (f) => {
    const t = await pub.readContract({ address: C.pool, abi: PoolAbi, functionName: "ticketOf", args: [ticket] }) as readonly [Address, bigint, bigint];
    await untilChainTime(Number(t[2]) + 5, "the 5-minute queue");
    const before = await usdgOf(addressOf("depositor"));
    const r = await f.send("pool.claim", "depositor", { to: C.pool, data: encodeFunctionData({ abi: PoolAbi, functionName: "claim", args: [ticket] }) });
    assert(events(r, PoolAbi, C.pool).some((e) => e.eventName === "WithdrawalClaimed"), "no WithdrawalClaimed");
    return `claimed ${fmt((await usdgOf(addressOf("depositor"))) - before)} tUSDG for ticket ${ticket}`;
  });

  // ---------------------------------------------------------------- fees (5-minute period)
  await flow("fees", "Fee distribution after the 5-minute period", "the FeeRouter's period ends 300 s after the last distribution; distribute (the keeper's job, or anyone) moves the fees to the treasury and the pots", async (f) => {
    const feeRouter = getAddress(C.feeRouter!);
    const feeAbi = parseAbi(["function nextDistributionAt() view returns (uint256)", "function distribute()", "function PERIOD() view returns (uint256)"]);
    const period = await pub.readContract({ address: feeRouter, abi: feeAbi, functionName: "PERIOD" });
    assert(period === 300n, `FeeRouter PERIOD ${period}`);
    const next = Number(await pub.readContract({ address: feeRouter, abi: feeAbi, functionName: "nextDistributionAt" }));
    const pots = [addressOf("treasury"), addressOf("keepers-pot"), addressOf("hedger-pot")];
    const before = await Promise.all(pots.map((a) => usdgOf(a)));
    await untilChainTime(next + 2, "the fee period");
    await waitFor("fees distributed (keeper job)", async () => (await Promise.all(pots.map((a) => usdgOf(a)))).some((v, i) => v > before[i]!), 180_000, 5000).catch(async () => {
      await f.send("feeRouter.distribute (anyone)", "bob", { to: feeRouter, data: encodeFunctionData({ abi: feeAbi, functionName: "distribute" }) });
    });
    const after = await Promise.all(pots.map((a) => usdgOf(a)));
    assert(after.some((v, i) => v > before[i]!), "no pot received fees");
    return `period ${period} s; treasury +${fmt(after[0]! - before[0]!)}, keepers pot +${fmt(after[1]! - before[1]!)}, hedger pot +${fmt(after[2]! - before[2]!)} tUSDG`;
  });

  // ---------------------------------------------------------------- agents (MCP + AgentRouter)
  const agentEnv = Object.fromEntries(readFileSync(join(TESTNET_DIR, "env", "mcp.env"), "utf8").split("\n").filter(Boolean).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
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
  const owner = addressOf("agent-owner");
  const agent = addressOf("agent");
  const router = C.agentRouter as Address;
  await flow("agent", "Owner sets an agent policy on the AgentRouter", "setPolicy(budget 150, max 100/trade, 1 day, sell yes, shield no, NVDA only); /v1/accounts/{owner}/agents shows it", async (f) => {
    await f.send("agentRouter.setPolicy", "agent-owner", { to: router, data: encodeFunctionData({ abi: AgentRouterAbi, functionName: "setPolicy", args: [agent, USD(150), USD(100), BigInt(await chainTime()) + 86_400n, true, false, [stockOf("NVDA")]] }) });
    await f.send("usdg.approve(router)", "agent-owner", { to: C.usdg, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [router, USD(150)] }) });
    const shown = await waitFor("agent policy indexed", async () => { const a = (await api(`/v1/accounts/${owner}/agents`)).json; return (a.agents ?? []).length ? a.agents[0] : false; });
    return `policy indexed: ${JSON.stringify(shown).slice(0, 200)}`;
  });
  await flow("agent", "MCP lmns_quote and lmns_buy through the AgentRouter", "lmns_buy sends AgentRouter.buyFor; tokens go to the owner; AgentTrade event", async (f) => {
    await mcp("lmns_quote", { series: atmDaily.id, units: "5", side: "buy" });
    const before = await tokenBalance(atmDaily.token, owner);
    const sent = await mcp("lmns_buy", { series: atmDaily.id, units: "5", slippageBps: 100, owner });
    const r = await pub.waitForTransactionReceipt({ hash: sent.txHash });
    f.txs.push({ flow: f.id, label: "agentRouter.buyFor (MCP)", hash: sent.txHash, gas: r.gasUsed.toString(), status: r.status, at: Date.now(), from: "agent" });
    assert(r.status === "success" && events(r, AgentRouterAbi, router).some((e) => e.eventName === "AgentTrade"), `buyFor ${sent.txHash} failed`);
    const after = await tokenBalance(atmDaily.token, owner);
    assert(after > before && (await tokenBalance(atmDaily.token, agent)) === 0n, "tokens not with the owner");
    return `buyFor ${txLink(sent.txHash)}; owner tokens +${fmt(after - before, 18)}; agent holds 0`;
  });
  await flow("agent", "MCP lmns_sell through the AgentRouter", "owner approves the option token; lmns_sell sends sellFor; proceeds go to the owner", async (f) => {
    const bal = await tokenBalance(atmDaily.token, owner);
    await f.send("optionToken.approve(router)", "agent-owner", { to: atmDaily.token, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [router, bal] }) });
    const before = await usdgOf(owner);
    const units = (await waitFor("owner position indexed", async () => { const u = await positionUnits(owner, atmDaily.id); return u > 0 ? u : false; })) / 2;
    const sent = await mcp("lmns_sell", { series: atmDaily.id, units: units.toFixed(6), slippageBps: 100, owner });
    const r = await pub.waitForTransactionReceipt({ hash: sent.txHash });
    f.txs.push({ flow: f.id, label: "agentRouter.sellFor (MCP)", hash: sent.txHash, gas: r.gasUsed.toString(), status: r.status, at: Date.now(), from: "agent" });
    assert(r.status === "success", "sellFor reverted");
    return `sellFor ${txLink(sent.txHash)}; owner +${fmt((await usdgOf(owner)) - before)} tUSDG`;
  });
  await flow("agent", "Budget exhaustion: MCP refuses and the router reverts (expected failure)", "after an 85-tUSDG buyFor, lmns_buy over the remaining budget is refused and a direct buyFor reverts BudgetExceeded", async (f) => {
    const perUnit = (await engineRead<{ usdg: bigint }>("quote", [atmDaily.id, WAD, true])).usdg;
    const unitsFor = (usd: number) => (USD(usd) * WAD) / perUnit;
    const deadline = BigInt(await chainTime()) + 300n;
    await f.send("agentRouter.buyFor (85 tUSDG)", "agent", { to: router, data: encodeFunctionData({ abi: AgentRouterAbi, functionName: "buyFor", args: [owner, atmDaily.id, unitsFor(85), USD(100), deadline] }) });
    const remaining = await pub.readContract({ address: router, abi: AgentRouterAbi, functionName: "remainingBudget", args: [owner, agent] }) as bigint;
    const over = unitsFor(Number(fmt(remaining)) + 20);
    let refused = "NOT refused";
    try { await mcp("lmns_buy", { series: atmDaily.id, units: formatUnits(over, 18).slice(0, 12), slippageBps: 100, owner }); } catch (e) { refused = (e as Error).message.slice(0, 160); }
    assert(refused !== "NOT refused", "MCP sent a buy over budget");
    const reason = await f.expectRevert("agentRouter.buyFor (over budget)", "agent", { to: router, data: encodeFunctionData({ abi: AgentRouterAbi, functionName: "buyFor", args: [owner, atmDaily.id, over, USD(99), deadline] }) }, "BudgetExceeded");
    return `remaining ${fmt(remaining)}; MCP: ${refused}; chain: ${reason}`;
  });
  await flow("agent", "Per-trade limit (expected failure)", "a buyFor costing more than maxPerTradeUsdg reverts", async (f) => {
    const perUnit = (await engineRead<{ usdg: bigint }>("quote", [atmDaily.id, WAD, true])).usdg;
    return f.expectRevert("agentRouter.buyFor (120 tUSDG)", "agent", { to: router, data: encodeFunctionData({ abi: AgentRouterAbi, functionName: "buyFor", args: [owner, atmDaily.id, (USD(120) * WAD) / perUnit, USD(130), BigInt(await chainTime()) + 300n] }) }, /MaxPerTradeExceeded|BudgetExceeded/);
  });
  await flow("agent", "A non-NVDA buy by the agent (expected failure)", "buyFor on a TSLA series reverts StockNotAllowed", async (f) => {
    const tsla = (await chainOf("TSLA")).rows.find((r) => r.speed === "DAILY" && r.isCall)!;
    return f.expectRevert("agentRouter.buyFor", "agent", { to: router, data: encodeFunctionData({ abi: AgentRouterAbi, functionName: "buyFor", args: [owner, tsla.id, WAD, USD(50), BigInt(await chainTime()) + 300n] }) }, "StockNotAllowed");
  });
  await flow("agent", "Owner revokes the policy", "revoke; a later buyFor reverts PolicyIsRevoked", async (f) => {
    await f.send("agentRouter.revoke", "agent-owner", { to: router, data: encodeFunctionData({ abi: AgentRouterAbi, functionName: "revoke", args: [agent] }) });
    return f.expectRevert("agentRouter.buyFor", "agent", { to: router, data: encodeFunctionData({ abi: AgentRouterAbi, functionName: "buyFor", args: [owner, atmDaily.id, WAD, USD(50), BigInt(await chainTime()) + 300n] }) }, "PolicyIsRevoked");
  });

  // ---------------------------------------------------------------- x402 (a second API with x402 on; settler keystore)
  let x402Api: ChildProcess | undefined;
  await flow("x402", "x402 paid data call over Permit2", "GET a paid route -> 402; the payer signs; the retry returns 200 and the settler moves tUSDG payer -> treasury", async (f) => {
    const port = PORTS.x402;
    const payTo = addressOf("treasury");
    const env: Record<string, string> = {
      ...Object.fromEntries(readFileSync(join(TESTNET_DIR, "env", "api.env"), "utf8").split("\n").filter(Boolean).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)])),
      API_PORT: String(port), X402_ENABLED: "1", X402_PAY_TO: payTo, X402_RPC_URL: RPC, PATH: process.env.PATH ?? "",
      X402_SETTLER_KEYSTORE: join(process.env.TESTNET_KEYS_DIR || join(process.env.HOME ?? "", ".lemniscate", "testnet-keys"), "x402-settler.json"),
      X402_SETTLER_KEYSTORE_PASSWORD_FILE: join(process.env.TESTNET_KEYS_DIR || join(process.env.HOME ?? "", ".lemniscate", "testnet-keys"), "x402-settler.password"),
    };
    const logFd = openSync(join(TESTNET_DIR, "logs", "api-x402.log"), "a");
    x402Api = spawn("bun", ["src/bin/api.ts"], { cwd: APP, env, stdio: ["ignore", logFd, logFd] });
    writeFileSync(join(TESTNET_DIR, "pids", "api-x402.pid"), String(x402Api.pid));
    const base = `http://127.0.0.1:${port}`;
    await waitFor("x402 API up", async () => (await fetch(`${base}/v1/health`)).ok, 90_000, 1000);
    await f.send("usdg.approve(Permit2)", "payer", { to: C.usdg, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: ["0x000000000022D473030F116dDEE9F6B43aC78BA3", USD(10)] }) });
    const unpaid = await fetch(`${base}/v1/vol/NVDA`);
    assert(unpaid.status === 402, `unpaid call returned ${unpaid.status}`);
    const before = await usdgOf(payTo);
    const paid = await createPayingFetch(fetch, accountOf("payer"), { chainId: TESTNET_CHAIN_ID, maxAmount: USD(0.02) })(`${base}/v1/vol/NVDA`);
    assert(paid.status === 200, `paid call returned ${paid.status}: ${(await paid.text()).slice(0, 200)}`);
    const after = await waitFor("payTo credited", async () => { const a = await usdgOf(payTo); return a > before ? a : false; }, 120_000);
    let hash: Hex | null = null;
    try { hash = JSON.parse(Buffer.from(paid.headers.get("x-payment-response") ?? "", "base64").toString()).transaction ?? null; } catch { /* header format */ }
    if (hash) { const r = await pub.getTransactionReceipt({ hash }); f.txs.push({ flow: f.id, label: "permit2 settle (x402 settler)", hash, gas: r.gasUsed.toString(), status: r.status, at: Date.now(), from: "x402-settler" }); }
    return `402 then 200; treasury +${fmt(after - before)} tUSDG; settlement ${hash ? txLink(hash) : "(hash not in header)"}`;
  });
  if (x402Api) { x402Api.kill("SIGTERM"); x402Api = undefined; }

  // ---------------------------------------------------------------- one-tap user operations (testnet bundler on this Mac)
  const ownerAcct = accountOf("alice");
  await flow("userop", "One-tap buy as an ERC-4337 user operation", "?format=userop builds a Kernel v3.3 op (approve + buy batched); alice signs; /v1/userop/send -> this Mac's bundler -> EntryPoint v0.7; the smart account holds the option tokens", async (f) => {
    const sa = (await api(`/v1/accounts/${ownerAcct.address}/smart-account`)).json;
    const smart = getAddress(sa.address ?? sa.smartAccount ?? sa.account);
    // Unsponsored (sponsor:false, as on the fork): the account pays its own gas, so it gets a little ETH and tUSDG first.
    if ((await usdgOf(smart)) < USD(500)) await f.send("tUSDG mint to the smart account", "deployer", { to: C.usdg, data: encodeFunctionData({ abi: erc20Abi, functionName: "mint", args: [smart, USD(1000)] }) });
    const built = await api("/v1/intent/buy?format=userop", { series: atmDaily.id, units: "5", account: smart, owner: ownerAcct.address, slippageBps: 100, sponsor: false });
    assert(built.status === 200, `userop build ${built.status}: ${JSON.stringify(built.json).slice(0, 300)}`);
    // The EntryPoint takes the whole prefund (every gas limit x maxFeePerGas) up front and refunds the unused part (AA21
    // otherwise): the account gets that much ETH plus 20 %.
    const uo = built.json.userOp;
    const prefund = (["verificationGasLimit", "callGasLimit", "preVerificationGas", "paymasterVerificationGasLimit", "paymasterPostOpGasLimit"]
      .reduce((a, k) => a + BigInt(uo[k] ?? 0), 0n) * BigInt(uo.maxFeePerGas) * 12n) / 10n;
    const bal = await pub.getBalance({ address: smart });
    if (bal < prefund) await f.send("eth prefund to the smart account", "alice", { to: smart, data: "0x", value: prefund - bal });
    const sent = await api("/v1/userop/send", { userOp: { ...built.json.userOp, signature: await ownerAcct.signMessage({ message: { raw: built.json.userOpHash as Hex } }) } });
    assert(sent.status === 200, `userop send ${sent.status}: ${JSON.stringify(sent.json).slice(0, 300)}`);
    const receipt = await waitFor("userop included", async () => { const r = (await api(`/v1/userop/${sent.json.userOpHash}`)).json; return r.status === "included" || r.status === "reverted" ? r : false; }, 120_000);
    assert(receipt.status === "included", `userop ${receipt.status}`);
    const txHash = receipt.transactionHash ?? receipt.receipt?.transactionHash;
    if (txHash) { const r = await pub.getTransactionReceipt({ hash: txHash }); f.txs.push({ flow: f.id, label: "entryPoint.handleOps (one-tap buy)", hash: txHash, gas: r.gasUsed.toString(), status: r.status, at: Date.now(), from: "bundler" }); }
    const held = await tokenBalance(atmDaily.token, smart);
    assert(held > 0n, "smart account holds no option tokens");
    return `smart account ${smart}; tokens ${fmt(held, 18)}`;
  });
  await flow("userop", "One-tap sell with a valid laneProof", "the owner signs the sell-lane message; the API's verifier accepts it and refuses a stranger and a 16-minute expiry; the lane-0 sell op is included; tokens burned, tUSDG to the smart account", async (f) => {
    const sa = (await api(`/v1/accounts/${ownerAcct.address}/smart-account`)).json;
    const smart = getAddress(sa.address ?? sa.smartAccount ?? sa.account);
    const units = await waitFor("smart account position indexed", async () => { const u = await positionUnits(smart, atmDaily.id); return u > 0 ? u : false; }, 180_000);
    const ucfg = (await api("/v1/userop/config")).json;
    const nowS = Math.floor(Date.now() / 1000);
    const expires = nowS + 600;
    const chainId = Number(ucfg.chainId);
    const signature = await ownerAcct.signMessage({ message: sellLaneProofMessage(smart, chainId, expires) });
    const deployment = { factory: getAddress(ucfg.kernelFactory), validator: getAddress(ucfg.kernelValidator), implementation: KERNEL_V33_IMPLEMENTATION as Address };
    const check = (proof: { expires: number; signature: Hex }) => verifySellLaneProof({ proof, account: smart, accountIndex: 0, chainId, deployment, nowSeconds: nowS });
    assert(await check({ expires, signature }), "the API's verifier refused the owner's proof");
    assert(!(await check({ expires, signature: await accountOf("bob").signMessage({ message: sellLaneProofMessage(smart, chainId, expires) }) })), "a stranger's proof was accepted");
    const longExpiry = nowS + SELL_LANE_PROOF_MAX_SECONDS + 60;
    assert(!(await check({ expires: longExpiry, signature: await ownerAcct.signMessage({ message: sellLaneProofMessage(smart, chainId, longExpiry) }) })), "a proof past 15 minutes was accepted");
    const tokensBefore = await tokenBalance(atmDaily.token, smart);
    const usdgBefore = await usdgOf(smart);
    const built = await api("/v1/intent/sell?format=userop", { series: atmDaily.id, units: (units / 2).toFixed(6), account: smart, owner: ownerAcct.address, slippageBps: 200, sponsor: false, laneProof: { expires, signature } });
    assert(built.status === 200, `userop sell build ${built.status}: ${JSON.stringify(built.json).slice(0, 300)}`);
    assert(BigInt(built.json.userOp.nonce) >> 64n === 0n, "op is not on nonce lane 0");
    const so = built.json.userOp;
    const prefund = (["verificationGasLimit", "callGasLimit", "preVerificationGas", "paymasterVerificationGasLimit", "paymasterPostOpGasLimit"]
      .reduce((a, k) => a + BigInt(so[k] ?? 0), 0n) * BigInt(so.maxFeePerGas) * 12n) / 10n;
    const bal = await pub.getBalance({ address: smart });
    if (bal < prefund) await f.send("eth prefund to the smart account", "alice", { to: smart, data: "0x", value: prefund - bal });
    const sent = await api("/v1/userop/send", { userOp: { ...built.json.userOp, signature: await ownerAcct.signMessage({ message: { raw: built.json.userOpHash as Hex } }) } });
    assert(sent.status === 200, `userop send ${sent.status}: ${JSON.stringify(sent.json).slice(0, 300)}`);
    const receipt = await waitFor("userop included", async () => { const r = (await api(`/v1/userop/${sent.json.userOpHash}`)).json; return r.status === "included" || r.status === "reverted" ? r : false; }, 120_000);
    assert(receipt.status === "included", `userop ${receipt.status}`);
    const txHash = receipt.transactionHash ?? receipt.receipt?.transactionHash;
    if (txHash) { const r = await pub.getTransactionReceipt({ hash: txHash }); f.txs.push({ flow: f.id, label: "entryPoint.handleOps (one-tap sell, laneProof)", hash: txHash, gas: r.gasUsed.toString(), status: r.status, at: Date.now(), from: "bundler" }); }
    const tokensAfter = await tokenBalance(atmDaily.token, smart);
    const got = (await usdgOf(smart)) - usdgBefore;
    assert(tokensAfter < tokensBefore && got > 0n, "sell did not settle");
    return `proof checks pass (owner yes, stranger no, 16 min no); lane-0 op included; tokens ${fmt(tokensBefore, 18)} -> ${fmt(tokensAfter, 18)}; +${fmt(got)} tUSDG`;
  });

  // ---------------------------------------------------------------- rules
  const ruleRow = byDist(nvda.rows.filter((r) => r.speed === "WEEKLY" && r.isCall), nvda.spot)[0]!;
  await flow("rules", "Buys are priced at the worse of the feed and the 5-minute trade TWAP (F01/F02)", "a call buy records a hold whose S is max(feed S, PriceGuard.tradeTwap) and ends 30 min after the buy", async (f) => {
    const feed = (await priceReading("NVDA")).s;
    const twap = await pub.readContract({ address: C.priceGuard, abi: PriceGuardAbi, functionName: "tradeTwap", args: [stockOf("NVDA")] }) as bigint;
    const [, holdSeconds] = await engineRead<readonly [bigint, number, number]>("guards");
    const { receipt } = await viaIntent(f, "buy", "bob", { series: ruleRow.id, units: "2", slippageBps: 300 });
    const at = BigInt((await pub.getBlock({ blockNumber: receipt.blockNumber })).timestamp);
    const h = await engineRead<{ until: bigint; s: bigint }>("holdOf", [ruleRow.id, addressOf("bob")]);
    const worse = twap > feed ? twap : feed;
    assert(h.s >= feed, `hold S ${h.s} below the feed ${feed}`);
    assert(twap === 0n || (h.s * 10_000n >= worse * 9_990n && h.s * 10_000n <= worse * 10_010n), `hold S ${h.s} is not max(feed ${feed}, twap ${twap})`);
    assert(h.until === at + BigInt(holdSeconds), `hold until ${h.until}, expected ${at} + ${holdSeconds}`);
    return `feed ${fmt(feed, 18)}, trade TWAP ${fmt(twap, 18)}, priced at ${fmt(h.s, 18)}; hold ${holdSeconds} s`;
  });
  await flow("rules", "A sell inside the 30-minute hold prices at the buy S (F01/F02)", "the NVDA mock feed is pushed 2% up by its owner: bob (bought minutes ago) is quoted below carol (no hold); the API sell intent shows the hold; the feed is put back", async (f) => {
    const [, answer] = await pub.readContract({ address: feedOf("NVDA"), abi: testnetFeedAbi, functionName: "latestRoundData" });
    try {
      await f.send("nvdaFeed.push(+2%) [mock owner]", "deployer", { to: feedOf("NVDA"), data: encodeFunctionData({ abi: testnetFeedAbi, functionName: "push", args: [(answer * 102n) / 100n] }) });
      const qb = await engineRead<{ usdg: bigint }>("quoteFor", [ruleRow.id, WAD, false, addressOf("bob")]);
      const qc = await engineRead<{ usdg: bigint }>("quoteFor", [ruleRow.id, WAD, false, addressOf("carol")]);
      assert(qb.usdg < qc.usdg, `held sell ${qb.usdg} not below ${qc.usdg}`);
      const intent = await waitFor("hold in the API sell intent", async () => {
        const { status, json } = await api("/v1/intent/sell", { account: addressOf("bob"), series: ruleRow.id, units: "1", slippageBps: 300 });
        return status === 200 && json.hold ? json : false;
      }, 120_000, 3000);
      return `inside the hold bob ${fmt(qb.usdg)} vs carol ${fmt(qc.usdg)} tUSDG per unit; API hold ${JSON.stringify(intent.hold)} (the 31-minute tail is a fork-run check)`;
    } finally {
      await f.send("nvdaFeed.push(restore) [mock owner]", "deployer", { to: feedOf("NVDA"), data: encodeFunctionData({ abi: testnetFeedAbi, functionName: "push", args: [answer] }) }).catch(() => undefined);
    }
  });
  await flow("rules", "Minimum trade $1 (expected failures)", "a buy under $1 reverts BelowMinimum; a sold part under $1 reverts BelowMinimum; a sell leaving a sub-minimum remainder sells the whole balance", async (f) => {
    const deadline = BigInt(await chainTime()) + 600n;
    await f.send("usdg.approve(engine)", "carol", { to: C.usdg, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [C.engine, 10n ** 12n] }) });
    const tiny = await f.expectRevert("engine.buy (under $1)", "carol", { to: C.engine, data: encodeFunctionData({ abi: OptionEngineAbi, functionName: "buy", args: [ruleRow.id, WAD / 1000n, 10n ** 9n, deadline, addressOf("carol")] }) }, "BelowMinimum");
    const q2 = await engineRead<{ usdg: bigint }>("quote", [ruleRow.id, 2n * WAD, true]);
    await f.send("engine.buy (2 units)", "carol", { to: C.engine, data: encodeFunctionData({ abi: OptionEngineAbi, functionName: "buy", args: [ruleRow.id, 2n * WAD, (q2.usdg * 103n) / 100n, deadline, addressOf("carol")] }) });
    // A load-balanced public RPC can answer a read from a node one block behind the receipt (real testnet 2026-10-28: the
    // balance read 0 right after the buy, so the "part" was 0 tokens and the whole-balance sell was 0 tokens too).
    const held = await waitFor("carol's 2-unit buy visible to reads", async () => { const b = await tokenBalance(ruleRow.token, addressOf("carol")); return b >= 2n * WAD ? b : false; }, 60_000, 1000);
    const part = await f.expectRevert("engine.sell (part under $1)", "carol", { to: C.engine, data: encodeFunctionData({ abi: OptionEngineAbi, functionName: "sell", args: [ruleRow.id, held / 100_000n, 0n, deadline, addressOf("carol")] }) }, "BelowMinimum");
    await f.send("engine.sell (leaves dust -> whole balance)", "carol", { to: C.engine, data: encodeFunctionData({ abi: OptionEngineAbi, functionName: "sell", args: [ruleRow.id, held - held / 100_000n, 0n, deadline, addressOf("carol")] }) });
    assert((await tokenBalance(ruleRow.token, addressOf("carol"))) === 0n, "a sub-minimum remainder was left");
    return `${tiny}; ${part}; a sell leaving dust sold the whole balance`;
  });

  // ---------------------------------------------------------------- admin through the Safe
  await flow("admin", "The owner Safe pauses and unpauses one series", "setSeriesBuysPaused(true) through the 2-of-3 Safe: buys revert; setSeriesBuysPaused(false): buys work again; the guardian cannot unpause", async (f) => {
    const row = byDist(nvda.rows.filter((r) => r.speed === "WEEKLY" && !r.isCall), nvda.spot)[0]!;
    await f.admin("engine.setSeriesBuysPaused(true)", C.engine, encodeFunctionData({ abi: OptionEngineAbi, functionName: "setSeriesBuysPaused", args: [row.id, true] }));
    const deadline = BigInt(await chainTime()) + 300n;
    const allowance = await pub.readContract({ address: C.usdg, abi: erc20Abi, functionName: "allowance", args: [addressOf("bob"), C.engine] });
    if (allowance < USD(5000)) await f.send("usdg.approve", "bob", { to: C.usdg, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [C.engine, USD(1_000_000)] }) });
    const reason = await f.expectRevert("engine.buy (series paused)", "bob", { to: C.engine, data: encodeFunctionData({ abi: OptionEngineAbi, functionName: "buy", args: [row.id, WAD, USD(5000), deadline, addressOf("bob")] }) }, /Paused|paused/);
    const g = await f.expectRevert("engine.setSeriesBuysPaused(false) by the guardian", "guardian", { to: C.engine, data: encodeFunctionData({ abi: OptionEngineAbi, functionName: "setSeriesBuysPaused", args: [row.id, false] }) }, /AccessControl|NotGuardian|Unauthorized|revert/);
    await f.admin("engine.setSeriesBuysPaused(false)", C.engine, encodeFunctionData({ abi: OptionEngineAbi, functionName: "setSeriesBuysPaused", args: [row.id, false] }));
    await f.send("engine.buy", "bob", { to: C.engine, data: encodeFunctionData({ abi: OptionEngineAbi, functionName: "buy", args: [row.id, WAD, USD(5000), BigInt(await chainTime()) + 300n, addressOf("bob")] }) });
    return `paused: ${reason}; guardian: ${g}; unpaused by the Safe and a buy went through`;
  });

  // ---------------------------------------------------------------- split fixture (10 min lead / 5 min tail)
  await flow("sessions", "Split fixture: multiplier x4, buys pause around it, S continuous", "the test SPY's owner stages a 4x multiplier 11 minutes out: PriceGuard pauses SPY buys (SPLIT) from 10 min before to 5 min after; afterwards uiMultiplier is 4x, S unchanged, buys resume", async (f) => {
    const spy = stockOf("SPY");
    const m0 = await pub.readContract({ address: spy, abi: testnetStockAbi, functionName: "uiMultiplier" });
    const s0 = (await priceReading("SPY")).s;
    const effectiveAt = BigInt(await chainTime()) + 11n * 60n;
    await f.send("testSPY.scheduleMultiplier(x4) [mock owner]", "deployer", { to: spy, data: encodeFunctionData({ abi: testnetStockAbi, functionName: "scheduleMultiplier", args: [m0 * 4n, effectiveAt] }) });
    await untilChainTime(Number(effectiveAt) - 9 * 60, "inside the 10-minute split lead");
    const during = await priceReading("SPY");
    const row = (await chainOf("SPY")).rows.find((r) => r.speed === "WEEKLY" && r.isCall)!;
    const allowance = await pub.readContract({ address: C.usdg, abi: erc20Abi, functionName: "allowance", args: [addressOf("bob"), C.engine] });
    if (allowance < USD(5000)) await f.send("usdg.approve", "bob", { to: C.usdg, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [C.engine, USD(1_000_000)] }) });
    const reason = await f.expectRevert("engine.buy (inside the split pause)", "bob", { to: C.engine, data: encodeFunctionData({ abi: OptionEngineAbi, functionName: "buy", args: [row.id, WAD, USD(5000), BigInt(await chainTime()) + 300n, addressOf("bob")] }) }, /"SPLIT"|"PRICE"/);
    await untilChainTime(Number(effectiveAt) + 5 * 60 + 30, "the 5-minute split tail");
    await f.send("priceGuard.poke(SPY)", "carol", { to: C.priceGuard, data: encodeFunctionData({ abi: PriceGuardAbi, functionName: "poke", args: [spy] }) }).catch(() => undefined);
    const m1 = await pub.readContract({ address: spy, abi: testnetStockAbi, functionName: "uiMultiplier" });
    const after = await priceReading("SPY");
    assert(during.buysPaused, "buys were not paused before the split");
    assert(m1 === m0 * 4n, "multiplier did not switch");
    assert(after.s === s0 || (await pub.readContract({ address: feedOf("SPY"), abi: testnetFeedAbi, functionName: "latestRoundData" }))[2] > BigInt(effectiveAt), `S moved ${s0} -> ${after.s} with no new feed round`);
    const lifted = await liftPauses(f, "SPY");
    await f.send("engine.buy", "bob", { to: C.engine, data: encodeFunctionData({ abi: OptionEngineAbi, functionName: "buy", args: [row.id, WAD, USD(5000), BigInt(await chainTime()) + 300n, addressOf("bob")] }) });
    return `during: paused=${during.buysPaused} (${reason}); after: uiMultiplier ${fmt(m0, 18)} -> ${fmt(m1, 18)}, S ${fmt(s0, 18)} -> ${fmt(after.s, 18)}; ${lifted} risk pause(s) lifted by the Safe; buy works`;
  });

  // ---------------------------------------------------------------- vol stale (up to the 30-minute validity)
  await flow("sessions", "Vol post stale: buys pause, sells price at sigma x 0.8", "with the vol-engine stopped and validUntil passed: buy reverts StaleVol; the sell quote uses sigma x 0.80; after the vol-engine restarts buys work again", async (f) => {
    await stopService("vol-engine");
    const r = await volRead("QQQ", 0);
    await untilChainTime(Number(r.validUntil) + 30, "the QQQ vol post to expire (up to 30 min)");
    const row = byDist((await chainOf("QQQ")).rows.filter((x) => x.speed === "DAILY" && x.isCall), (await chainOf("QQQ")).spot)[0]!;
    const allowance = await pub.readContract({ address: C.usdg, abi: erc20Abi, functionName: "allowance", args: [addressOf("bob"), C.engine] });
    if (allowance < USD(5000)) await f.send("usdg.approve", "bob", { to: C.usdg, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [C.engine, USD(1_000_000)] }) });
    const reason = await f.expectRevert("engine.buy (vol stale)", "bob", { to: C.engine, data: encodeFunctionData({ abi: OptionEngineAbi, functionName: "buy", args: [row.id, WAD, USD(5000), BigInt(await chainTime()) + 300n, addressOf("bob")] }) }, /StaleVol|"VOL"|Paused/);
    const q = await engineRead<{ sigmaBps: bigint }>("quote", [row.id, WAD, false]);
    const ratio = Number(q.sigmaBps) / Number(r.sigmaBps);
    await startServices();
    await waitVolFresh(["QQQ"]);
    const lifted = await liftPauses(f);
    await f.send("engine.buy", "bob", { to: C.engine, data: encodeFunctionData({ abi: OptionEngineAbi, functionName: "buy", args: [row.id, WAD, USD(5000), BigInt(await chainTime()) + 300n, addressOf("bob")] }) });
    assert(ratio < 0.85 && ratio > 0.6, `sell sigma ratio ${ratio}`);
    return `${reason}; sell sigma ${q.sigmaBps} vs posted ${r.sigmaBps} (x${ratio.toFixed(3)}); ${lifted} risk pause(s) lifted by the Safe; buy works after the restart`;
  });

  // ---------------------------------------------------------------- keeper health over the run
  await flow("keeper", "The keeper read the engine's live list on every run of this exercise", "no \"Engine live list unreadable\" line and no job failure loop in the keeper log since the exercise started", async () => {
    const log = readFileSync(join(TESTNET_DIR, "logs", "keeper.log")).subarray(keeperLogStart).toString("utf8");
    const unreadable = log.split("\n").filter((l) => l.includes("Engine live list unreadable")).length;
    const errors = log.split("\n").filter((l) => /"level":50/.test(l)).length;
    const txs = log.split("\n").filter((l) => l.includes("Keeper transaction submitted")).length;
    assert(unreadable === 0, `${unreadable} unreadable-live-list lines`);
    return `0 unreadable-live-list lines; ${errors} error lines; ${txs} keeper transactions`;
  });

  // ---------------------------------------------------------------- what only the fork can prove (no clock to move here)
  forkOnly("sessions", "Hedge equity stale: buys pause", "HEDGE_STALE_AFTER is a 2 h contract constant and the testnet has no perp venue or hedger; fork run r3 sessions.2 PASS");
  forkOnly("sessions", "HALTED via a stale feed: sells queue, then fill", "needs a feed older than maxAge (26 h); fork run r3 sessions.4 PASS");
  forkOnly("sessions", "Weekend: buys blocked, sells at last close with the wider spread", "needs a Saturday; re-run this exercise's sell flows on a weekend to see it live; fork run r3 sessions.5 PASS");
  forkOnly("rules", "settleHalted after 7 days", "the settle delay is 7 days (contract minimum 1 day); fork run r3 rules.4 PASS");
  forkOnly("sessions", "Earnings window blocks buys", "needs the vol signer to sign a manual post while its service is stopped; shown by the buy flows when a name is inside a real report window; fork run r3 sessions.3 PASS");

  await sql.end({ timeout: 5 });
}

if (import.meta.main) {
  if (process.argv.includes("--report")) {
    const { flows: f, notes: n } = JSON.parse(readFileSync(join(OUT, "results.json"), "utf8")) as { flows: FlowRec[]; notes: string[] };
    console.log(`report: ${writeReport(f, n)}`);
    process.exit(0);
  }
  let code = 0;
  try { await main(); } catch (e) { console.error(`exercise aborted: ${(e as Error).stack ?? e}`); code = 1; }
  const out = writeReport(flows, notes);
  const failed = flows.filter((f) => f.status === "fail").length;
  console.log(`exercise: ${flows.filter((f) => f.status === "pass").length} pass, ${failed} fail, ${flows.filter((f) => f.status === "skip").length} fork-only; report ${out}`);
  process.exit(code || (failed ? 1 : 0));
}
