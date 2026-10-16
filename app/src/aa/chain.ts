import { createPublicClient, http, type Address, type Hex } from "viem";
import { entryPoint07Abi } from "viem/account-abstraction";
import { kernelFactoryAbi } from "./kernel";

/** Read-only chain access the builder needs. Tests replace it; production uses a viem public client. */
export interface AaChain {
  isDeployed(account: Address): Promise<boolean>;
  entryPointNonce(entryPoint: Address, sender: Address, key: bigint): Promise<bigint>;
  predictKernelAddress(factory: Address, initData: Hex, salt: Hex): Promise<Address>;
  /** null when the node cannot say; the builder then uses its configured fallback. */
  feesPerGas(): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint } | null>;
}

export function createViemAaChain(rpcUrl: string): AaChain {
  const client = createPublicClient({ transport: http(rpcUrl, { retryCount: 2, retryDelay: 400, timeout: 8_000 }) });
  return {
    async isDeployed(account) {
      const code = await client.getCode({ address: account });
      return code !== undefined && code !== "0x";
    },
    async entryPointNonce(entryPoint, sender, key) {
      return await client.readContract({ address: entryPoint, abi: entryPoint07Abi, functionName: "getNonce", args: [sender, key] });
    },
    async predictKernelAddress(factory, initData, salt) {
      return await client.readContract({ address: factory, abi: kernelFactoryAbi, functionName: "getAddress", args: [initData, salt] });
    },
    async feesPerGas() {
      try {
        const fees = await client.estimateFeesPerGas();
        if (fees.maxFeePerGas === undefined || fees.maxPriorityFeePerGas === undefined) return null;
        return { maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas };
      } catch {
        return null;
      }
    },
  };
}
