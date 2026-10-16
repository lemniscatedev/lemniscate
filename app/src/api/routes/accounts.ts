import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import type { ApiDependencies } from "../types";
import { apiNow } from "../clock";
import { accountParams, positionsResponseSchema } from "../option-schemas";
import { loadNameContext, marketInputs, type NameContext } from "../quote/context";
import { displayCost, looseWad, normDecimal, projectedNorm, quoteUnits, usdgMicro, usdgText } from "../quote/model";
import { trimDecimal } from "../quote/rows";
import { accountPositions } from "../../db/queries/positions";
import { openQueuedSells } from "../../db/queries/pool";

const route = createRoute({
  method: "get", path: "/v1/accounts/{address}/positions", tags: ["accounts"], request: { params: accountParams },
  responses: { 200: { description: "Open positions: units after funding, value at bid, today's cost, cost basis and P&L", content: { "application/json": { schema: positionsResponseSchema } } } },
});

export function registerAccountRoutes(app: OpenAPIHono, deps: ApiDependencies): void {
  app.openapi(route, async (context) => {
    context.header("Cache-Control", "private, no-store");
    const { address } = context.req.valid("param");
    const now = await apiNow(deps);
    const [rows, queued] = await Promise.all([accountPositions(deps, address), openQueuedSells(deps, address)]);
    const contexts = new Map<string, NameContext | null>();
    for (const name of new Set(rows.flatMap((row) => (row.name ? [row.name] : [])))) {
      contexts.set(name, await loadNameContext(deps, name, now));
    }

    let totalValue = 0n;
    let totalDaily = 0n;
    let totalCost = 0n;
    let totalPnl = 0n;
    const positions = rows.map((row) => {
      const cost = usdgMicro(row.boughtUsdg);
      const proceeds = usdgMicro(row.soldUsdg);
      const ctx = row.name ? contexts.get(row.name) ?? null : null;
      const input = { isCall: row.isCall, speed: row.speed, strike: Number(row.strike), buyable: row.buyable, archived: row.archived };
      const market = ctx ? marketInputs(ctx, { id: row.seriesId, speed: row.speed }) : null;
      // Units after funding up to now (the indexed norm can be an hour old; the engine accrues before every trade).
      const norm = market ? normDecimal(projectedNorm(input, market, Number(row.norm), Date.parse(row.lastAccrual))) : row.norm;
      const unitsWad = (looseWad(row.balance) * looseWad(norm)) / 10n ** 18n;
      const units = trimDecimal(normDecimalWad(unitsWad));
      const quote = market && unitsWad > 0n ? quoteUnits(input, market, unitsWad, false) : null;
      totalCost += cost;
      if (quote) {
        totalValue += quote.usdg;
        totalDaily += quote.dailyCostUsdg;
        totalPnl += quote.usdg + proceeds - cost;
      }
      return {
        seriesId: row.seriesId, name: row.name, isCall: row.isCall, speed: row.speed, strike: trimDecimal(row.strike), token: row.token,
        balance: trimDecimal(row.balance), norm: trimDecimal(norm), units,
        valueAtBidUsdg: quote ? usdgText(quote.usdg) : null,
        dailyCostUsdg: quote ? usdgText(quote.dailyCostUsdg) : null,
        displayCost: quote ? displayCost(quote.dailyCostUsdg) : null,
        costBasisUsdg: usdgText(cost),
        proceedsUsdg: usdgText(proceeds),
        pnlUsdg: quote ? usdgText(quote.usdg + proceeds - cost) : null,
        session: quote ? quote.session : null,
        sellQueued: quote?.sellQueued ?? false,
      };
    });
    return context.json({
      account: address,
      asOf: now.toISOString(),
      positions,
      totals: {
        valueAtBidUsdg: usdgText(totalValue), dailyCostUsdg: usdgText(totalDaily),
        costBasisUsdg: usdgText(totalCost), pnlUsdg: usdgText(totalPnl),
      },
      queuedSells: queued.map((item) => ({ ticket: item.ticket, seriesId: item.seriesId, tokens: trimDecimal(item.tokens), queuedAt: item.queuedAt })),
    }, 200);
  });
}

/** A WAD amount as an 18-decimal string. */
function normDecimalWad(wad: bigint): string {
  return `${wad / 10n ** 18n}.${(wad % 10n ** 18n).toString().padStart(18, "0")}`;
}
