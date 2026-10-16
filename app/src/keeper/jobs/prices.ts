import { encodeFunctionData, type Address } from "viem";
import { PriceGuardAbi } from "../../abi";
import { safeErrorSummary } from "../../log";
import type { KeeperContext } from "../context";

/** PriceGuard's "last good price" (the price CLOSED, UNKNOWN and HALTED sessions trade at) is only written by the
 * permissionless poke(). Nothing else calls it, so on the fork every weekend sell found no price and could only queue
 * (todo 23). This keeps it current: every stock whose live, fresh reading (REGULAR or EXTENDED) is newer than the stored
 * value is poked; nothing is sent when the stored value is current. Runs with the accrual job (every few minutes). */
export async function keepLastGoodPrices(context: Pick<KeeperContext, "clients" | "deployment" | "tx" | "logger">): Promise<{ poked: Address[]; failed: string[] }> {
  const priceGuard = context.deployment.contracts.priceGuard as Address;
  const stocks = context.deployment.stocks.map((entry) => entry.stock as Address);
  const reads = await context.clients.stateClient.multicall({
    allowFailure: true,
    contracts: stocks.flatMap((stock) => [
      { address: priceGuard, abi: PriceGuardAbi, functionName: "read", args: [stock] },
      { address: priceGuard, abi: PriceGuardAbi, functionName: "lastGoodPrice", args: [stock] },
    ]) as never,
  }) as { status: "success" | "failure"; result?: unknown }[];
  const poked: Address[] = [];
  const failed: string[] = [];
  for (const [index, stock] of stocks.entries()) {
    const read = reads[index * 2];
    const last = reads[index * 2 + 1];
    if (read?.status !== "success" || last?.status !== "success") continue;
    const r = read.result as { s: bigint; session: number; fresh: boolean; updatedAt: bigint };
    const [lastS, lastAt] = last.result as readonly [bigint, bigint];
    const live = Number(r.session) === 0 || Number(r.session) === 1;
    if (!live || !r.fresh || r.s === 0n) continue;
    if (lastS !== 0n && BigInt(lastAt) >= BigInt(r.updatedAt)) continue;
    try {
      await context.tx.submit({ label: "prices:poke", to: priceGuard, data: encodeFunctionData({ abi: PriceGuardAbi, functionName: "poke", args: [stock] }) });
      poked.push(stock);
    } catch (error) {
      const summary = safeErrorSummary(error);
      if (/nonce .* (is held|is unresolved|remains held)|local signer is not configured|existing pending transaction/i.test(summary.message)) throw error;
      failed.push(`${stock}: ${summary.message}`);
      context.logger.warn({ stock, err: summary }, "PriceGuard poke failed");
    }
  }
  return { poked, failed };
}
