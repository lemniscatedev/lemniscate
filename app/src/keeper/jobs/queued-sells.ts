import { encodeFunctionData, type Address } from "viem";
import { OptionEngineAbi, PriceGuardAbi } from "../../abi";
import { revertNameOf } from "../../chain/revert";
import { safeErrorSummary } from "../../log";
import type { KeeperContext } from "../context";

/** Tickets tried per pass. A pass never sends more than this many fills, so a large or hostile queue cannot drain the
 * keeper's gas in one run; the rest follows on the next pass. */
export const QUEUED_SELLS_MAX_PER_PASS = 25;
/** After a ticket fails (not fillable yet, or a blocked payout) it is not retried for this long, so a few stuck tickets
 * cannot take every slot of every pass and starve fillable ones behind them. */
export const QUEUED_SELLS_RETRY_AFTER_MS = 10 * 60_000;
/** Review F22/F23: a ticket keeps the seller's minProceeds and `fillQueued` reverts with Slippage below it. That says
 * "not fillable at this price" about that ticket only (the series is fine), so it backs off alone, starting at
 * QUEUED_SELLS_RETRY_AFTER_MS and doubling per further miss up to this cap: a far-off minimum is never retry-spammed. */
export const QUEUED_SELLS_SLIPPAGE_MAX_BACKOFF_MS = 6 * 3600_000;
/** R14: one seller may have this many tickets per series tried in a pass, and fewer once one of that seller's tickets on the
 * series has failed and is backing off. A seller who queues many tickets that cannot fill then cannot hold the head of the
 * series against everyone queued after (an honest ticket waits behind at most this many per seller, not behind all of them). */
export const QUEUED_SELLS_PER_SELLER_PER_SERIES = 4;
export const QUEUED_SELLS_FLAGGED_PER_SELLER_PER_SERIES = 2;
const SESSION_HALTED = 4;

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
  /** Consecutive misses per ticket (drives its doubling back-off). */
  const slipped = new Map<string, number>();
  return async (): Promise<Record<string, unknown>> => {
    const nowMs = context.now(await context.metadata()).getTime();
    for (const [ticket, at] of retryAt) if (at <= nowMs) retryAt.delete(ticket);
    const backingOff = [...retryAt.keys()];
    const dustUsdg = Number(context.config.KEEPER_QUEUED_DUST_USDG ?? 0.01);
    // R14: a stock whose feed is HALTED and not settled cannot fill (fillQueued needs a sellable session): its tickets are not
    // tried, and, left out of the SQL, they do not take slots of the window either. This is read from the chain, never guessed
    // from an error text.
    const halted = await haltedStocks(context).catch((error: unknown) => {
      context.logger.warn({ err: safeErrorSummary(error) }, "Could not read the stocks' sessions; trying every open ticket this pass");
      return [] as string[];
    });
    const rows = await context.sql<OpenTicket[]>`
      with open as (
        select o.ticket, o.series_id, o.seller, o.queued_at,
               (o.tokens * coalesce(s.norm, 1) * coalesce(nh.v_mark, 1000000000)) < ${dustUsdg} as dust,
               exists (select 1 from queued_sells f where f.series_id = o.series_id and f.seller = o.seller and f.status = 'open'
                         and f.ticket::text = any(string_to_array(${backingOff.join(",")}, ','))) as flagged
        from queued_sells o
        left join series s on s.id = o.series_id
        left join lateral (select v_mark from norm_history h where h.series_id = o.series_id order by h.ts desc limit 1) nh on true
        where o.status = 'open' and o.ticket::text <> all(string_to_array(${backingOff.join(",")}, ','))
          and o.series_id not in (select id from series where lower(stock_token) = any(string_to_array(${halted.join(",")}, ',')))
      ), capped as (
        select *, row_number() over (partition by series_id, seller order by dust, ticket) as seller_rank from open
      ), kept as (
        select *, row_number() over (partition by series_id order by ticket) as rn from capped
        where seller_rank <= case when flagged then ${QUEUED_SELLS_FLAGGED_PER_SELLER_PER_SERIES}::int else ${QUEUED_SELLS_PER_SELLER_PER_SERIES}::int end
      )
      select ticket::text as ticket, series_id, queued_at, dust from kept
      order by dust, rn, ticket
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
    let belowMinimum = 0;
    for (const { ticket } of batch) {
      attempted++;
      try {
        const result = await context.tx.submit({
          label: "queued-sells", to: engine,
          data: encodeFunctionData({ abi: OptionEngineAbi, functionName: "fillQueued", args: [BigInt(ticket)] }),
        });
        simulated ||= result.simulated;
        filled++;
        retryAt.delete(ticket);
        slipped.delete(ticket);
      } catch (error) {
        const summary = safeErrorSummary(error);
        // A held nonce or a missing signer is not the ticket's fault: stop and let the scheduler retry the whole pass.
        if (/nonce .* (is held|is unresolved|remains held)|local signer is not configured|existing pending transaction/i.test(summary.message)) throw error;
        // R14: whatever the reason, it is this ticket's: it backs off alone and doubles on every further miss. A revert is no
        // proof about the rest of the series (the stocks that cannot fill at all were left out above), so the series is never
        // written off for the pass; the failed simulation costs the keeper no gas, and the per-seller cap above bounds how many
        // of one seller's tickets are tried.
        const misses = (slipped.get(ticket) ?? 0) + 1;
        slipped.set(ticket, misses);
        retryAt.set(ticket, nowMs + Math.min(QUEUED_SELLS_SLIPPAGE_MAX_BACKOFF_MS, QUEUED_SELLS_RETRY_AFTER_MS * 2 ** (misses - 1)));
        if (revertNameOf(error) === "Slippage") belowMinimum++;
        failed.push({ ticket, error: summary.message.slice(0, 160) });
      }
    }
    // Bounded memory: a ticket filled or cancelled elsewhere is forgotten once the map grows large.
    if (slipped.size > 10_000) for (const ticket of slipped.keys()) if (!retryAt.has(ticket)) slipped.delete(ticket);
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
      open: rows.length, attempted, filled, notFillable: failed.length, belowMinimum, deferred: candidates.length - attempted,
      dust: dust.length, oldestOpenMinutes: oldestMinutes, dryRun: simulated,
    };
  };
}

/** Lower-case stock tokens whose price guard session is HALTED and that the engine has not settled (ORC-4). */
async function haltedStocks(context: Pick<KeeperContext, "clients" | "deployment">): Promise<string[]> {
  const priceGuard = context.deployment.contracts.priceGuard as Address;
  const engine = context.deployment.contracts.engine as Address;
  const stocks = context.deployment.stocks.map((entry) => entry.stock as Address);
  if (!stocks.length) return [];
  const reads = await context.clients.stateClient.multicall({
    allowFailure: true,
    contracts: stocks.flatMap((stock) => [
      { address: priceGuard, abi: PriceGuardAbi, functionName: "readLite", args: [stock] },
      { address: engine, abi: OptionEngineAbi, functionName: "settlePrice", args: [stock] },
    ]) as never,
  }) as { status: "success" | "failure"; result?: unknown }[];
  return stocks.filter((_, index) => {
    const price = reads[index * 2];
    const settled = reads[index * 2 + 1];
    return price?.status === "success" && Number((price.result as { session: number }).session) === SESSION_HALTED
      && settled?.status === "success" && BigInt(settled.result as bigint) === 0n;
  }).map((stock) => stock.toLowerCase());
}
