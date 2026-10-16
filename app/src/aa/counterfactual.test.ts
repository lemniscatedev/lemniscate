import { describe, expect, test } from "bun:test";
import { KERNEL_V33_FACTORY, KERNEL_ECDSA_VALIDATOR } from "./config";
import { KERNEL_V33_IMPLEMENTATION, predictKernelAddressOffline } from "./counterfactual";

const deployment = { factory: KERNEL_V33_FACTORY as `0x${string}`, validator: KERNEL_ECDSA_VALIDATOR as `0x${string}`, implementation: KERNEL_V33_IMPLEMENTATION as `0x${string}` };
const OWNER = "0x1111111111111111111111111111111111111111";

describe("smart account address without RPC (15b R3)", () => {
  test("matches KernelFactory.getAddress on Robinhood Chain (cast call, 2026-10-16)", () => {
    // cast call 0x2577...F2E9 "getAddress(bytes,bytes32)(address)" <kernelInitData(validator, owner)> 0x00..00
    expect(predictKernelAddressOffline(deployment, OWNER, 0).toLowerCase()).toBe("0x982c0f3eed3c6ffcc05065190257f288774b92e4");
  });
  test("the index and the owner change the address; the owner's case does not", () => {
    const zero = predictKernelAddressOffline(deployment, OWNER, 0);
    expect(predictKernelAddressOffline(deployment, OWNER, 1)).not.toBe(zero);
    expect(predictKernelAddressOffline(deployment, "0x2222222222222222222222222222222222222222", 0)).not.toBe(zero);
    expect(predictKernelAddressOffline(deployment, OWNER.toUpperCase().replace("0X", "0x") as `0x${string}`, 0)).toBe(zero);
  });
  test("rejects a bad owner or index", () => {
    expect(() => predictKernelAddressOffline(deployment, "0x12" as `0x${string}`)).toThrow();
    expect(() => predictKernelAddressOffline(deployment, OWNER, -1)).toThrow();
  });
});
