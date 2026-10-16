import type { ChainEvent, IndexerContext } from "../types";
import { speedName, tauSeconds, wad } from "../units";
import { addr, id32, iso } from "./common";

/** Recomputes buyable / archived from the flag log, so a replay or a rollback always converges to the same value. */
export async function recomputeSeriesFlags(context: IndexerContext, seriesId: string): Promise<void> {
  await context.tx`
    UPDATE series SET
      buyable = COALESCE((SELECT value FROM series_flag_log WHERE series_id = ${seriesId} AND kind = 'buyable'
                          ORDER BY block DESC, log_index DESC LIMIT 1), false),
      archived = COALESCE((SELECT value FROM series_flag_log WHERE series_id = ${seriesId} AND kind = 'archived'
                           ORDER BY block DESC, log_index DESC LIMIT 1), false)
    WHERE id = ${seriesId}
  `;
}

async function logFlag(context: IndexerContext, event: ChainEvent, seriesId: string, kind: "buyable" | "archived", value: boolean): Promise<void> {
  await context.tx`
    INSERT INTO series_flag_log (tx_hash, log_index, block, ts, series_id, kind, value)
    VALUES (${event.txHash}, ${event.logIndex}, ${event.blockNumber.toString()}, ${iso(event.ts)}, ${seriesId}, ${kind}, ${value})
    ON CONFLICT (tx_hash, log_index, kind) DO NOTHING
  `;
}

export async function handleRegistryEvent(context: IndexerContext, event: ChainEvent): Promise<void> {
  switch (event.eventName) {
    case "SeriesListed": {
      const id = id32(event, "id");
      const stock = addr(event, "stock");
      const token = addr(event, "token");
      const speed = speedName(event.args.speed);
      await context.tx`
        INSERT INTO series (id, stock_token, name, feed, is_call, speed, tau_s, strike, token, norm, last_accrual,
                            buyable, archived, listed_at, listed_block, listed_tx, listed_log)
        VALUES (
          ${id}, ${stock}, ${context.stockNames.get(stock) ?? null}, ${context.stockFeeds.get(stock) ?? null},
          ${Boolean(event.args.isCall)}, ${speed}, ${tauSeconds(speed)}, ${wad(event.args.strike)}, ${token},
          1, ${iso(event.ts)}, false, false, ${iso(event.ts)}, ${event.blockNumber.toString()}, ${event.txHash}, ${event.logIndex}
        )
        ON CONFLICT (id) DO NOTHING
      `;
      context.newSeries.push({ id, token, stock });
      context.seriesByToken.set(token, { id, token, stock });
      context.seriesRefreshNeeded = true;
      context.kinds.add("series");
      return;
    }
    case "SeriesBuyableSet": {
      const id = id32(event, "id");
      await logFlag(context, event, id, "buyable", Boolean(event.args.buyable));
      await recomputeSeriesFlags(context, id);
      context.kinds.add("series");
      return;
    }
    case "SeriesArchived": {
      const id = id32(event, "id");
      await logFlag(context, event, id, "archived", true);
      await logFlag(context, event, id, "buyable", false);
      await recomputeSeriesFlags(context, id);
      context.kinds.add("series");
      return;
    }
    default:
      return;
  }
}
