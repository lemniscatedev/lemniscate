import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// fund-bots.sh sends real ETH with `cast send`: it must refuse without the armed flag and the arming file. A fake cast
// records every call, so the test proves nothing is sent when it refuses and that it sends once armed.
const script = join(import.meta.dir, "fund-bots.sh");
let dir: string;
const env = (extra: Record<string, string>) => ({
  PATH: process.env.PATH ?? "", HOME: dir, CAST: join(dir, "cast"), RPC_URL: "http://127.0.0.1:1",
  FUNDER_KEYSTORE: join(dir, "ks.json"), FUNDER_PASSWORD_FILE: join(dir, "pw"), ...extra,
});
const run = (extra: Record<string, string>) =>
  Bun.spawnSync(["bash", script, join(dir, "addr.json"), "keeper", "0.001"], { env: env(extra) });

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "lmns-fund-"));
  for (const f of ["ks.json", "pw"]) writeFileSync(join(dir, f), "x");
  writeFileSync(join(dir, "addr.json"), JSON.stringify({ keeper: "0x" + "ab".repeat(20) }));
  writeFileSync(join(dir, "cast"), `#!/bin/sh\necho "$1" >> "${join(dir, "calls.log")}"\ncase "$1" in chain-id) echo 4663;; send) echo '{"transactionHash":"0x1","status":"0x1"}';; esac\n`);
  chmodSync(join(dir, "cast"), 0o755);
  writeFileSync(join(dir, "armed"), "");
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const calls = () => (existsSync(join(dir, "calls.log")) ? readFileSync(join(dir, "calls.log"), "utf8") : "");

describe("fund-bots.sh armed flag", () => {
  test("refuses without the flag, with the flag but no file, and with a missing file; sends nothing", () => {
    for (const extra of [{}, { LEMNISCATE_ALLOW_REAL_DEPLOY: "1" }, { LEMNISCATE_ALLOW_REAL_DEPLOY: "1", LEMNISCATE_ALLOW_FILE: join(dir, "nope") }, { LEMNISCATE_ALLOW_FILE: join(dir, "armed") }, { LEMNISCATE_ALLOW_REAL_DEPLOY: "true", LEMNISCATE_ALLOW_FILE: join(dir, "armed") }]) {
      const r = run(extra);
      expect(r.exitCode).toBe(1);
      expect(r.stderr.toString()).toContain("refusing to send on a real chain");
    }
    expect(calls()).not.toContain("send");
  });

  test("armed (flag 1 and an existing file) sends", () => {
    const r = run({ LEMNISCATE_ALLOW_REAL_DEPLOY: "1", LEMNISCATE_ALLOW_FILE: join(dir, "armed") });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.toString()).toContain("keeper 0.001 ETH -> 0x1 status 0x1");
    expect(calls()).toContain("send");
  });
});
