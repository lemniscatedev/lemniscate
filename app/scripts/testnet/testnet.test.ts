// Unit tests for the testnet run's pure pieces (todo 26). The scripts themselves are exercised end to end by the dry run
// (scripts/testnet/dry-run.sh on a local fork of the testnet).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { needsPush, parseSources } from "./mirror";
import { rewrite } from "./fee-shim";
import { roundUpEth, withMargin, TESTNET_GAS_PRICE } from "./ledger";
import { envText, keyEnv } from "./setup";
import { isLocalRpc } from "./lib";

describe("feed mirror", () => {
  test("parses NAME=address pairs and refuses a malformed item", () => {
    const s = parseSources("nvda=0x00000000000000000000000000000000000000a1, TSLA=0x00000000000000000000000000000000000000a2");
    expect(Object.keys(s)).toEqual(["NVDA", "TSLA"]);
    expect(() => parseSources("NVDA")).toThrow();
  });
  test("pushes each mainnet round once", () => {
    expect(needsPush(5n, undefined)).toBe(true);
    expect(needsPush(5n, "5")).toBe(false);
    expect(needsPush(6n, "5")).toBe(true);
  });
});

describe("dry-run fee shim", () => {
  test("answers like the testnet: no priority fee, the 0.01 gwei floor as the gas price; forwards the rest", () => {
    expect(rewrite("eth_maxPriorityFeePerGas")).toBe("0x0");
    expect(rewrite("eth_gasPrice")).toBe("0x989680");
    expect(rewrite("eth_sendRawTransaction")).toBeUndefined();
    expect(rewrite("eth_call")).toBeUndefined();
  });
});

describe("gas ledger", () => {
  test("adds 50% rounded up and rounds ETH up to 0.0001", () => {
    expect(withMargin(100n)).toBe(150n);
    expect(withMargin(1n)).toBe(2n);
    expect(roundUpEth(1n)).toBe(10n ** 14n);
    expect(roundUpEth(10n ** 14n)).toBe(10n ** 14n);
    expect(TESTNET_GAS_PRICE).toBe(10_000_000n);
  });
});

describe("service env files", () => {
  test("carry keystore and password PATHS, never a key", () => {
    const v = keyEnv("KEEPER", "keeper", "/k");
    expect(v).toEqual({ KEEPER_KEYSTORE: "/k/keeper.json", KEEPER_KEYSTORE_PASSWORD_FILE: "/k/keeper.password" });
    expect(envText({ A: "1", B: "two words" })).toBe('A=1\nB="two words"\n');
  });
});

describe("real-network guard", () => {
  test("only loopback counts as the dry run", () => {
    expect(isLocalRpc("http://127.0.0.1:8615")).toBe(true);
    expect(isLocalRpc("http://localhost:8615")).toBe(true);
    expect(isLocalRpc("https://rpc.testnet.chain.robinhood.com")).toBe(false);
  });
  test("env.sh refuses the real testnet without the arming flag and flag file", () => {
    const env = readFileSync(join(import.meta.dir, "env.sh"), "utf8");
    expect(env).toContain('LEMNISCATE_TESTNET_ARMED:-}" != 1');
    expect(env).toContain(".lemniscate/testnet-armed");
    const deploy = readFileSync(join(import.meta.dir, "deploy.sh"), "utf8");
    expect(deploy).toContain("assert_testnet");
  });
});
