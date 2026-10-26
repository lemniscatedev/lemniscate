import { encodeFunctionData, type Address } from "viem";
import { MarketHoursAbi, PriceGuardAbi } from "../../abi";
import { safeErrorSummary } from "../../log";
import type { KeeperContext } from "../context";

/** PriceGuard's "last good price" (the price CLOSED, UNKNOWN and HALTED sessions trade at) is only written by the
 * permissionless poke(). Nothing else calls it, so on the fork every weekend sell found no price and could only queue
 * (todo 23). This keeps it current: every stock whose live, fresh reading (REGULAR or EXTENDED) is newer than the stored
 * value is poked; nothing is sent when the stored value is current. Runs with the accrual job (every few minutes).
 *
 * R05: the halt latch (haltedSince) is also written only by poke(), and only while the clock says REGULAR or EXTENDED, so a
 * feed that stops in session is latched by nobody unless this job does it: a stock that reads HALTED (session 4) in a
 * REGULAR or EXTENDED session with no latch is poked at once. That starts the F21 CLOSED-price refusal and the ORC-4
 * settlement clock without depending on any outsider.
 *
 * R3-03: the decision reads the STORED latch (stockState().haltedSince), not the haltedSince() view. The view is the earlier
 * of the latch and a start derived from past calendar sessions, and the sessions job's push deletes those sessions; deciding
 * from the view left the latch unwritten while the derived start was visible, so a push erased the halt. A HALTED stock is
 * poked when it has no stored latch (in session, or out of session while a derived start is visible: poke stores that start
 * in any session) or when the derived start is earlier than the stored one.
 * R3-04: a live, fresh stock that still carries a stored latch (a transient in-session halt that ended without a new feed
 * round) is poked too, which clears the latch; a continuity-paused stock is left alone (poke would not clear it). */
export async function keepLastGoodPrices(context: Pick<KeeperContext, "clients" | "deployment" | "tx" | "logger" | "now" | "metadata">): Promise<{ poked: Address[]; failed: string[]; latched: Address[]; unread: Address[] }> {
  const marketHours = context.deployment.contracts.marketHours as Address | undefined;
  const nowSeconds = BigInt(Math.floor(context.now(await context.metadata()).getTime() / 1000));
  const priceGuard = context.deployment.contracts.priceGuard as Address;
  const stocks = context.deployment.stocks.map((entry) => entry.stock as Address);
  const reads = await context.clients.stateClient.multicall({
    allowFailure: true,
    contracts: [
      ...(marketHours ? [{ address: marketHours, abi: MarketHoursAbi, functionName: "kindAt", args: [nowSeconds] }] : []),
      ...stocks.flatMap((stock) => [
        { address: priceGuard, abi: PriceGuardAbi, functionName: "read", args: [stock] },
        { address: priceGuard, abi: PriceGuardAbi, functionName: "stockState", args: [stock] },
        { address: priceGuard, abi: PriceGuardAbi, functionName: "haltedSince", args: [stock] },
      ]),
    ] as never,
  }) as { status: "success" | "failure"; result?: unknown }[];
  const head = marketHours ? 1 : 0;
  const kind = marketHours && reads[0]?.status === "success" ? Number(reads[0].result) : undefined;
  const inSession = kind === 0 || kind === 1; // SessionKind.REGULAR, EXTENDED
  const poked: Address[] = [];
  const latched: Address[] = [];
  const failed: string[] = [];
  const unread: Address[] = [];
  for (const [index, stock] of stocks.entries()) {
    const read = reads[head + index * 3];
    const state = reads[head + index * 3 + 1];
    const since = reads[head + index * 3 + 2];
    if (read?.status !== "success" || state?.status !== "success" || since?.status !== "success") {
      unread.push(stock); // the sessions job will not push a calendar over a stock it could not check (R3-03 follow-up)
      if (read?.status !== "success" || state?.status !== "success") continue;
    }
    const r = read.result as { s: bigint; session: number; fresh: boolean; updatedAt: bigint };
    const st = state.result as { lastGoodS: bigint; lastGoodAt: bigint; contPaused: boolean; haltedSince: bigint | number };
    const stored = BigInt(st.haltedSince);
    const view = since?.status === "success" ? BigInt(since.result as bigint) : 0n;
    const live = Number(r.session) === 0 || Number(r.session) === 1;
    const halting = Number(r.session) === 4 && ((stored === 0n && (inSession || view !== 0n)) || (view !== 0n && view < stored));
    const clearing = !halting && live && r.fresh && r.s !== 0n && stored !== 0n && !st.contPaused;
    if (!halting && !clearing) {
      if (!live || !r.fresh || r.s === 0n) continue;
      if (BigInt(st.lastGoodS) !== 0n && BigInt(st.lastGoodAt) >= BigInt(r.updatedAt)) continue;
    }
    try {
      await context.tx.submit({ label: halting ? "prices:latch-halt" : "prices:poke", to: priceGuard, data: encodeFunctionData({ abi: PriceGuardAbi, functionName: "poke", args: [stock] }) });
      (halting ? latched : poked).push(stock);
      if (halting) context.logger.warn({ stock }, "Notice: a stock reads HALTED; stored its halt start so the F21 refusal and the settle clock cannot restart");
    } catch (error) {
      const summary = safeErrorSummary(error);
      if (/nonce .* (is held|is unresolved|remains held)|local signer is not configured|existing pending transaction/i.test(summary.message)) throw error;
      failed.push(`${stock}: ${summary.message}`);
      context.logger.warn({ stock, err: summary }, "PriceGuard poke failed");
    }
  }
  return { poked, failed, latched, unread };
}
