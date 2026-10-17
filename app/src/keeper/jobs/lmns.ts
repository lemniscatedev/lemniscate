import { encodeFunctionData, parseAbi, type Address } from "viem";
import { Erc20Abi } from "../../abi";
import type { KeeperContext } from "../context";

export const LmnsStakingKeeperAbi = parseAbi(["function syncLoss()"]);
export const LmnsBuyBurnKeeperAbi = parseAbi(["function buyAndBurn(uint256 maxUsdg) returns (uint256 burned)"]);

/** Default USDG (whole) per buyAndBurn call; the contract also caps it at maxUsdgPerCall (1,000 at launch). */
export const DEFAULT_BUY_BURN_MAX_USDG = 1_000;

/** Review F19 (decision 42): LmnsStaking.syncLoss() moves the LMNS that covers the pool's counted loss out of the share
 * price (lockedForPool), or releases it on recovery. Permissionless; the keeper calls it hourly while staking is
 * configured (deployment contracts.staking). Without staking the job is idle. */
export function createStakingSyncJob(context: KeeperContext) {
  return async (): Promise<Record<string, unknown>> => {
    const staking = (context.deployment.contracts as { staking?: string }).staking as Address | undefined;
    if (!staking) return { idle: true, reason: "staking is not configured" };
    const result = await context.tx.submit({
      label: "staking-sync", to: staking, data: encodeFunctionData({ abi: LmnsStakingKeeperAbi, functionName: "syncLoss" }),
    });
    return { idle: false, dryRun: result.simulated };
  };
}

/** Review F37 (decision 43): LmnsBuyBurn.buyAndBurn is keeper-only and capped per call; it buys only while the LMNS
 * pool's spot is within 50 bps of its TWAP (otherwise it returns 0 and keeps the USDG). The keeper calls it hourly when
 * the job is enabled and the deployment names the contract (contracts.buyBurn), and only when it holds USDG. */
export function createBuyBurnJob(context: KeeperContext) {
  return async (): Promise<Record<string, unknown>> => {
    const buyBurn = (context.deployment.contracts as { buyBurn?: string }).buyBurn as Address | undefined;
    if (!buyBurn) return { idle: true, reason: "buy-and-burn is not configured" };
    const held = await context.clients.stateClient.readContract({
      address: context.deployment.contracts.usdg as Address, abi: Erc20Abi, functionName: "balanceOf", args: [buyBurn],
    }) as bigint;
    if (held === 0n) return { idle: true, reason: "nothing to burn" };
    const maxUsdg = BigInt(Math.floor(Number(context.config.KEEPER_BUY_BURN_MAX_USDG ?? DEFAULT_BUY_BURN_MAX_USDG) * 1e6));
    const result = await context.tx.submit({
      label: "buy-burn", to: buyBurn,
      data: encodeFunctionData({ abi: LmnsBuyBurnKeeperAbi, functionName: "buyAndBurn", args: [maxUsdg < held ? maxUsdg : held] }),
    });
    return { idle: false, heldUsdg: held.toString(), dryRun: result.simulated };
  };
}
