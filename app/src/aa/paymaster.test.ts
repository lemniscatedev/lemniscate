import { describe, expect, test } from "bun:test";
import { concat, hexToBytes, recoverMessageAddress, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { approveCall } from "./kernel";
import { callsAreSponsorable, createSponsor, paymasterHash, type Op } from "./paymaster";

const ENGINE = "0x00000000000000000000000000000000000000e1" as Address;
const USDG = "0x00000000000000000000000000000000000000d1" as Address;
const ROUTER = "0x00000000000000000000000000000000000000f1" as Address;
const OTHER = "0x00000000000000000000000000000000000000aa" as Address;
const KEY = `0x${"0000000000000000000000000000000000000000000000000000000000a11ce0"}` as Hex; // test-key

/** The same operation as PaymasterTest.test_paymasterHashMatchesTypescriptVector. */
function vectorOp(): Op {
  return {
    sender: "0x1111111111111111111111111111111111111111", nonce: 7n, callData: "0xe9ae5c53",
    verificationGasLimit: 500_000n, callGasLimit: 800_000n, preVerificationGas: 100_000n,
    maxPriorityFeePerGas: 1_000_000_000n, maxFeePerGas: 2_000_000_000n,
    paymaster: "0x2222222222222222222222222222222222222222", paymasterVerificationGasLimit: 150_000n, paymasterPostOpGasLimit: 60_000n,
    paymasterData: "0x", signature: "0x",
  };
}

describe("paymaster hash (shared vector with Solidity)", () => {
  test("TypeScript and Solidity hash the same operation to the same value", () => {
    const hash = paymasterHash(vectorOp(), 4663, "0x2222222222222222222222222222222222222222", 1_792_200_300, 1_792_200_000);
    expect(hash).toBe("0x4382ba3bdadbf1cf33cc5db4dbf465b897fb8311ae09f899c24ea3f7381e598e"); // not-a-key
  });

  test("every covered field changes the hash; the account signature does not", () => {
    const base = vectorOp();
    const h = (op: Op, chain = 4663, vu = 1_792_200_300) => paymasterHash(op, chain, "0x2222222222222222222222222222222222222222", vu, 1_792_200_000);
    const reference = h(base);
    expect(h({ ...base, nonce: 8n })).not.toBe(reference);
    expect(h({ ...base, callData: "0xe9ae5c54" })).not.toBe(reference);
    expect(h({ ...base, preVerificationGas: 1n })).not.toBe(reference);
    expect(h({ ...base, callGasLimit: 1n })).not.toBe(reference);
    expect(h({ ...base, maxFeePerGas: 1n })).not.toBe(reference);
    expect(h({ ...base, paymasterPostOpGasLimit: 1n })).not.toBe(reference);
    expect(h({ ...base, factory: ENGINE, factoryData: "0x01" })).not.toBe(reference);
    expect(h(base, 1)).not.toBe(reference);
    expect(h(base, 4663, 1_792_200_301)).not.toBe(reference);
    expect(h({ ...base, signature: "0xdeadbeef", paymasterData: "0x1234" })).toBe(reference);
  });
});

describe("sponsor signing", () => {
  test("the signature recovers to the signer and lays out as validUntil | validAfter | sig", async () => {
    const sponsor = createSponsor({ address: "0x2222222222222222222222222222222222222222", signerKey: KEY, chainId: 4663, validitySeconds: 300 });
    const now = 1_792_200_100;
    const { paymasterData, window } = await sponsor.sign(vectorOp(), now);
    expect(hexToBytes(paymasterData).length).toBe(77);
    expect(window).toEqual({ validUntil: now + 300, validAfter: now - 10 });
    const hash = paymasterHash(vectorOp(), 4663, sponsor.address, window.validUntil, window.validAfter);
    const sig = `0x${paymasterData.slice(2 + 24)}` as Hex;
    expect(await recoverMessageAddress({ message: { raw: hash }, signature: sig })).toBe(privateKeyToAccount(KEY).address);
    expect(concat([paymasterData.slice(0, 14) as Hex])).toBe(`0x${(now + 300).toString(16).padStart(12, "0")}`);
  });
});

describe("sponsorship policy mirror", () => {
  const policy = { engine: ENGINE, usdg: USDG, agentRouter: ROUTER };
  const call = (to: Address, data: Hex = "0x11223344", value = 0n) => ({ to, value, data });

  test("engine, router and USDG approve to either are sponsorable", () => {
    expect(callsAreSponsorable([call(ENGINE)], policy)).toBe(true);
    expect(callsAreSponsorable([call(ROUTER)], policy)).toBe(true);
    expect(callsAreSponsorable([approveCall(USDG, ENGINE, 5n), call(ENGINE)], policy)).toBe(true);
    expect(callsAreSponsorable([approveCall(USDG, ROUTER, 5n)], policy)).toBe(true);
  });

  test("everything else is not", () => {
    expect(callsAreSponsorable([call(OTHER)], policy)).toBe(false);
    expect(callsAreSponsorable([approveCall(USDG, OTHER, 5n)], policy)).toBe(false);
    expect(callsAreSponsorable([call(USDG, "0xa9059cbb" + "00".repeat(64) as Hex)], policy)).toBe(false);
    expect(callsAreSponsorable([call(ENGINE, "0x11223344", 1n)], policy)).toBe(false);
    expect(callsAreSponsorable([call(ENGINE, "0x")], policy)).toBe(false);
    expect(callsAreSponsorable([], policy)).toBe(false);
    expect(callsAreSponsorable(Array.from({ length: 5 }, () => call(ENGINE)), policy)).toBe(false);
    expect(callsAreSponsorable([call(ROUTER)], { engine: ENGINE, usdg: USDG })).toBe(false);
  });
});

describe("R5 noKeysInServer", () => {
  test("only the sponsor module can turn a private key into an account", () => {
    const dir = import.meta.dir;
    const offenders = readdirSync(dir)
      .filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
      .filter((file) => /privateKeyToAccount|signTransaction|signTypedData|mnemonicToAccount/.test(readFileSync(join(dir, file), "utf8")))
      .filter((file) => file !== "paymaster.ts");
    expect(offenders).toEqual([]);
  });
});
