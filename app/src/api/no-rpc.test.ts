import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

// R9: the API reads only Postgres. Nothing under src/api (or the query modules it calls) may import an RPC client.
const roots = [import.meta.dir, join(import.meta.dir, "../db/queries")];
const forbidden = [
  /from\s+["'][^"']*chain\/clients["']/,
  /from\s+["'][^"']*chain\/rpc-pool["']/,
  /import\(\s*["'][^"']*chain\/(clients|rpc-pool)["']\s*\)/,
  new RegExp(["create", "PublicClient"].join("")),
  new RegExp(["create", "WalletClient"].join("")),
  new RegExp(["json", "rpc"].join(""), "i"),
];

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return sources(path);
    return path.endsWith(".ts") && !path.endsWith("no-rpc.test.ts") ? [path] : [];
  });
}

test("no module under src/api or src/db/queries imports an RPC client", () => {
  const offenders: string[] = [];
  for (const root of roots) {
    for (const file of sources(root)) {
      const text = readFileSync(file, "utf8");
      for (const pattern of forbidden) {
        if (pattern.test(text)) offenders.push(`${relative(join(import.meta.dir, ".."), file)} matches ${pattern}`);
      }
    }
  }
  expect(offenders).toEqual([]);
});

test("the lint actually scans the API sources", () => {
  expect(sources(import.meta.dir).length).toBeGreaterThan(10);
});

// F32: the account-abstraction modules are the one place the API may read the chain. Only chain.ts talks to a node (the
// bundler modules speak to the bundler service, not a node), and chain.ts must put every read behind the budget.
test("src/aa creates no node client outside chain.ts, and chain.ts budgets every read with no retries", () => {
  const aaRoot = join(import.meta.dir, "../aa");
  const allowed = new Set(["chain.ts", "bundler.ts", "mock-bundler.ts"]);
  const offenders: string[] = [];
  for (const file of sources(aaRoot)) {
    const name = relative(aaRoot, file);
    if (allowed.has(name) || name.endsWith(".test.ts")) continue;
    const text = readFileSync(file, "utf8");
    for (const pattern of forbidden) if (pattern.test(text)) offenders.push(`aa/${name} matches ${pattern}`);
  }
  expect(offenders).toEqual([]);
  const chain = readFileSync(join(aaRoot, "chain.ts"), "utf8");
  expect(chain).toContain("withRpcBudget(raw");
  expect(chain).toContain("retryCount: 0");
});
