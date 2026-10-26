import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ConfigurationError, loadConfig, loadKeeperSigningKey, snapshotHeartbeatMs } from "./config";
import { loadMcpSettings } from "./mcp/config";
import { loadHedgerSigningKey } from "./hedger";

/** DEP-6: every service started with the values shipped in the env examples is either safe (no signer, no sending, nothing
 * open to the world) or refuses to start. Nothing here sets a key: that is the point. */

const ROOT = join(import.meta.dir, "..");
function parse(file: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of readFileSync(join(ROOT, file), "utf8").split("\n")) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (match) env[match[1]!] = match[2]!;
  }
  return env;
}
const server = parse("scripts/server/env.example");
const dev = parse(".env.example");
// provision.sh writes these two to db.env, outside the example.
const withDb = (env: Record<string, string>): Record<string, string> => ({ DATABASE_URL: "postgres://u:p@127.0.0.1:5432/lemniscate", POSTGRES_PASSWORD: "p", ...env });
/** The server example with only its CHANGE_ME placeholders replaced by plausible real values. */
function filled(): Record<string, string> {
  const env = withDb(server);
  for (const [name, value] of Object.entries(env)) {
    if (value !== "CHANGE_ME") continue;
    env[name] = name.endsWith("_ADDRESS") ? `0x${"1".repeat(40)}` : name === "CORS_ORIGINS" ? "https://example.org" : "filled";
  }
  return env;
}

describe("server env.example", () => {
  test("a placeholder left in place leaves the services inert (no signer, hedger dry run); the hedger adapter is no longer needed", () => {
    // Since todo 14b the hedger calls pool.rebalance and the pool holds its own adapter: the old adapter setting is empty.
    expect(server.HEDGER_ADAPTER_ADDRESS).toBe("");
    const env = withDb(server);
    const config = loadConfig(env);
    expect(config.HEDGER_DRY_RUN).toBe(true);
    expect(loadKeeperSigningKey(env)).toBeUndefined();
    expect(loadHedgerSigningKey(env)).toBeUndefined();
  });

  test("deploy.sh refuses to start anything while any placeholder is left", () => {
    const deploy = readFileSync(join(ROOT, "scripts/server/deploy.sh"), "utf8");
    expect(deploy).toContain("^[A-Z0-9_]+=(CHANGE_ME|GENERATED_BY_PROVISION)$");
    expect(Object.values(server).includes("CHANGE_ME")).toBe(true);
  });

  test("filled in, the services load no signer, send nothing and open nothing to the world", () => {
    const env = filled();
    const config = loadConfig(env);
    expect(config.NETWORK).toBe("mainnet");
    expect(config.CHAIN_ID).toBe(4663);
    expect(config.NODE_ENV).toBe("production");
    expect(config.CORS_ORIGINS).toEqual(["https://example.org"]);
    expect(config.CORS_ORIGINS).not.toContain("*");
    expect(config.API_RATE_LIMIT_PER_MINUTE).toBeGreaterThan(0);
    expect(config.HEDGER_DRY_RUN).toBe(true);
    expect(config.HEDGER_PERP_ENABLED).toBe(false);
    expect(config.RPC_URL_OVERRIDE.trim()).toBe("");
    // no key of any role is present, so the keeper and hedger have no signer and refuse to run
    expect(loadKeeperSigningKey(env)).toBeUndefined();
    expect(loadHedgerSigningKey(env)).toBeUndefined();
    for (const [name, value] of Object.entries(env)) if (/(PRIVATE_KEY|SIGNER_KEY|SENDER_KEY|SETTLER_KEY|AGENT_KEY)$/.test(name)) expect(value).toBe("");
  });

  test("a raw key is refused in the production profile the example sets", () => {
    const env = { ...filled(), KEEPER_PRIVATE_KEY: `0x${"ab".repeat(32)}` };
    expect(() => loadKeeperSigningKey(env)).toThrow(/keystore/);
  });

  test("the MCP server starts read-only, on loopback, with no agent key and no policy", () => {
    const settings = loadMcpSettings(filled());
    expect(settings.agentKey).toBeUndefined();
    expect(settings.router).toBeUndefined();
    expect(settings.policy).toBeUndefined();
    expect(settings.httpHost).toBe("127.0.0.1");
    expect(settings.allowedOrigins).not.toContain("*");
  });

  test("optional features are off: x402, sponsoring, the invite switch default, the earnings key", () => {
    expect(server.X402_ENABLED).toBeUndefined();
    expect(server.BUNDLER_URL).toBe("");
    expect(server.PAYMASTER_ADDRESS).toBe("");
    expect(server.VOL_SEND).toBe("0");
    expect(server.HEDGER_DRY_RUN).toBe("1");
  });
});

