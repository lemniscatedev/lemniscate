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
/** At most this many dust tickets (worth less than KEEPER_QUEUED_DUST_USDG) are filled per pass, and only with spare capacity. */
export const QUEUED_SELLS_DUST_PER_PASS = 1;

interface OpenTicket { ticket: string; series_id?: string; dust?: boolean; queued_at?: Date | string | null }

/** KEEP-5: fills every fillable queued sell. `fillQueued(ticket)` is permissionless and reverts when the series is not
 * sellable yet (still HALTED or CLOSED) or the payout is blocked; each ticket is its own transaction, so one bad
 * ticket never blocks the others (GEN-1). Open tickets come from the indexer's `queued_sells` table; the chain is the
 * judge, a revert just leaves the ticket for a later pass.
 *
 * Selection (F29/F36): tickets in their retry back-off are excluded in SQL, so the window can never be filled with the
 * ones that cannot fill; the rest are taken round-robin across series (rank within the series, then ticket), so one dead
 * name or one flood of tickets on one series cannot starve the others; dust tickets come last, one per pass. */
export function createQueuedSellsJob(context: KeeperContext, maxPerPass = QUEUED_SELLS_MAX_PER_PASS) {
  const engine = context.deployment.contracts.engine as Address;
  const retryAt = new Map<string, number>();
  return async (): Promise<Record<string, unknown>> => {
    const nowMs = context.now(await context.metadata()).getTime();
    for (const [ticket, at] of retryAt) if (at <= nowMs) retryAt.delete(ticket);
    const backingOff = [...retryAt.keys()];
    const dustUsdg = Number(context.config.KEEPER_QUEUED_DUST_USDG ?? 0.01);
    const rows = await context.sql<OpenTicket[]>`
      select q.ticket::text as ticket, q.series_id, q.queued_at,
             (q.tokens * coalesce(s.norm, 1) * coalesce(nh.v_mark, 1000000000)) < ${dustUsdg} as dust
      from (
        select ticket, series_id, tokens, queued_at,
               row_number() over (partition by series_id order by ticket) as rn
        from queued_sells
        where status = 'open' and ticket::text <> all(string_to_array(${backingOff.join(",")}, ','))
      ) q
      left join series s on s.id = q.series_id
      left join lateral (select v_mark from norm_history h where h.series_id = q.series_id order by h.ts desc limit 1) nh on true
      order by dust, q.rn, q.ticket
      limit ${maxPerPass * 8}`;
    const candidates = [...rows];
    const real = candidates.filter((row) => !row.dust).slice(0, maxPerPass);
    const spare = maxPerPass - real.length;
    const dust = candidates.filter((row) => row.dust).slice(0, Math.min(spare, QUEUED_SELLS_DUST_PER_PASS));
    const batch = [...real, ...dust];

    let filled = 0;
    let attempted = 0;
    let simulated = false;
    const failed: { ticket: string; error: string }[] = [];
    const deadSeries = new Set<string>();
    for (const { ticket, series_id: seriesId } of batch) {
      // One revert on a series (HALTED, CLOSED) says the rest of its tickets will revert too: try them on a later pass.
      if (seriesId && deadSeries.has(seriesId)) continue;
      attempted++;
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
        if (seriesId) deadSeries.add(seriesId);
        failed.push({ ticket, error: summary.message.slice(0, 160) });
      }
    }
    if (failed.length) context.logger.info({ failed: failed.length, first: failed[0] }, "Queued sells not fillable yet; retried later");

    // An escrowed seller keeps paying funding while a ticket waits: say so when the oldest open ticket gets old.
    const oldestRows = await context.sql<{ oldest: Date | string | null }[]>`
      select min(queued_at) as oldest from queued_sells where status = 'open'`;
    const oldest = oldestRows?.[0]?.oldest ? new Date(oldestRows[0].oldest).getTime() : undefined;
    const oldestMinutes = oldest ? Math.floor((nowMs - oldest) / 60_000) : 0;
    if (oldestMinutes >= Number(context.config.KEEPER_QUEUED_ALERT_MINUTES ?? 60)) {
      context.logger.warn({ oldestMinutes, backingOff: backingOff.length }, "A queued sell has been waiting for a long time");
    }
    return {
      open: rows.length, attempted, filled, notFillable: failed.length, deferred: candidates.length - attempted,
      dust: dust.length, oldestOpenMinutes: oldestMinutes, dryRun: simulated,
    };
  };
}
