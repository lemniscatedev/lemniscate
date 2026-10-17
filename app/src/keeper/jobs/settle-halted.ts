import { encodeFunctionData, type Address } from "viem";
import { OptionEngineAbi, PriceGuardAbi } from "../../abi";
import { safeErrorSummary } from "../../log";
import type { KeeperContext } from "../context";

/** EngineCore.DEFAULT_SETTLE_DELAY: a stock HALTED this long may be settled (guards.haltSettleDelay 0 = this). */
export const DEFAULT_SETTLE_DELAY_SECONDS = 7 * 86_400;
/** A stock whose settleHalted reverted is not tried again for this long (the chain is the judge; no retry storm). */
export const SETTLE_RETRY_AFTER_SECONDS = 3_600;
const SESSION_HALTED = 4;
const HELD_QUEUE = /nonce .* (is held|is unresolved|remains held)|local signer is not configured|existing pending transaction/i;

type Settled = { status: "success" | "failure"; result?: unknown };

/** ORC-4 (review F07/F21, decision 31): once a stock's feed has read HALTED for the engine's settle delay (latched by
 * PriceGuard.poke), the permissionless engine.settleHalted(stock) lets its sells and queued sells go through at the last
 * good price instead of waiting for a feed that is gone. This job sends it for every deployed stock that qualifies and
 * is not settled yet, logs a notice for each (the API shows the same notice from the indexed halt latch), and reports
 * the halted names that are not settleable yet with the time they become so. A revert backs that stock off for an hour. */
export function createSettleHaltedJob(context: KeeperContext) {
  const engine = context.deployment.contracts.engine as Address;
  const priceGuard = context.deployment.contracts.priceGuard as Address;
  const retryAt = new Map<string, number>();
  return async (): Promise<Record<string, unknown>> => {
    const nowSeconds = Math.floor(context.now(await context.metadata()).getTime() / 1000);
    const stocks = context.deployment.stocks.map((entry) => ({ name: entry.name, stock: entry.stock as Address }));
    const reads = await context.clients.stateClient.multicall({
      allowFailure: true,
      contracts: [
        { address: engine, abi: OptionEngineAbi, functionName: "guards" },
        ...stocks.flatMap(({ stock }) => [
          { address: priceGuard, abi: PriceGuardAbi, functionName: "haltedSince", args: [stock] },
          { address: priceGuard, abi: PriceGuardAbi, functionName: "readLite", args: [stock] },
          { address: engine, abi: OptionEngineAbi, functionName: "settlePrice", args: [stock] },
        ]),
      ] as never,
    }) as Settled[];
    const guards = reads[0]?.status === "success" ? reads[0].result as readonly [bigint, number, number] : undefined;
    const delay = Number(guards?.[2] ?? 0) || DEFAULT_SETTLE_DELAY_SECONDS;

    const settled: string[] = [];
    const failed: { name: string; error: string }[] = [];
    const halted: { name: string; since: string; settleableAt: string }[] = [];
    let simulated = false;
    for (const [index, { name, stock }] of stocks.entries()) {
      const [since, price, settle] = [reads[1 + index * 3], reads[2 + index * 3], reads[3 + index * 3]];
      if (since?.status !== "success" || price?.status !== "success" || settle?.status !== "success") continue;
      const haltedSince = Number(since.result);
      const session = Number((price.result as { session: number }).session);
      if (!haltedSince || session !== SESSION_HALTED || BigInt(settle.result as bigint) !== 0n) continue;
      const settleableAt = haltedSince + delay;
      if (nowSeconds < settleableAt) {
        halted.push({ name, since: new Date(haltedSince * 1000).toISOString(), settleableAt: new Date(settleableAt * 1000).toISOString() });
        continue;
      }
      if ((retryAt.get(stock) ?? 0) > nowSeconds) continue;
      try {
        const result = await context.tx.submit({
          label: "settle-halted", to: engine,
          data: encodeFunctionData({ abi: OptionEngineAbi, functionName: "settleHalted", args: [stock] }),
        });
        simulated ||= result.simulated;
        settled.push(name);
        retryAt.delete(stock);
        context.logger.warn({ name, stock, haltedSince: new Date(haltedSince * 1000).toISOString() },
          "Notice: settled a stock whose feed stayed HALTED past the settle delay; its sells now price as CLOSED at the last good price");
      } catch (error) {
        const summary = safeErrorSummary(error);
        if (HELD_QUEUE.test(summary.message)) throw error;
        retryAt.set(stock, nowSeconds + SETTLE_RETRY_AFTER_SECONDS);
        failed.push({ name, error: summary.message.slice(0, 160) });
        context.logger.warn({ name, err: summary }, "settleHalted reverted; backing off this stock for an hour");
      }
    }
    if (halted.length) context.logger.info({ halted }, "Halted names waiting for the ORC-4 settle delay");
    return { settled, failed, halted, settleDelaySeconds: delay, dryRun: simulated };
  };
}
