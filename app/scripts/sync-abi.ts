// Regenerates the typed ABI modules in src/abi from the Foundry build output.
//   bun run scripts/sync-abi.ts            write src/abi/*.ts
//   bun run scripts/sync-abi.ts --check    exit 1 if any generated file is out of date (CI)
//   --no-build                             skip `forge build` (use the existing contracts/out)
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { ABI_TARGETS, generateAll } from "../src/abi/sync";

const args = new Set(process.argv.slice(2));
const check = args.has("--check");
const appDir = resolve(import.meta.dir, "..");
const contractsDir = resolve(appDir, "../contracts");
const outDir = join(contractsDir, "out");
const abiDir = join(appDir, "src/abi");

function forgeBinary(): string {
  for (const dir of (process.env.PATH ?? "").split(":")) if (dir && existsSync(join(dir, "forge"))) return join(dir, "forge");
  const fallback = join(homedir(), ".foundry/bin/forge");
  if (existsSync(fallback)) return fallback;
  throw new Error("forge not found: install Foundry or pass --no-build with an existing contracts/out");
}

if (!args.has("--no-build")) {
  const result = spawnSync(forgeBinary(), ["build", "--skip", "test", "--skip", "script"], { cwd: contractsDir, stdio: ["ignore", "ignore", "inherit"] });
  if (result.status !== 0) {
    console.error("sync-abi: forge build failed");
    process.exit(2);
  }
}

const generated = generateAll(outDir, ABI_TARGETS);
const drift: string[] = [];
for (const [file, text] of generated) {
  const path = join(abiDir, file);
  const current = existsSync(path) ? readFileSync(path, "utf8") : undefined;
  if (current === text) continue;
  if (check) drift.push(file);
  else writeFileSync(path, text);
}

if (check) {
  if (drift.length > 0) {
    console.error(`sync-abi: out of date: ${drift.join(", ")}. Run: bun run scripts/sync-abi.ts`);
    process.exit(1);
  }
  console.log(`sync-abi: ${generated.size} ABI modules up to date`);
} else {
  console.log(`sync-abi: wrote ${generated.size} ABI modules to src/abi`);
}
