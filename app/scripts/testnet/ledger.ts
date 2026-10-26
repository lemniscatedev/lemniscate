// Gas ledger for the testnet run: what the deploy, the funding transfers, the exercise and the bots cost, plus 50 %,
// and how much ETH the ONE faucet wallet (the deployer) needs. Measured, not guessed: every figure comes from receipts of
// the dry run (a local fork of the testnet with the testnet's fees), priced at the testnet's gas price. The testnet's L1
// data part is zero (NodeInterface.gasEstimateComponents answers gasEstimateForL1 = 0 and l1BaseFeeEstimate = 0 on 46630,
// chain-facts 2026-10-26); the ledger still asks the node for it and adds it per transaction if that ever changes.
//
//   bun scripts/testnet/ledger.ts --actual [--days 1]     measure the dry run in TESTNET_DIR, write LEDGER_FILE, print it
//   (days = how long the bots run on the faucet money; each extra day costs about one more 0.01 ETH faucet request)
//
// Writes ~/.lemniscate/testnet-ledger.json (LEDGER_FILE): { faucet: { address, eth }, funding: { role: eth }, rows, ... }.
// fund.ts reads `funding`; dry-run.sh gives the deployer exactly `faucet.eth`.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { formatEther, getAddress, type Hex } from "viem";
import { addressOf, ROLES, TESTNET_DIR, publicClient, type TestnetRole } from "./lib";
import { LEDGER_FILE } from "./fund";
import type { FlowRec } from "./exercise";

/** The testnet's gas price (base fee floor; priority fees are not charged on Orbit), wei. */
export const TESTNET_GAS_PRICE = 10_000_000n;
export const MARGIN_BPS = 5_000n; // +50 %

export const withMargin = (wei: bigint, bps = MARGIN_BPS) => (wei * (10_000n + bps) + 9_999n) / 10_000n;
/** Rounds wei up to a figure Kal can type into nothing (the faucet gives fixed drips): 4 significant decimals of ETH. */
export function roundUpEth(wei: bigint, step = 10n ** 14n): bigint {
  return ((wei + step - 1n) / step) * step;
}

interface Measured { role: string; txs: number; gas: bigint }

function deployGas(): { txs: number; gas: bigint } {
  const run = JSON.parse(readFileSync(join(TESTNET_DIR, "broadcast-deploy", "run-latest.json"), "utf8")) as { receipts: { gasUsed: string }[] };
  let gas = run.receipts.reduce((a, r) => a + BigInt(r.gasUsed), 0n);
  let txs = run.receipts.length;
  const safe = join(TESTNET_DIR, "logs", "owner-safe.json");
  if (existsSync(safe)) { gas += BigInt(JSON.parse(readFileSync(safe, "utf8")).gasUsed); txs++; }
  const upd = join(TESTNET_DIR, "logs", "feed-updater.jsonl");
  if (existsSync(upd)) for (const l of readFileSync(upd, "utf8").split("\n").filter(Boolean)) { gas += BigInt(JSON.parse(l).gasUsed); txs++; }
  return { txs, gas };
}

/** Every transaction a wallet SENT between two blocks (receipts summed), by scanning the blocks of the dry-run fork. */
async function sentBy(from: Set<string>, fromBlock: bigint, toBlock: bigint): Promise<Map<string, Measured>> {
  const pub = publicClient();
  const out = new Map<string, Measured>();
  for (let n = fromBlock; n <= toBlock; n++) {
    const block = await pub.getBlock({ blockNumber: n, includeTransactions: true });
    for (const tx of block.transactions) {
      const who = tx.from.toLowerCase();
      if (!from.has(who)) continue;
      const r = await pub.getTransactionReceipt({ hash: tx.hash as Hex });
      const m = out.get(who) ?? { role: who, txs: 0, gas: 0n };
      m.txs++;
      m.gas += r.gasUsed;
      out.set(who, m);
    }
  }
  return out;
}

