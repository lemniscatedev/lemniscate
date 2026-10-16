import { describe, expect, test } from "bun:test";
import { decodeAbiParameters, decodeFunctionData, hexToBytes, recoverAddress, type Address, type Hex } from "viem";
import {
  DUMMY_ACCOUNT_SIGNATURE, MODE_BATCH, MODE_SINGLE, approveCall, encodeKernelExecute, kernelAbi, kernelFactoryData,
  kernelFactoryAbi, kernelInitData, kernelNonceKey, type Call,
} from "./kernel";
import { KERNEL_ECDSA_VALIDATOR } from "./config";

const A = "0x00000000000000000000000000000000000000a1" as Address;
const B = "0x00000000000000000000000000000000000000b2" as Address;

describe("kernel encoders", () => {
  test("single call is packed as target | value | data under mode 0x00", () => {
    const call: Call = { to: A, value: 0n, data: "0x11223344" };
    const decoded = decodeFunctionData({ abi: kernelAbi, data: encodeKernelExecute([call]) });
    expect(decoded.functionName).toBe("execute");
    const [mode, exec] = decoded.args as [Hex, Hex];
    expect(mode).toBe(MODE_SINGLE);
    expect(exec).toBe(`0x${A.slice(2)}${"00".repeat(32)}11223344`);
  });

  test("two calls are an abi-encoded Execution[] under mode 0x01", () => {
    const calls: Call[] = [approveCall(A, B, 123n), { to: B, value: 0n, data: "0xdeadbeef" }];
    const decoded = decodeFunctionData({ abi: kernelAbi, data: encodeKernelExecute(calls) });
    const [mode, exec] = decoded.args as [Hex, Hex];
    expect(mode).toBe(MODE_BATCH);
    const [list] = decodeAbiParameters(
      [{ type: "tuple[]", components: [{ type: "address", name: "target" }, { type: "uint256", name: "value" }, { type: "bytes", name: "callData" }] }],
      exec,
    );
    expect(list.map((c) => c.target.toLowerCase())).toEqual([A, B]);
    expect(list[1]!.callData).toBe("0xdeadbeef");
  });

  test("no calls is refused", () => {
    expect(() => encodeKernelExecute([])).toThrow();
  });

  test("nonce lanes are the low 16 bits of the root-validator key", () => {
    expect(kernelNonceKey()).toBe(0n);
    expect(kernelNonceKey(7)).toBe(7n);
    expect(() => kernelNonceKey(65_536)).toThrow();
    expect(() => kernelNonceKey(-1)).toThrow();
  });

  test("account creation data: ECDSA validator is the root, owner is the validator data, no hook", () => {
    const owner = "0x00000000000000000000000000000000000000c3" as Address;
    const init = decodeFunctionData({ abi: kernelAbi, data: kernelInitData(KERNEL_ECDSA_VALIDATOR as Address, owner) });
    const [root, hook, validatorData, hookData, config] = init.args as [Hex, Address, Hex, Hex, Hex[]];
    expect(root.toLowerCase()).toBe(`0x01${KERNEL_ECDSA_VALIDATOR.slice(2).toLowerCase()}`);
    expect(hook).toBe("0x0000000000000000000000000000000000000001");
    expect(validatorData.toLowerCase()).toBe(owner);
    expect(hookData).toBe("0x");
    expect(config).toEqual([]);
    const factory = decodeFunctionData({ abi: kernelFactoryAbi, data: kernelFactoryData(KERNEL_ECDSA_VALIDATOR as Address, owner, `0x${"00".repeat(32)}`) });
    expect(factory.functionName).toBe("createAccount");
  });

  test("the estimation signature is a well-formed, recoverable 65-byte signature", async () => {
    expect(hexToBytes(DUMMY_ACCOUNT_SIGNATURE).length).toBe(65);
    const who = await recoverAddress({ hash: `0x${"11".repeat(32)}`, signature: DUMMY_ACCOUNT_SIGNATURE });
    expect(who).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });
});
