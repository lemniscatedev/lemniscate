import { describe, expect, test } from "bun:test";
import { checkRoles, requiredRoles } from "./startup";
import { A } from "./test-support";
import { assertKeysSeparated, loadKeeperSigningKey } from "../config";

const K1 = `0x${"11".repeat(32)}`;
const K2 = `0x${"22".repeat(32)}`;
const K3 = `0x${"33".repeat(32)}`;

describe("signer separation (R8)", () => {
  test("three different keys are fine; a missing one is fine", () => {
    expect(() => assertKeysSeparated({ KEEPER_PRIVATE_KEY: K1, HEDGER_PRIVATE_KEY: K2, VOL_SIGNER_KEY: K3 })).not.toThrow();
    expect(() => assertKeysSeparated({ KEEPER_PRIVATE_KEY: K1 })).not.toThrow();
  });
  test("any two equal keys refuse, however they are written, and the message never contains a key", () => {
    for (const [a, b] of [["KEEPER_PRIVATE_KEY", "HEDGER_PRIVATE_KEY"], ["KEEPER_PRIVATE_KEY", "VOL_SIGNER_KEY"], ["HEDGER_PRIVATE_KEY", "VOL_SIGNER_KEY"]] as const) {
      let message = "";
      try { assertKeysSeparated({ [a]: K1, [b]: K1.toUpperCase().replace("0X", "0x") }); } catch (e) { message = (e as Error).message; }
      expect(message).toContain("must be different keys");
      expect(message).not.toContain("1111");
    }
    expect(() => assertKeysSeparated({ KEEPER_PRIVATE_KEY: K1, HEDGER_PRIVATE_KEY: K1, VOL_SIGNER_KEY: K1 })).toThrow();
    expect(() => assertKeysSeparated({ KEEPER_PRIVATE_KEY: K1, VOL_SENDER_KEY: K1 })).toThrow();
    expect(() => assertKeysSeparated({ VOL_SIGNER_KEY: K2, VOL_SENDER_KEY: K2 })).not.toThrow();
  });
  test("loading the keeper key enforces it", () => {
    expect(() => loadKeeperSigningKey({ KEEPER_PRIVATE_KEY: K1, VOL_SIGNER_KEY: K1 })).toThrow("must be different keys");
    expect(loadKeeperSigningKey({ KEEPER_PRIVATE_KEY: K1, VOL_SIGNER_KEY: K2 })).toBe(K1 as `0x${string}`);
  });
});

describe("role check", () => {
  const deployment = { contracts: { marketHours: A.marketHours, registry: A.registry, engine: A.engine } } as never;
  test("each enabled job names the role it needs", () => {
    const needs = requiredRoles(new Set(["sessions", "lister", "risk", "accrue", "receipts"]), deployment);
    expect(needs.map((n) => `${n.job}:${n.role}`)).toEqual(["sessions:KEEPER_ROLE", "lister:KEEPER_ROLE", "risk:GUARDIAN_ROLE"]);
  });
  test("reports missing roles and separates unreadable ones", async () => {
    const needs = requiredRoles(new Set(["sessions", "lister", "risk"]), deployment);
    const stateClient = { multicall: async () => [{ status: "success", result: true }, { status: "success", result: false }, { status: "failure" }] };
    const r = await checkRoles({ stateClient } as never, needs, A.nvda);
    expect(r.missing.map((n) => n.job)).toEqual(["lister"]);
    expect(r.unverified.map((n) => n.job)).toEqual(["risk"]);
  });
});
