// Writes the fork-run report (crypto-local-testing section 2) from $FORK_DIR/exercise/results.json:
// <out>.md and <out>.html with a table per area, every transaction (hash, gas, status, revert), every failure with its
// decoded reason, the gas table, the deploy summary and a Bugs found section (passed in as a JSON file).
//
//   bun scripts/fork/report.ts --out <dir>/fork-run-2026-10-16 [--bugs bugs.json] [--title "..."]
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FORK_DIR } from "./lib";
import type { FlowRec, TxRec } from "./exercise";

interface Bug { title: string; where: string; repro: string; fix: string; test: string; commit: string }

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const md = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");

export function gasTable(txs: TxRec[]): { label: string; n: number; min: number; avg: number; max: number }[] {
  const by = new Map<string, number[]>();
  for (const t of txs) {
    if (t.status !== "success" || !t.gas) continue;
    const key = t.label.replace(/\s*\(.*\)$/, "");
    by.set(key, [...(by.get(key) ?? []), Number(t.gas)]);
  }
  return [...by.entries()].map(([label, g]) => ({ label, n: g.length, min: Math.min(...g), avg: Math.round(g.reduce((a, b) => a + b, 0) / g.length), max: Math.max(...g) }))
    .sort((a, b) => b.avg - a.avg);
}

function deploySummary(): { txs: number; gas: number; contracts: string[] } | undefined {
  const file = join(FORK_DIR, "broadcast-deploy", "run-latest.json");
  if (!existsSync(file)) return undefined;
  const run = JSON.parse(readFileSync(file, "utf8")) as { transactions: { contractName?: string; transactionType: string }[]; receipts: { gasUsed: string }[] };
  return {
    txs: run.receipts.length,
    gas: run.receipts.reduce((a, r) => a + Number(BigInt(r.gasUsed)), 0),
    contracts: [...new Set(run.transactions.filter((t) => t.transactionType === "CREATE" && t.contractName).map((t) => t.contractName!))],
  };
}

