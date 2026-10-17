import { encodeFunctionData, type Address } from "viem";
import { OptionEngineAbi } from "../../abi";
import { safeErrorSummary } from "../../log";
import type { KeeperContext } from "../context";

/** Tickets tried per pass. A pass never sends more than this many fills, so a large or hostile queue cannot drain the
 * keeper's gas in one run; the rest follows on the next pass. */
export const QUEUED_SELLS_MAX_PER_PASS = 25;
/** After a ticket fails (not fillable yet, or a blocked payout) it is not retried for this long, so a few stuck tickets
 * cannot take every slot of every pass and starve fillable ones behind them. */
export const QUEUED_SELLS_RETRY_AFTER_MS = 10 * 60_000;

/** KEEP-5: fills every fillable queued sell. `fillQueued(ticket)` is permissionless and reverts when the series is not
 * sellable yet (still HALTED or CLOSED) or the payout is blocked; each ticket is its own transaction, so one bad
 * ticket never blocks the others (GEN-1). Open tickets come from the indexer's `queued_sells` table; the chain is the
 * judge, a revert just leaves the ticket for a later pass. */
export function createQueuedSellsJob(context: KeeperContext, maxPerPass = QUEUED_SELLS_MAX_PER_PASS) {
  const engine = context.deployment.contracts.engine as Address;
  const retryAt = new Map<string, number>();
  return async (): Promise<Record<string, unknown>> => {
    const nowMs = context.now(await context.metadata()).getTime();
    // Oldest first, so a ticket that has waited longest is tried first.
    const rows = await context.sql<{ ticket: string }[]>`
      select ticket::text as ticket from queued_sells where status = 'open' order by ticket asc limit ${maxPerPass * 8}`;
    const open = new Set(rows.map((row) => row.ticket));
    for (const ticket of retryAt.keys()) if (!open.has(ticket)) retryAt.delete(ticket);
    const candidates = rows.map((row) => row.ticket).filter((ticket) => (retryAt.get(ticket) ?? 0) <= nowMs);
    const batch = candidates.slice(0, maxPerPass);
    let filled = 0;
    let simulated = false;
    const failed: { ticket: string; error: string }[] = [];
    for (const ticket of batch) {
      try {
        const result = await context.tx.submit({
          label: "queued-sells", to: engine,
          data: encodeFunctionData({ abi: OptionEngineAbi, functionName: "fillQueued", args: [BigInt(ticket)] }),
        });
        simulated ||= result.simulated;
        filled++;
        retryAt.delete(ticket);
      } catch (error) {
        const summary = safeErrorSummary(error);
        // A held nonce or a missing signer is not the ticket's fault: stop and let the scheduler retry the whole pass.
        if (/nonce .* (is held|is unresolved|remains held)|local signer is not configured|existing pending transaction/i.test(summary.message)) throw error;
        retryAt.set(ticket, nowMs + QUEUED_SELLS_RETRY_AFTER_MS);
        failed.push({ ticket, error: summary.message.slice(0, 160) });
      }
    }
    if (failed.length) context.logger.info({ failed: failed.length, first: failed[0] }, "Queued sells not fillable yet; retried later");
    return { open: rows.length, attempted: batch.length, filled, notFillable: failed.length, deferred: candidates.length - batch.length, dryRun: simulated };
  };
}
