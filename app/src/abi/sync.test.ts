import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ABI_TARGETS, conforms, entrySignature, generateAll, renderModule, resolveAbi, type AbiEntry, type AbiTarget } from "./sync";

const fn = (name: string, ...types: string[]): AbiEntry => ({
  type: "function", name, inputs: types.map((type, i) => ({ name: `a${i}`, type })), outputs: [], stateMutability: "nonpayable",
});
const evt = (name: string, ...types: string[]): AbiEntry => ({ type: "event", name, inputs: types.map((type, i) => ({ name: `a${i}`, type, indexed: false })) });

let dir: string;
function artifact(name: string, abi: AbiEntry[]): void {
  mkdirSync(join(dir, `${name}.sol`), { recursive: true });
  writeFileSync(join(dir, `${name}.sol`, `${name}.json`), JSON.stringify({ abi }));
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "lmns-abi-"));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("syncAbiFromForge", () => {
  test("signatures ignore parameter names and expand tuples", () => {
    const a: AbiEntry = { type: "function", name: "post", inputs: [{ name: "p", type: "tuple", components: [{ name: "x", type: "uint64" }, { name: "y", type: "address[]" }] }, { name: "sig", type: "bytes" }] };
    const b: AbiEntry = { type: "function", name: "post", inputs: [{ name: "q", type: "tuple", components: [{ name: "s", type: "uint64" }, { name: "t", type: "address[]" }] }, { name: "z", type: "bytes" }] };
    expect(entrySignature(a)).toBe("function:post((uint64,address[]),bytes)");
    expect(entrySignature(a)).toBe(entrySignature(b));
  });

  test("an implementation conforms only if it has every interface entry with the same signature", () => {
    const iface = [fn("buy", "uint256"), evt("Bought", "uint256")];
    expect(conforms([...iface, fn("extra")], iface)).toBe(true);
    expect(conforms([fn("buy", "uint256")], iface)).toBe(false);
    expect(conforms([fn("buy", "uint128"), evt("Bought", "uint256")], iface)).toBe(false);
  });

  test("the interface is the floor; a conforming implementation replaces it; supplements fill gaps only", () => {
    artifact("IThing", [fn("a", "uint256"), evt("Done", "uint256")]);
    const target: AbiTarget = {
      file: "Thing", exportName: "ThingAbi", implementations: ["Thing"], iface: "IThing",
      supplement: ["event Extra(uint256 x)", "event Done(uint256 y)"],
    };
    // interface only
    let resolved = resolveAbi(dir, target);
    expect(resolved.abi.map((e) => e.name)).toEqual(["a", "Done", "Extra"]);
    expect(resolved.source).toContain("interface IThing");
    // a stale implementation (old shape) is ignored
    artifact("Thing", [fn("a", "uint128"), evt("Done", "uint256")]);
    resolved = resolveAbi(dir, target);
    expect(resolved.source).toContain("interface IThing");
    // a conforming implementation wins and its own Extra suppresses the supplement
    artifact("Thing", [fn("a", "uint256"), fn("admin"), evt("Done", "uint256"), evt("Extra", "address")]);
    resolved = resolveAbi(dir, target);
    expect(resolved.source).toContain("contract Thing");
    expect(resolved.abi.map((e) => e.name)).toEqual(["a", "admin", "Done", "Extra"]);
    expect((resolved.abi.find((e) => e.name === "Extra")?.inputs ?? [])[0]?.type).toBe("address");
  });

  test("a missing interface falls back to the declared entries, and fails without a fallback", () => {
    const withFallback: AbiTarget = { file: "X", exportName: "XAbi", implementations: [], iface: "IMissing", fallback: ["function go(uint256 x)"] };
    expect(resolveAbi(dir, withFallback).source).toContain("fallback");
    expect(() => resolveAbi(dir, { file: "Y", exportName: "YAbi", implementations: [], iface: "IMissing" })).toThrow(/No ABI source/);
  });

  test("output is deterministic and drift is detectable", () => {
    const target = ABI_TARGETS[0]!;
    const out = resolve(import.meta.dir, "../../../contracts/out");
    if (!existsSync(join(out, "IOptionEngine.sol"))) return; // needs `forge build`
    const first = renderModule(target, resolveAbi(out, target));
    const second = renderModule(target, resolveAbi(out, target));
    expect(first).toBe(second);
    expect(first.startsWith("// AUTO-GENERATED")).toBe(true);
    expect(first).toContain("export const OptionEngineAbi = [");
  });

  test("the committed ABI modules match the Foundry build (what `sync-abi --check` enforces in CI)", () => {
    const out = resolve(import.meta.dir, "../../../contracts/out");
    if (!existsSync(join(out, "IOptionEngine.sol"))) return;
    for (const [file, text] of generateAll(out)) {
      expect(readFileSync(join(import.meta.dir, file), "utf8"), file).toBe(text);
    }
  });

  test("every spec contract has a target", () => {
    expect(ABI_TARGETS.map((target) => target.file).sort()).toEqual(["AgentRouter", "MarketHours", "OptionEngine", "OptionToken", "Pool", "PriceGuard", "SeriesRegistry", "VolOracle"]);
  });
});