if (import.meta.main) {
  const out = arg("out");
  if (!out) throw new Error("usage: bun scripts/fork/report.ts --out <path-without-extension> [--bugs bugs.json]");
  const { flows, notes } = JSON.parse(readFileSync(join(FORK_DIR, "exercise", "results.json"), "utf8")) as { flows: FlowRec[]; notes: string[] };
  const bugs: Bug[] = arg("bugs") ? JSON.parse(readFileSync(arg("bugs")!, "utf8")) : [];
  const extra = arg("extra") ? readFileSync(arg("extra")!, "utf8") : "";
  const title = arg("title") ?? "Lemniscate fork run";
  const passed = flows.filter((f) => f.status === "pass").length;
  const txs = flows.flatMap((f) => f.txs);
  const gas = gasTable(txs);
  const deploy = deploySummary();
  const areas = [...new Set(flows.map((f) => f.area))];

  const lines: string[] = [];
  lines.push(`# ${title}`, "");
  lines.push(`**${passed}/${flows.length} flows passed**, ${txs.filter((t) => t.hash).length} transactions (${txs.filter((t) => t.status === "reverted").length} expected-failure transactions mined as reverted), ${bugs.length} bugs found and fixed.`, "");
  for (const n of notes) lines.push(`- ${n}`);
  if (deploy) lines.push(`- Deploy (DeploySystem fork profile): ${deploy.txs} transactions, ${deploy.gas.toLocaleString("en-US")} gas; contracts: ${deploy.contracts.join(", ")}.`);
  lines.push("");
  if (extra) lines.push(extra.trim(), "");
  for (const area of areas) {
    lines.push(`## ${area}`, "", "| # | Flow | Expected | Actual | Result |", "|---|---|---|---|---|");
    for (const f of flows.filter((x) => x.area === area)) {
      lines.push(`| ${f.id} | ${md(f.name)} | ${md(f.expected)} | ${md(f.actual)} | ${f.status === "pass" ? "PASS" : `**FAIL**: ${md(f.error ?? "")}`} |`);
    }
    lines.push("");
  }
  lines.push("## Gas (successful transactions on the fork)", "", "| Call | n | min | avg | max |", "|---|---|---|---|---|");
  for (const g of gas) lines.push(`| ${md(g.label)} | ${g.n} | ${g.min.toLocaleString("en-US")} | ${g.avg.toLocaleString("en-US")} | ${g.max.toLocaleString("en-US")} |`);
  lines.push("");
  lines.push("## Bugs found (each fixed with a failing-then-passing test, own commit)", "");
  if (!bugs.length) lines.push("None.");
  for (const [i, b] of bugs.entries()) {
    lines.push(`${i + 1}. **${b.title}** (${b.where}). Repro: ${b.repro} Fix: ${b.fix} Test: \`${b.test}\`. Commit \`${b.commit}\`.`);
  }
  lines.push("", "## Every transaction", "", "| Flow | Call | Tx hash | Gas | Status | Revert (decoded) |", "|---|---|---|---|---|---|");
  for (const t of txs) lines.push(`| ${t.flow} | ${md(t.label)} | ${t.hash ?? "(not sent)"} | ${t.gas ?? ""} | ${t.status} | ${md(t.revert ?? "")} |`);
  writeFileSync(`${out}.md`, `${lines.join("\n")}\n`);

  const css = `body{font:14px/1.5 -apple-system,Segoe UI,sans-serif;max-width:1200px;margin:24px auto;padding:0 16px;color:#1d1d1f;background:#fff}
table{border-collapse:collapse;width:100%;margin:8px 0 24px;font-size:12px}td,th{border:1px solid #ddd;padding:4px 6px;vertical-align:top;text-align:left}
th{background:#f4f4f6}.pass{color:#0a7a2f;font-weight:600}.fail{color:#b42318;font-weight:700}code,.mono{font-family:ui-monospace,Menlo,monospace;font-size:11px;word-break:break-all}
@media (prefers-color-scheme:dark){body{background:#111;color:#eee}th{background:#222}td,th{border-color:#333}}`;
  const h: string[] = [`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><style>${css}</style></head><body>`];
  h.push(`<h1>${esc(title)}</h1><p><strong>${passed}/${flows.length} flows passed</strong>, ${txs.filter((t) => t.hash).length} transactions, ${bugs.length} bugs found and fixed.</p><ul>${notes.map((n) => `<li>${esc(n)}</li>`).join("")}${deploy ? `<li>Deploy: ${deploy.txs} transactions, ${deploy.gas.toLocaleString("en-US")} gas</li>` : ""}</ul>`);
  if (extra) h.push(`<pre style="white-space:pre-wrap">${esc(extra.trim())}</pre>`);
  for (const area of areas) {
    h.push(`<h2>${esc(area)}</h2><table><tr><th>#</th><th>Flow</th><th>Expected</th><th>Actual</th><th>Result</th></tr>`);
    for (const f of flows.filter((x) => x.area === area)) {
      h.push(`<tr><td>${f.id}</td><td>${esc(f.name)}</td><td>${esc(f.expected)}</td><td>${esc(f.actual)}</td><td class="${f.status}">${f.status === "pass" ? "PASS" : `FAIL: ${esc(f.error ?? "")}`}</td></tr>`);
    }
    h.push("</table>");
  }
  h.push(`<h2>Gas</h2><table><tr><th>Call</th><th>n</th><th>min</th><th>avg</th><th>max</th></tr>${gas.map((g) => `<tr><td>${esc(g.label)}</td><td>${g.n}</td><td>${g.min.toLocaleString("en-US")}</td><td>${g.avg.toLocaleString("en-US")}</td><td>${g.max.toLocaleString("en-US")}</td></tr>`).join("")}</table>`);
  h.push(`<h2>Bugs found</h2><ol>${bugs.map((b) => `<li><strong>${esc(b.title)}</strong> (${esc(b.where)}). Repro: ${esc(b.repro)} Fix: ${esc(b.fix)} Test: <code>${esc(b.test)}</code>. Commit <code>${esc(b.commit)}</code>.</li>`).join("") || "<li>None.</li>"}</ol>`);
  h.push(`<h2>Every transaction</h2><table><tr><th>Flow</th><th>Call</th><th>Tx hash</th><th>Gas</th><th>Status</th><th>Revert</th></tr>${txs.map((t) => `<tr><td>${t.flow}</td><td>${esc(t.label)}</td><td class="mono">${t.hash ?? "(not sent)"}</td><td>${t.gas ?? ""}</td><td class="${t.status === "success" ? "pass" : t.status === "reverted" ? "" : "fail"}">${t.status}</td><td>${esc(t.revert ?? "")}</td></tr>`).join("")}</table></body></html>`);
  writeFileSync(`${out}.html`, h.join("\n"));
  console.log(`report: ${out}.md, ${out}.html (${passed}/${flows.length} flows)`);
}
