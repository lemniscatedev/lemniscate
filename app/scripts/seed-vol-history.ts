// Builds the vol-engine's history seed files from free public data and writes them under app/config (no secrets):
//   config/vol-weekend.json  { "NVDA": [0.012, ...] }   26 weeks of absolute Friday close -> Monday open moves   (VOL_WEEKEND_FILE)
//   config/vol-moves.json    { "NVDA": [0.051, -0.07] } the 1-day move after each of the last 8 earnings reports   (VOL_MOVES_FILE)
//
// Sources (no key, no account):
//   daily bars      Yahoo Finance chart endpoint, 3 years of daily open/close (query1.finance.yahoo.com/v8/finance/chart)
//   earnings dates  SEC EDGAR submissions (data.sec.gov): the filing time of each 8-K with Item 2.02 is the release time;
//                   after 16:00 New York time the reaction is the next session, otherwise the same session
//   ETFs (SPY, QQQ) have no earnings: they get a weekend series only.
// Run:  bun run seed-vol-history            (writes the files)
//       bun run seed-vol-history --check    (fetches, prints, writes nothing)
// Then: VOL_WEEKEND_FILE=<app>/config/vol-weekend.json VOL_MOVES_FILE=<app>/config/vol-moves.json vol-engine post ...
// Yahoo's endpoint is unofficial; if it changes, the script fails loudly and keeps the old files.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { NO_EARNINGS } from "../src/config/earnings";
import { STRIKE_STEP_USD } from "../src/config/listing";
import { earningsMoves, parseEdgarReports, parseYahooBars, weekendGaps } from "../src/seed/vol-history";

// SEC central index keys of the single-name launch stocks.
const CIK: Record<string, string> = { NVDA: "0001045810", TSLA: "0001318605", AAPL: "0000320193" };
const SEC_AGENT = process.env.SEC_USER_AGENT?.trim() || "lemniscate-vol-seed (set SEC_USER_AGENT to your contact address)";
const check = process.argv.includes("--check");
const outDir = resolve(import.meta.dir, "../config");

async function getJson(url: string, headers: Record<string, string>): Promise<unknown> {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`${new URL(url).host} returned HTTP ${response.status}`);
  return response.json();
}

const weekend: Record<string, number[]> = {};
const moves: Record<string, number[]> = {};
for (const name of Object.keys(STRIKE_STEP_USD)) {
  const bars = parseYahooBars(await getJson(
    `https://query1.finance.yahoo.com/v8/finance/chart/${name}?range=3y&interval=1d`, { "User-Agent": "Mozilla/5.0" }));
  weekend[name] = weekendGaps(bars, 26);
  if (NO_EARNINGS.has(name)) continue;
  const cik = CIK[name];
  if (!cik) throw new Error(`No SEC CIK configured for ${name}`);
  const reports = parseEdgarReports(await getJson(`https://data.sec.gov/submissions/CIK${cik}.json`, { "User-Agent": SEC_AGENT }));
  moves[name] = earningsMoves(bars, reports, 8);
  console.log(`${name}: ${weekend[name]!.length} weekend gaps, ${moves[name]!.length} earnings moves (${reports.length} reports found)`);
  if (moves[name]!.length < 8) console.warn(`${name}: fewer than 8 earnings moves; the engine fills the rest with its default`);
}
if (check) {
  console.log(JSON.stringify({ weekend, moves }, null, 2));
} else {
  mkdirSync(outDir, { recursive: true });
  writeFileSync(resolve(outDir, "vol-weekend.json"), `${JSON.stringify(weekend, null, 2)}\n`);
  writeFileSync(resolve(outDir, "vol-moves.json"), `${JSON.stringify(moves, null, 2)}\n`);
  console.log(`wrote ${dirname(resolve(outDir, "x"))}/vol-weekend.json and vol-moves.json`);
}
