// Unit tests for the mainnet launch tooling (no chain, no keys needed): the chain-id guard, the cost model, the service
// env files (mainnet only, no key in any of them, hedger dry run, vol engine not sending), the ownership hand-over
// check, the role to variable map, and the shell scripts' syntax.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { getAddress, type Address } from "viem";
import { parseOptionDeployment } from "@/chain/deployment";
import {
  assertMainnetChainId, assertNoRawKeys, botBudget, envFileText, fmtEth, PATHS, RAW_KEY_VARIABLES, REQUIRED_ROLES, ROLE_KEY, roleEnv, SERVER_ROLES, SERVICE_KEYS, txCostWei, withMargin, WrongChainError,
} from "./lib";
import { envFiles, pendingAccepts, withExtras } from "./setup";

const A = (n: number) => getAddress(`0x${n.toString(16).padStart(40, "0")}`);

describe("chain guard", () => {
  test("only 4663 passes", () => {
    expect(() => assertMainnetChainId(4663)).not.toThrow();
    expect(() => assertMainnetChainId("0x1237")).not.toThrow();
    for (const id of [46630, 31337, 1, 42161, "0xb626"]) expect(() => assertMainnetChainId(id)).toThrow(WrongChainError);
  });
});

describe("cost model", () => {
  test("Orbit cost = (L2 gas + L1 data gas) x base fee", () => {
    expect(txCostWei({ gasUsed: 100n, l1Gas: 0n }, 21_588_000n)).toBe(2_158_800_000n);
    expect(txCostWei({ gasUsed: 100n, l1Gas: 50n }, 10n)).toBe(1_500n);
  });

  test("margin rounds up and is exact for whole numbers", () => {
    expect(withMargin(1_000n, 5_000n)).toBe(1_500n);
    expect(withMargin(1n, 5_000n)).toBe(2n);
    for (let i = 0; i < 1000; i++) {
      const w = BigInt(Math.floor(Math.random() * 1e15));
      const m = withMargin(w, 5_000n);
      expect(m * 10_000n >= w * 15_000n).toBe(true);
      expect((m - 1n) * 10_000n < w * 15_000n).toBe(true);
    }
  });

  test("bot budget: gas per window x days, never rounding a day down", () => {
    const b = botBudget([{ role: "keeper", txs: 30, l2Gas: 3_000_001n, l1Gas: 0n }], 3, 30, 2n);
    expect(b[0]!.txsPerDay).toBe(10);
    expect(b[0]!.perDayWei).toBe(1_000_001n * 2n);
    expect(b[0]!.totalWei).toBe(1_000_001n * 2n * 30n);
    expect(() => botBudget([], 0, 30, 1n)).toThrow();
  });

  test("fmtEth", () => {
    expect(fmtEth(2_445_500_000_000_000n, 8)).toBe("0.0024455");
    expect(fmtEth(0n)).toBe("0");
    expect(fmtEth(-1_500_000_000_000_000_000n)).toBe("-1.5");
  });
});

describe("roles and keys", () => {
  test("keeper, hedger and vol signer are required, each read through its own keystore variables", () => {
    expect([...REQUIRED_ROLES]).toEqual(["keeper", "hedger", "vol-signer"]);
    const vars = SERVER_ROLES.flatMap((r) => Object.keys(roleEnv(r, "/k")));
    expect(new Set(vars).size).toBe(SERVER_ROLES.length * 2);
    expect(roleEnv("vol-signer", "/k")).toEqual({ VOL_SIGNER_KEYSTORE: "/k/vol-signer.json", VOL_SIGNER_KEYSTORE_PASSWORD_FILE: "/k/vol-signer.password" });
    expect(Object.keys(ROLE_KEY).sort()).toEqual([...SERVER_ROLES].sort());
  });

  test("every role is carried by exactly one service", () => {
    const carried = Object.values(SERVICE_KEYS).flat();
    expect(new Set(carried).size).toBe(carried.length);
    expect([...carried].sort()).toEqual([...SERVER_ROLES].sort());
  });

  test("the unit files and SERVICE_KEYS agree on which keystores each service reads, and no unit uses a wrapper", () => {
    const dir = join(import.meta.dir, "..", "server", "systemd");
    for (const [service, roles] of Object.entries(SERVICE_KEYS)) {
      const unit = readFileSync(join(dir, `lemniscate-${service}.service`), "utf8");
      expect(unit).not.toContain("run-with-keys");
      const required = roles.filter((r) => (REQUIRED_ROLES as readonly string[]).includes(r));
      const optional = roles.filter((r) => !(REQUIRED_ROLES as readonly string[]).includes(r));
      const set = new Set([...unit.matchAll(/^Environment=([A-Z0-9_]+_KEYSTORE(?:_PASSWORD_FILE)?)=(\S+)$/gm)].map((m) => `${m[1]}=${m[2]}`));
      const want = required.flatMap((r) => Object.entries(roleEnv(r, "/etc/lemniscate/keys")).map(([k, v]) => `${k}=${v}`));
      expect([...set].sort()).toEqual(want.sort());
      // optional roles come from the generated /etc/lemniscate/<service>-keys.env, only when the keystore exists
      expect(unit.includes("EnvironmentFile=-/etc/lemniscate/api-keys.env")).toBe(optional.length > 0);
    }
  });

  test("a raw key in an env file is refused", () => {
    for (const k of RAW_KEY_VARIABLES) expect(() => assertNoRawKeys({ [k]: "x" })).toThrow();
    expect(() => assertNoRawKeys({ API_PORT: 3101 })).not.toThrow();
  });
});

