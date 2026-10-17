import { encodeFunctionData, parseAbi, type Address } from "viem";
import type { KeeperContext } from "../context";

export const FeeRouterAbi = parseAbi([
  "function distribute() returns (uint256 amount)",
  "function nextDistributionAt() view returns (uint256)",
  "function distributable() view returns (uint256)",
]);

/** KEEP-5: calls `FeeRouter.distribute()` once its period has passed and there is something to split. The call is
 * permissionless and reverts with TooEarly before then, so the keeper checks `nextDistributionAt` against chain time
 * first and sends nothing otherwise. */
export function createFeeDistributeJob(context: KeeperContext) {
  const feeRouter = context.deployment.contracts.feeRouter as Address | undefined;
  return async (): Promise<Record<string, unknown>> => {
    if (!feeRouter) return { idle: true, reason: "no feeRouter in the deployment" };
    const nowSeconds = BigInt(Math.floor(context.now(await context.metadata()).getTime() / 1000));
    const next = await context.clients.stateClient.readContract({ address: feeRouter, abi: FeeRouterAbi, functionName: "nextDistributionAt" }) as bigint;
    if (nowSeconds < next) return { idle: true, nextDistributionAt: Number(next) };
    const amount = await context.clients.stateClient.readContract({ address: feeRouter, abi: FeeRouterAbi, functionName: "distributable" }) as bigint;
    if (amount === 0n) return { idle: true, due: true, distributable: "0" };
    const result = await context.tx.submit({
      label: "fee-distribute", to: feeRouter,
      data: encodeFunctionData({ abi: FeeRouterAbi, functionName: "distribute" }),
    });
    return { idle: false, distributable: amount.toString(), dryRun: result.simulated };
  };
}