describe("R3-08 keeper jobs in the shipped env files", () => {
  /** Jobs the code does not run by default and that an operator turns on on purpose. */
  const OPT_IN = new Set(["buy-burn", "hedge"]);
  const jobs = (value: string) => new Set(value.split(",").map((job) => job.trim()).filter(Boolean));
  const defaults = () => {
    const env = withDb({ ...server });
    delete env.KEEPER_ENABLED_JOBS;
    return jobs(loadConfig(env).KEEPER_ENABLED_JOBS);
  };

  test("every default keeper job (kernel-register among them) is enabled by both env examples, apart from the opt-in ones", () => {
    const expected = [...defaults()].filter((job) => !OPT_IN.has(job));
    expect(expected).toContain("kernel-register");
    for (const [name, env] of [["scripts/server/env.example", server], [".env.example", dev]] as const) {
      const enabled = jobs(env.KEEPER_ENABLED_JOBS ?? "");
      expect({ file: name, missing: expected.filter((job) => !enabled.has(job)) }).toEqual({ file: name, missing: [] });
    }
  });

  test("PROPERTY: drop any subset of jobs from either shipped env file's real list and the check names exactly the default jobs dropped", () => {
    const all = [...defaults()].filter((job) => !OPT_IN.has(job));
    let seed = 808;
    const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
    for (const env of [server, dev]) {
      const shipped = (env.KEEPER_ENABLED_JOBS ?? "").split(",").map((job) => job.trim()).filter(Boolean);
      expect(shipped.length).toBeGreaterThan(0); // the file really sets the list
      for (let trial = 0; trial < 200; trial++) {
        const dropped = shipped.filter(() => rnd(4) === 0);
        const enabled = jobs(shipped.filter((job) => !dropped.includes(job)).join(","));
        expect(all.filter((job) => !enabled.has(job))).toEqual(all.filter((job) => dropped.includes(job)));
      }
    }
  });

  test("the dust-pass age in .env.example matches the config default (hourly, decision 66a)", () => {
    const env = withDb({ ...server });
    delete env.KEEPER_ACCRUE_DUST_MAX_AGE_SECONDS;
    const fallback = loadConfig(env).KEEPER_ACCRUE_DUST_MAX_AGE_SECONDS;
    expect(fallback).toBe(3600);
    for (const env of [server, dev]) if (env.KEEPER_ACCRUE_DUST_MAX_AGE_SECONDS !== undefined) expect(Number(env.KEEPER_ACCRUE_DUST_MAX_AGE_SECONDS)).toBe(fallback);
    expect(readFileSync(join(ROOT, ".env.example"), "utf8")).not.toContain("accrued once a day");
  });
});

describe("indexer snapshot heartbeat (27d)", () => {
  test("production keeps 10 minutes (the vol-engine's 25-minute tick limit is two heartbeats plus 5), the fork profile 60 s, and an override is capped at 10", () => {
    expect(snapshotHeartbeatMs(loadConfig(withDb({ ...server, NETWORK: "mainnet" })))).toBe(600_000);
    expect(snapshotHeartbeatMs(loadConfig(dev))).toBe(60_000);
    expect(snapshotHeartbeatMs(loadConfig({ ...dev, INDEXER_SNAPSHOT_HEARTBEAT_MS: "15000" }))).toBe(15_000);
    expect(() => loadConfig({ ...dev, INDEXER_SNAPSHOT_HEARTBEAT_MS: "1200000" })).toThrow();
  });
});

describe("development .env.example", () => {
  test("loads on the fork profile with no signer, and never targets mainnet by itself", () => {
    const config = loadConfig(dev);
    expect(config.NETWORK).toBe("fork");
    expect(config.NODE_ENV).toBe("development");
    expect(loadKeeperSigningKey(dev)).toBeUndefined();
    expect(loadHedgerSigningKey(dev)).toBeUndefined();
  });

  test("the sample database password is a visible placeholder", () => {
    expect(dev.DATABASE_URL).toContain("change-me");
  });
});