describe("service env files", () => {
  const raw = {
    chainId: 4663,
    network: "mainnet",
    deployBlock: 10,
    contracts: { engine: A(1), pool: A(2), registry: A(3), priceGuard: A(4), volOracle: A(5), usdg: A(6), hedgeAdapter: A(7) },
    stocks: [{ name: "NVDA", stock: A(8), feed: A(9), pool: A(10), fee: 3000 }],
    owner: A(11),
    acceptOwnership: [A(1)],
  };
  const dep = withExtras(parseOptionDeployment(raw as unknown), raw);

  test("mainnet, no key, hedger dry run, vol engine not sending, oracle address from the deployment", () => {
    const f = envFiles(dep, "postgres://x/lemniscate_mainnet");
    expect(Object.keys(f).sort()).toEqual(["api", "hedger", "indexer", "keeper", "vol-engine"]);
    for (const vars of Object.values(f)) {
      expect(vars.NETWORK).toBe("mainnet");
      expect(vars.CHAIN_ID).toBe(4663);
      expect(Object.keys(vars).some((k) => (RAW_KEY_VARIABLES as readonly string[]).includes(k))).toBe(false);
    }
    expect(f.hedger!.HEDGER_DRY_RUN).toBe(1);
    expect(f.keeper!.KEEPER_KEYSTORE).toBe(join(PATHS.keys, "keeper.json"));
    expect(f.keeper!.KEEPER_KEYSTORE_PASSWORD_FILE).toBe(join(PATHS.keys, "keeper.password"));
    expect(f["vol-engine"]!.VOL_SIGNER_KEYSTORE).toBe(join(PATHS.keys, "vol-signer.json"));
    expect(f.hedger!.KEEPER_KEYSTORE).toBeUndefined(); // a service learns only its own role
    expect(f["vol-engine"]!.VOL_SEND).toBe(0);
    expect(f["vol-engine"]!.VOL_ORACLE_ADDRESS).toBe(A(5).toLowerCase());
    expect(f.hedger!.HEDGER_ADAPTER_ADDRESS).toBe(A(7).toLowerCase());
  });

  test("the api learns the optional keystores only when the files exist", () => {
    const none = envFiles(dep, "postgres://x/y", { keyExists: () => false });
    expect(none.api!.PAYMASTER_SIGNER_KEYSTORE).toBeUndefined();
    const some = envFiles(dep, "postgres://x/y", { keyExists: (p) => p.endsWith("paymaster-signer.json"), keysDir: "/k" });
    expect(some.api!.PAYMASTER_SIGNER_KEYSTORE).toBe("/k/paymaster-signer.json");
    expect(some.api!.X402_SETTLER_KEYSTORE).toBeUndefined();
  });

  test("owner and ownership list survive the typed parse", () => {
    expect(dep.owner).toBe(A(11));
    expect(dep.acceptOwnership).toEqual([A(1)]);
  });

  test("a fork deployment is refused", () => {
    expect(() => envFiles({ ...dep, network: "fork" }, "postgres://x/y")).toThrow();
  });

  test("env text drops empty values", () => {
    expect(envFileText({ A: 1, B: "", C: undefined, D: "x" })).toBe("A=1\nD=x\n");
  });
});

describe("ownership hand-over check", () => {
  test("lists only the contracts OWNER does not own yet", async () => {
    const owner = A(1);
    const owners: Record<string, Address> = { [A(7)]: owner, [A(8)]: A(99) };
    const left = await pendingAccepts(owner, [A(7), A(8)], async (a) => owners[a]!);
    expect(left).toEqual([A(8)]);
  });
});

describe("shell scripts", () => {
  const serverDir = join(import.meta.dir, "..", "server");
  const files = [
    ...readdirSync(import.meta.dir).filter((f) => f.endsWith(".sh")).map((f) => join(import.meta.dir, f)),
    ...readdirSync(serverDir).filter((f) => f.endsWith(".sh")).map((f) => join(serverDir, f)),
  ];
  for (const file of files) {
    test(`bash -n ${file.split("/").slice(-2).join("/")}`, () => {
      const r = spawnSync("bash", ["-n", file]);
      expect(r.status).toBe(0);
    });
  }

  test("run-with-keys.sh is gone", () => {
    expect(existsSync(join(serverDir, "run-with-keys.sh"))).toBe(false);
  });
});

describe("web/vercel.json", () => {
  const cfg = JSON.parse(readFileSync(join(import.meta.dir, "..", "..", "..", "web", "vercel.json"), "utf8")) as {
    framework: unknown; outputDirectory: string; installCommand: string; buildCommand: string; ignoreCommand: string;
    headers: { source: string; headers: { key: string; value: string }[] }[];
  };
  const header = (source: string, key: string) => cfg.headers.find((h) => h.source === source)?.headers.find((h) => h.key === key)?.value;

  test("static site: no framework, dist output, ignored build step", () => {
    expect(cfg.framework).toBeNull();
    expect(cfg.outputDirectory).toBe("dist");
    expect(cfg.installCommand).toBe("npm ci");
    expect(cfg.buildCommand).toBe("npm run check");
    expect(cfg.ignoreCommand).toBe("git diff --quiet HEAD^ HEAD -- .");
  });

  test("short cache everywhere, immutable only for the hashed app chunks", () => {
    expect(header("/(.*)", "Cache-Control")).toContain("must-revalidate");
    expect(header("/assets/app/(.*)", "Cache-Control")).toBe("public, max-age=31536000, immutable");
    expect(cfg.headers.filter((h) => h.headers.some((x) => x.value.includes("immutable"))).map((h) => h.source)).toEqual(["/assets/app/(.*)"]);
  });

  test("MIME types for .mjs and .framercms", () => {
    expect(header("/(.*)\\.mjs", "Content-Type")).toContain("text/javascript");
    expect(header("/(.*)\\.framercms", "Content-Type")).toBe("application/octet-stream");
  });
});