async function main() {
  const di = process.argv.indexOf("--days");
  const days = di >= 0 ? Number(process.argv[di + 1]) || 1 : 1;
  const pub = publicClient();
  const deploy = deployGas();
  const results = JSON.parse(readFileSync(join(TESTNET_DIR, "exercise", "results.json"), "utf8")) as { flows: FlowRec[] };
  const exTxs = results.flows.flatMap((f) => f.txs).filter((t) => t.hash && t.gas);
  // Exercise gas per sending role (the report's `from`), and the run's wall-clock window for the bots' rates.
  const exByRole = new Map<string, bigint>();
  for (const t of exTxs) exByRole.set(t.from ?? "?", (exByRole.get(t.from ?? "?") ?? 0n) + BigInt(t.gas!));
  // ETH a role SENDS during the exercise (a smart account's user-operation prefund, top-ups), on top of its gas.
  const valueByRole = new Map<string, bigint>();
  for (const t of exTxs) if (t.value) valueByRole.set(t.from ?? "?", (valueByRole.get(t.from ?? "?") ?? 0n) + BigInt(t.value));
  const exGas = [...exByRole.values()].reduce((a, b) => a + b, 0n);
  const startBlock = BigInt(JSON.parse(readFileSync(join(TESTNET_DIR, "deployment.json"), "utf8")).deployBlock);
  const head = await pub.getBlockNumber();
  const t0 = Number((await pub.getBlock({ blockNumber: startBlock })).timestamp);
  const t1 = Number((await pub.getBlock({ blockNumber: head })).timestamp);
  const hours = Math.max(1 / 60, (t1 - t0) / 3600);
  const bots: TestnetRole[] = ["keeper", "vol-signer", "feed-mirror", "bundler", "x402-settler"];
  const addr = new Map(ROLES.map((r) => [addressOf(r).toLowerCase(), r]));
  const sent = await sentBy(new Set(bots.map((r) => addressOf(r).toLowerCase())), startBlock, head);
  // Bot gas per day: what each bot sent over the dry run, scaled to 24 h. The keeper's once-a-day work (the lister's grid,
  // the calendar push) happened once in the window, so it is counted once a day, not scaled by the window.
  // Keeper: split its transactions by job (its log names each one). Once-a-day jobs (sessions, lister) count once a day;
  // the rest (accrual grid, risk, queued sells, fees, kernel-register...) scale from the window to 24 h.
  const keeperJobs = new Map<string, bigint>();
  {
    const log = join(TESTNET_DIR, "logs", "keeper.log");
    const seen = new Set<string>();
    for (const line of existsSync(log) ? readFileSync(log, "utf8").split("\n") : []) {
      if (!line.includes("Keeper transaction submitted")) continue;
      const j = JSON.parse(line) as { label?: string; hash?: Hex };
      if (!j.hash || seen.has(j.hash)) continue;
      seen.add(j.hash);
      const r = await pub.getTransactionReceipt({ hash: j.hash }).catch(() => null);
      if (!r) continue;
      const job = (j.label ?? "?").split(":")[0]!;
      keeperJobs.set(job, (keeperJobs.get(job) ?? 0n) + r.gasUsed);
    }
  }
  const DAILY_JOBS = new Set(["sessions", "lister"]);
  const keeperDaily = [...keeperJobs].filter(([j]) => DAILY_JOBS.has(j)).reduce((a, [, g]) => a + g, 0n);
  const keeperPeriodic = [...keeperJobs].filter(([j]) => !DAILY_JOBS.has(j)).reduce((a, [, g]) => a + g, 0n);
  const rows: { role: string; why: string; gasPerDay: bigint; exercise: bigint }[] = [];
  for (const r of bots) {
    const m = sent.get(addressOf(r).toLowerCase());
    const windowGas = m?.gas ?? 0n;
    const exercise = exByRole.get(r) ?? 0n; // handleOps / settlements made for the exercise
    const own = windowGas > exercise ? windowGas - exercise : 0n;
    const perDay = r === "keeper"
      ? keeperDaily + BigInt(Math.ceil(Number(keeperPeriodic) * (24 / hours)))
      : BigInt(Math.ceil(Number(own) * (24 / hours)));
    const why = r === "keeper"
      ? `${m?.txs ?? 0} txs in ${hours.toFixed(2)} h; daily jobs ${keeperDaily.toLocaleString("en-US")} gas once a day, the rest x 24/${hours.toFixed(2)} h (${[...keeperJobs].map(([j, g]) => `${j} ${g}`).join(", ")})`
      : `${m?.txs ?? 0} txs in ${hours.toFixed(2)} h of dry run, x 24/${hours.toFixed(2)}`;
    rows.push({ role: r, why, gasPerDay: perDay, exercise });
  }
  // Users and the Safe's submitting owner: what they sent in the exercise.
  const users: TestnetRole[] = ["owner-1", "guardian", "agent", "depositor", "alice", "bob", "carol", "agent-owner", "lp2", "payer"];
  const funding: Record<string, string> = {};
  const lines: { role: string; eth: bigint; basis: string }[] = [];
  for (const b of rows) {
    // Floor: 0.0001 ETH, so a bot the dry run did not see send (the relayer when no user operation ran) still can.
    const need = withMargin((b.gasPerDay * BigInt(days) + b.exercise) * TESTNET_GAS_PRICE);
    const eth = roundUpEth(need > 10n ** 14n ? need : 10n ** 14n);
    funding[b.role] = formatEther(eth);
    lines.push({ role: b.role, eth, basis: `${b.gasPerDay.toLocaleString("en-US")} gas/day x ${days} d + exercise ${b.exercise.toLocaleString("en-US")} gas, +50%` });
  }
  for (const u of users) {
    const g = exByRole.get(u) ?? 0n;
    const v = valueByRole.get(u) ?? 0n;
    const eth = roundUpEth(withMargin(g * TESTNET_GAS_PRICE + v) + 10n ** 13n); // + a 0.00001 ETH floor for a retry
    funding[u] = formatEther(eth);
    lines.push({ role: u, eth, basis: `exercise ${g.toLocaleString("en-US")} gas${v ? ` + ${formatEther(v)} ETH sent (user-operation prefund)` : ""}, +50%` });
  }
  const deployerOwnGas = deploy.gas + (exByRole.get("deployer") ?? 0n) + BigInt(Object.keys(funding).length + 40) * 60_000n; // transfers + mints
  const handedOut = lines.reduce((a, l) => a + l.eth, 0n);
  const deployerNeed = withMargin(deployerOwnGas * TESTNET_GAS_PRICE) + handedOut;
  const kal = 5n * 10n ** 14n; // 0.0005 ETH for Kal's MetaMask (fund.ts --kal)
  const faucet = roundUpEth(deployerNeed + kal, 10n ** 15n);
  const ledger = {
    measuredAt: new Date().toISOString(), network: "testnet 46630", gasPriceWei: TESTNET_GAS_PRICE.toString(), l1DataFee: "0 on 46630 (NodeInterface)",
    days, marginBps: Number(MARGIN_BPS), dryRunHours: Number(hours.toFixed(2)),
    deploy: { txs: deploy.txs, gas: deploy.gas.toString(), eth: formatEther(deploy.gas * TESTNET_GAS_PRICE) },
    exercise: { txs: exTxs.length, gas: exGas.toString(), eth: formatEther(exGas * TESTNET_GAS_PRICE) },
    bots: rows.map((r) => ({ role: r.role, gasPerDay: r.gasPerDay.toString(), why: r.why })),
    funding, fundingTotalEth: formatEther(handedOut), kalEth: formatEther(kal),
    faucet: { role: "deployer", address: getAddress(addressOf("deployer")), eth: formatEther(faucet) },
  };
  writeFileSync(LEDGER_FILE, JSON.stringify(ledger, null, 1));
  console.log(`ledger: deploy ${deploy.txs} txs ${deploy.gas.toLocaleString("en-US")} gas = ${ledger.deploy.eth} ETH; exercise ${exTxs.length} txs ${exGas.toLocaleString("en-US")} gas = ${ledger.exercise.eth} ETH`);
  for (const l of lines) console.log(`ledger: ${l.role.padEnd(13)} ${formatEther(l.eth).padEnd(10)} ETH  (${l.basis})`);
  console.log(`ledger: deployer hands out ${formatEther(handedOut)} ETH + Kal ${formatEther(kal)} + its own gas (+50%) -> FAUCET ${formatEther(faucet)} ETH to ${ledger.faucet.address}`);
  console.log(`ledger: written to ${LEDGER_FILE}`);
}

if (import.meta.main) {
  if (!process.argv.includes("--actual")) throw new Error("usage: bun scripts/testnet/ledger.ts --actual [--days 1]");
  await main();
}
