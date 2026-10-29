import { describe, expect, test } from "bun:test";
import { decodeFunctionData, recoverMessageAddress, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { approveCall, kernelAbi } from "./kernel";
import { paymasterHash } from "./paymaster";
import { AaError, buildUserOp, callsForIntent, hashOf, kernelSalt, maxCostOf } from "./userop";
import { ACCOUNT, ENGINE, OWNER, PAYMASTER, SIGNER_KEY, USDG, createTestServices } from "./test-support";

const buyCalls = [approveCall(USDG, ENGINE, 1_000_000n), { to: ENGINE, value: 0n, data: "0x12345678" as Hex }];

describe("userOpBuilder (R1)", () => {
  test("builds a v0.7 operation with the approve + engine batch and a Kernel nonce", async () => {
    const { services, state } = createTestServices();
    state.nonces.set(`${ACCOUNT.toLowerCase()}:0`, 5n);
    const built = await buildUserOp(services, { account: ACCOUNT, calls: buyCalls, sponsor: true });
    expect(built.userOp.sender).toBe(ACCOUNT);
    expect(built.userOp.nonce).toBe(5n);
    expect(built.userOp.factory).toBeUndefined();
    expect(built.userOp.signature).toBe("0x");
    const decoded = decodeFunctionData({ abi: kernelAbi, data: built.userOp.callData });
    expect(decoded.functionName).toBe("execute");
    expect((decoded.args as [Hex, Hex])[0].startsWith("0x01")).toBe(true);
    expect(built.entryPoint.toLowerCase()).toBe("0x0000000071727de22e5e9d8baf0edac6f37da032");
    expect(built.chainId).toBe(4663);
  });

  test("the hash is the EntryPoint v0.7 userOpHash of the returned operation", async () => {
    const { services } = createTestServices();
    const built = await buildUserOp(services, { account: ACCOUNT, calls: buyCalls, sponsor: true });
    expect(built.userOpHash).toBe(hashOf(built.userOp, services));
    const tampered = { ...built.userOp, callGasLimit: built.userOp.callGasLimit + 1n };
    expect(hashOf(tampered, services)).not.toBe(built.userOpHash);
  });

  test("a single call uses the single-call mode", async () => {
    const { services } = createTestServices();
    const built = await buildUserOp(services, { account: ACCOUNT, calls: [buyCalls[1]!], sponsor: true });
    const decoded = decodeFunctionData({ abi: kernelAbi, data: built.userOp.callData });
    expect((decoded.args as [Hex, Hex])[0]).toBe(`0x${"00".repeat(32)}`);
  });

  test("gas limits come from the bundler estimate with a safety margin", async () => {
    const { services, mock } = createTestServices();
    const built = await buildUserOp(services, { account: ACCOUNT, calls: buyCalls, sponsor: true });
    expect(built.estimated).toBe(true);
    expect(built.userOp.callGasLimit).toBe(900_000n); // 400k + 500k headroom (keeper policy), not the bare x1.2 that reverted
    expect(built.userOp.verificationGasLimit).toBe(300_000n); // 250k x 1.2
    expect(built.userOp.preVerificationGas).toBe(66_000n); // 60k x 1.1
    expect(mock.estimated).toHaveLength(1); // one estimation call
    expect(mock.estimated[0]!.op.paymasterData!.length).toBe(2 + 77 * 2); // a full sponsor-signed stub
  });

  test("F25: a sponsored operation that cannot be simulated is refused, never signed over fallback limits", async () => {
    const { services } = createTestServices({ bundler: { failEstimate: true } });
    await expect(buildUserOp(services, { account: ACCOUNT, calls: buyCalls, sponsor: true })).rejects.toMatchObject({ status: 409, apiError: "SPONSOR_SIMULATION_FAILED" });
  });

  test("falls back to conservative limits when the bundler cannot estimate an unsponsored operation", async () => {
    const { services } = createTestServices({ bundler: { failEstimate: true } });
    const built = await buildUserOp(services, { account: ACCOUNT, calls: buyCalls, sponsor: false });
    expect(built.estimated).toBe(false);
    expect(built.userOp.callGasLimit).toBe(1_500_000n);
    expect(built.userOp.verificationGasLimit).toBe(700_000n);
    expect(built.userOp.paymasterVerificationGasLimit).toBeUndefined(); // unsponsored: no paymaster fields
  });

  test("fees come from the node with headroom, else from the configured fallback", async () => {
    const withNode = await buildUserOp(createTestServices().services, { account: ACCOUNT, calls: buyCalls, sponsor: false });
    expect(withNode.userOp.maxFeePerGas).toBe(1_250_000_000n);
    expect(withNode.userOp.maxPriorityFeePerGas).toBe(100_000_000n);
    const noNode = await buildUserOp(createTestServices({ chain: { fees: null } }).services, { account: ACCOUNT, calls: buyCalls, sponsor: false });
    expect(noNode.userOp.maxFeePerGas).toBe(2_000_000_000n);
    expect(noNode.userOp.maxPriorityFeePerGas).toBe(1_000_000_000n);
  });

  test("reports the worst-case gas cost", async () => {
    const { services } = createTestServices();
    const built = await buildUserOp(services, { account: ACCOUNT, calls: buyCalls, sponsor: true });
    expect(built.maxCostWei).toBe(maxCostOf(built.userOp));
    expect(built.maxCostWei > 0n).toBe(true);
  });

  test("a chain read failure is a 503, not a guess", async () => {
    const { services } = createTestServices({ chain: { down: true } });
    await expect(buildUserOp(services, { account: ACCOUNT, calls: buyCalls, sponsor: true })).rejects.toMatchObject({ status: 503, apiError: "CHAIN_UNAVAILABLE" });
  });
});

describe("new accounts", () => {
  test("an undeployed account needs its owner, and gets factory data for the same address", async () => {
    const { services, state } = createTestServices();
    state.deployed.clear();
    await expect(buildUserOp(services, { account: ACCOUNT, calls: buyCalls, sponsor: true })).rejects.toMatchObject({ status: 422, apiError: "OWNER_REQUIRED" });
    const built = await buildUserOp(services, { account: ACCOUNT, owner: OWNER, calls: buyCalls, sponsor: true });
    expect(built.deploysAccount).toBe(true);
    expect(built.userOp.factory?.toLowerCase()).toBe(services.config.kernelFactory.toLowerCase());
    expect(built.userOp.factoryData?.startsWith("0xea6d13ac")).toBe(true); // createAccount(bytes,bytes32)
    
    // Without an estimate, a deploying operation gets the larger verification fallback.
    const blind = createTestServices({ bundler: { failEstimate: true } });
    blind.state.deployed.clear();
    const fallback = await buildUserOp(blind.services, { account: ACCOUNT, owner: OWNER, calls: buyCalls, sponsor: false });
    expect(fallback.userOp.verificationGasLimit).toBe(1_800_000n);
  });

  test("the account address must be the Kernel address for that owner", async () => {
    const { services, state } = createTestServices({ chain: { predicted: "0x00000000000000000000000000000000000000ff" as Address } });
    state.deployed.clear();
    await expect(buildUserOp(services, { account: ACCOUNT, owner: OWNER, calls: buyCalls, sponsor: true })).rejects.toMatchObject({ apiError: "ACCOUNT_MISMATCH" });
  });

  test("salt index is a 32-byte big-endian number", () => {
    expect(kernelSalt(0)).toBe(`0x${"00".repeat(32)}`);
    expect(kernelSalt(258)).toBe(`0x${"00".repeat(30)}0102`);
  });
});

describe("nonces (R2 replay safety)", () => {
  test("the nonce is read live from the EntryPoint for the requested lane", async () => {
    const { services, state } = createTestServices();
    state.nonces.set(`${ACCOUNT.toLowerCase()}:0`, 9n);
    state.nonces.set(`${ACCOUNT.toLowerCase()}:3`, 2n);
    expect((await buildUserOp(services, { account: ACCOUNT, calls: buyCalls, sponsor: false })).userOp.nonce).toBe(9n);
    expect((await buildUserOp(services, { account: ACCOUNT, calls: buyCalls, sponsor: false, nonceLane: 3 })).userOp.nonce).toBe((3n << 64n) | 2n);
    await expect(buildUserOp(services, { account: ACCOUNT, calls: buyCalls, sponsor: false, nonceLane: 70_000 })).rejects.toBeInstanceOf(AaError);
  });

  test("after the first operation lands the next build uses the next nonce", async () => {
    const { services, state } = createTestServices();
    const first = await buildUserOp(services, { account: ACCOUNT, calls: buyCalls, sponsor: false });
    state.nonces.set(`${ACCOUNT.toLowerCase()}:0`, 1n);
    const second = await buildUserOp(services, { account: ACCOUNT, calls: buyCalls, sponsor: false });
    expect(second.userOp.nonce).toBe(first.userOp.nonce + 1n);
    expect(second.userOpHash).not.toBe(first.userOpHash);
  });
});

describe("sponsorship (R3 server side)", () => {
  test("a sponsored operation carries a paymaster signature over its final fields", async () => {
    const { services } = createTestServices();
    const built = await buildUserOp(services, { account: ACCOUNT, calls: buyCalls, sponsor: true });
    const op = built.userOp;
    expect(built.sponsored).toBe(true);
    expect(op.paymaster?.toLowerCase()).toBe(PAYMASTER);
    expect(op.paymasterData!.length).toBe(2 + 77 * 2);
    const validUntil = parseInt(op.paymasterData!.slice(2, 14), 16);
    const validAfter = parseInt(op.paymasterData!.slice(14, 26), 16);
    expect(validUntil).toBe(1_792_200_100 + 300);
    expect(built.validUntil).toBe(validUntil);
    const hash = paymasterHash(op, 4663, PAYMASTER, validUntil, validAfter);
    const sig = `0x${op.paymasterData!.slice(26)}` as Hex;
    expect(await recoverMessageAddress({ message: { raw: hash }, signature: sig })).toBe(privateKeyToAccount(SIGNER_KEY).address);
  });

  test("sponsor false, or no sponsor configured, means the account pays its own gas", async () => {
    const off = await buildUserOp(createTestServices().services, { account: ACCOUNT, calls: buyCalls, sponsor: false });
    expect(off.sponsored).toBe(false);
    expect(off.userOp.paymaster).toBeUndefined();
    const none = await buildUserOp(createTestServices({ sponsor: false }).services, { account: ACCOUNT, calls: buyCalls, sponsor: true });
    expect(none.sponsored).toBe(false);
    expect(none.userOp.paymaster).toBeUndefined();
  });

  test("calls outside the policy are refused rather than signed", async () => {
    const { services } = createTestServices();
    const stray = [{ to: "0x00000000000000000000000000000000000000aa" as Address, value: 0n, data: "0x11223344" as Hex }];
    await expect(buildUserOp(services, { account: ACCOUNT, calls: stray, sponsor: true })).rejects.toMatchObject({ status: 409, apiError: "NOT_SPONSORABLE" });
  });
});

describe("callsForIntent", () => {
  test("approvals first, then the engine call", () => {
    const calls = callsForIntent({
      kind: "buy", to: ENGINE, data: "0x12345678", approvals: [{ token: USDG, spender: ENGINE, amount: "1000000" }],
    });
    expect(calls).toHaveLength(2);
    expect(calls[0]!.to).toBe(USDG);
    expect(calls[0]!.data.startsWith("0x095ea7b3")).toBe(true);
    expect(calls[1]).toEqual({ to: ENGINE, value: 0n, data: "0x12345678" });
    expect(callsForIntent({ kind: "sell", to: ENGINE, data: "0x12345678", approvals: [] })).toHaveLength(1);
  });
});

describe("F38/F39 (decision 45): a sponsored operation stays under the paymaster's maxCostPerOp (0.002 ETH)", () => {
  const CAP = 2_000_000_000_000_000n;
  const big = {
    preVerificationGas: 300_000n, verificationGasLimit: 1_800_000n, callGasLimit: 1_500_000n,
    paymasterVerificationGasLimit: 200_000n, paymasterPostOpGasLimit: 80_000n,
  };

  test("the default fallback fee keeps a deploy operation with the fallback gas limits under the cap", async () => {
    const { loadAaConfig } = await import("./config");
    const config = loadAaConfig({});
    const fb = config.fallback;
    const gas = fb.preVerificationGas + fb.deployVerificationGas + fb.callGas + fb.paymasterVerificationGas + fb.paymasterPostOpGas;
    expect(gas * fb.maxFeePerGas).toBeLessThanOrEqual(CAP);
    expect(fb.priorityFeePerGas).toBeLessThanOrEqual(fb.maxFeePerGas);
    expect(() => loadAaConfig({ AA_FALLBACK_MAX_FEE_PER_GAS: "2000000000" })).toThrow(/maxCostPerOp/);
  });

  test("a sponsored deploy priced with the fallback fee (the node gave none) is capped, and re-signed over the capped fee", async () => {
    const { services, state } = createTestServices({ chain: { deployed: new Set(), fees: null }, bundler: { estimate: big } });
    void state;
    const built = await buildUserOp(services, { account: ACCOUNT, owner: OWNER, calls: buyCalls, sponsor: true });
    expect(built.sponsored).toBe(true);
    expect(built.deploysAccount).toBe(true);
    expect(built.maxCostWei).toBeLessThanOrEqual(CAP);
    expect(built.userOp.maxPriorityFeePerGas).toBeLessThanOrEqual(built.userOp.maxFeePerGas);
    // the signature covers the fee actually returned
    const data = built.userOp.paymasterData!;
    const validUntil = Number(BigInt(`0x${data.slice(2, 14)}`));
    const validAfter = Number(BigInt(`0x${data.slice(14, 26)}`));
    const hash = paymasterHash(built.userOp, 4663, PAYMASTER, validUntil, validAfter);
    expect(await recoverMessageAddress({ message: { raw: hash }, signature: `0x${data.slice(26)}` as Hex })).toBe(privateKeyToAccount(SIGNER_KEY).address);
  });

  test("when the network fee itself is above what the cap allows, nothing is signed", async () => {
    const { services } = createTestServices({ chain: { deployed: new Set(), fees: { maxFeePerGas: 5_000_000_000n, maxPriorityFeePerGas: 1n } }, bundler: { estimate: big } });
    await expect(buildUserOp(services, { account: ACCOUNT, owner: OWNER, calls: buyCalls, sponsor: true })).rejects.toMatchObject({ apiError: "SPONSOR_COST_CAP" });
  });
});
