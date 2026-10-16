// 14-day replay simulation (todo 21). Usage:
//   bun run scripts/replay/run.ts --days 14 --seed 1 --fixture          synthetic prices, no network, no cache
//   bun run scripts/replay/run.ts --days 14 --seed 1 --start 2026-07-06  cached Chainlink rounds (fetch.ts first)
//   ... --sweep                    every 14-day window (stride 7 d) inside Jul to Sep 2026, worst window reported
//   ... --sensitivity              also run the R5 scenarios on the chosen window
//   ... --strict                   also gate the exit code on the adversary-only case
//   ... --json out.json            write the full results
// Exits 1 when the base run is insolvent or its 30-day drawdown exceeds 15%.
import { writeFile } from "node:fs/promises";
import { makeConfig, SENSITIVITY } from "../../src/sim/config";
import { DEFAULT_NAMES } from "../../src/sim/defaults";
import { fixturePrices, loadCached } from "../../src/sim/prices";
import { runSim } from "../../src/sim/run";
import { BASE_SCENARIO, type RunResult } from "../../src/sim/types";

const args = process.argv.slice(2);
const flag = (name: string): boolean => args.includes(`--${name}`);
const value = (name: string, fallback: string): string => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1]! : fallback;
};

const DAY = 86400;
const days = Number(value("days", "14"));
const seed = Number(value("seed", "1"));
const startSec = Date.parse(`${value("start", "2026-07-06")}T00:00:00Z`) / 1000;
const names = DEFAULT_NAMES.map((n) => n.name);

function line(r: RunResult): string {
  return `${r.scenario.padEnd(40)} ${r.startIso.slice(0, 10)}..${r.endIso.slice(0, 10)} insolvent=${r.insolvent ? "YES" : "no"} maxDD=${r.maxDrawdownPct.toFixed(2)}% maxDD30d=${r.maxDrawdown30dPct.toFixed(2)}% minNAV=$${r.minNavUsd.toFixed(0)} stress=${r.maxStressLossPctNav.toFixed(1)}% advBuys=${r.trades.adversaryBuys} hedgeTrades=${r.trades.hedgeTrades} paused=${Object.values(r.pausedBuys).reduce((a, b) => a + b, 0)}`;
}

async function main(): Promise<number> {
  const results: RunResult[] = [];
  let paths, notes: string[];
  if (flag("fixture")) {
    const loaded = fixturePrices(DEFAULT_NAMES, startSec - 15 * DAY, startSec + days * DAY, seed);
    paths = loaded.paths; notes = loaded.notes;
  } else {
    const loaded = await loadCached(names);
    paths = loaded.paths; notes = loaded.notes;
    if (paths.size === 0) { console.error("no cached prices: run scripts/replay/fetch.ts first, or pass --fixture"); return 2; }
  }
  for (const n of notes) console.log(`data: ${n}`);

  let windows = [startSec];
  if (flag("sweep") && !flag("fixture")) {
    const first = Math.max(...[...paths.values()].map((p) => p.firstT)) + 15 * DAY;
    const last = Date.parse("2026-10-01T00:00:00Z") / 1000;
    windows = [];
    for (let t = Math.ceil(first / DAY) * DAY; t + days * DAY <= last; t += 7 * DAY) windows.push(t);
  }
  // Each window runs the base flows (retail + adversary) and the adversary-only case, where the caps and the stress
  // budget are the only limit. The gate applies to both; the sensitivity table runs on the worst adversary-only window.
  const gated = [BASE_SCENARIO, SENSITIVITY.find((x) => x.label === "adversary only (no retail)")!];
  const worstOf = new Map<string, RunResult>();
  for (const w of windows) {
    for (const sc of gated) {
      const r = runSim(makeConfig(w, days, seed, sc), paths, notes);
      results.push(r);
      console.log(line(r));
      const prev = worstOf.get(sc.label);
      if (!prev || r.maxDrawdown30dPct > prev.maxDrawdown30dPct || (r.insolvent && !prev.insolvent)) worstOf.set(sc.label, r);
    }
  }
  const adv = worstOf.get("adversary only (no retail)")!;
  if (flag("sweep")) for (const [label, r] of worstOf) console.log(`worst window (${label}): ${r.startIso.slice(0, 10)} maxDD30d=${r.maxDrawdown30dPct.toFixed(2)}%`);
  if (flag("sensitivity")) {
    const w = Date.parse(adv.startIso) / 1000;
    for (const sc of SENSITIVITY.slice(1).filter((x) => x.label !== adv.scenario)) {
      const r = runSim(makeConfig(w, days, seed, sc), paths, notes);
      results.push(r);
      console.log(line(r));
    }
  }
  const jsonPath = value("json", "");
  if (jsonPath) await writeFile(jsonPath, JSON.stringify(results, null, 1));
  // Exit code: the base flows (R2: retail, LP flows, adversarial group sharing the pool) must pass. --strict also gates
  // the adversary-only case, which the report shows failing the 15% drawdown line on some windows.
  const failed = [...worstOf.values()].filter((r) => !r.pass && (flag("strict") || r.scenario === BASE_SCENARIO.label));
  if (failed.length) {
    for (const r of failed) console.error(`FAIL (${r.scenario}, ${r.startIso.slice(0, 10)}): ${r.failReasons.join("; ")}`);
    return 1;
  }
  const advFail = !adv.pass ? ` NOTE adversary-only: ${adv.failReasons.join("; ")} (use --strict to gate on it)` : "";
  console.log(`PASS: base flows, no insolvency, 30-day drawdown within 15%.${advFail}`);
  return 0;
}

process.exit(await main());
