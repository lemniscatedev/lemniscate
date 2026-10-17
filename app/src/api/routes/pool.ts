import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import type { ApiDependencies } from "../types";
import { apiNow } from "../clock";
import { poolResponseSchema } from "../option-schemas";
import { LAUNCH_CAPS } from "../caps";
import { loadNameContext, marketInputs, seriesInputs, type NameContext } from "../quote/context";
import { unitQuote } from "../quote/model";
import { trimDecimal } from "../quote/rows";
import { fundingWindow, latestHedgeEquity, peakNavPerShare, queueSummary, seriesSupply, enginePauses } from "../../db/queries/market";
import { latestLimits, latestPoolNav } from "../../db/queries/pool";
import { listSeries } from "../../db/queries/series";

const POOL_TTL_MS = 5_000;
const FUNDING_WINDOW_HOURS = 24;

const route = createRoute({
  method: "get", path: "/v1/pool", tags: ["vault"],
  responses: { 200: { description: "Writer Pool NAV, exposures, stress, caps usage and queue size", content: { "application/json": { schema: poolResponseSchema } } } },
});

const usd = (value: number): string => (Number.isFinite(value) ? value.toFixed(6) : "0.000000");
const pct = (part: number, whole: number): number | null => (whole > 0 ? Number(((part / whole) * 100).toFixed(4)) : null);

export function registerPoolRoutes(app: OpenAPIHono, deps: ApiDependencies): void {
  app.openapi(route, async (context) => {
    context.header("Cache-Control", "public, max-age=5");
    const body = await deps.cache.getOrLoad("pool:summary", POOL_TTL_MS, async () => {
      const now = await apiNow(deps);
      const since24h = new Date(now.getTime() - FUNDING_WINDOW_HOURS * 3_600_000);
      const since30d = new Date(now.getTime() - 30 * 86_400_000);
      const [nav, limits, series, supplies, funding, hedge, peak, queue, pauses] = await Promise.all([
        latestPoolNav(deps), latestLimits(deps), listSeries(deps), seriesSupply(deps), fundingWindow(deps, since24h),
        latestHedgeEquity(deps), peakNavPerShare(deps, since30d), queueSummary(deps), enginePauses(deps),
      ]);
      const contexts = new Map<string, NameContext | null>();
      for (const entry of deps.deployment.stocks) contexts.set(entry.name, await loadNameContext(deps, entry.name, now));
      const supplyOf = new Map(supplies.map((row) => [row.seriesId, Number(row.supply)]));

      // Outstanding option value per series: supply x norm x mark, from the indexed price and vol.
      const valueByName = new Map<string, number>();
      let largestSeries = 0;
      for (const item of series) {
        const ctx = item.name ? contexts.get(item.name) ?? null : null;
        if (!ctx) continue;
        const unit = unitQuote(seriesInputs(item), marketInputs(ctx, item), false);
        if (!unit) continue;
        const value = (supplyOf.get(item.id) ?? 0) * Number(item.norm) * unit.v;
        valueByName.set(item.name!, (valueByName.get(item.name!) ?? 0) + value);
        largestSeries = Math.max(largestSeries, value);
      }

      let fundingUsd = 0;
      for (const row of funding) {
        if (row.vMark === null) continue;
        const dn = Number(row.normThen) - Number(row.normNow);
        if (dn > 0) fundingUsd += (supplyOf.get(row.seriesId) ?? 0) * dn * Number(row.vMark);
      }

      const navUsd = nav ? Number(nav.nav) : 0;
      const totalValue = [...valueByName.values()].reduce((sum, value) => sum + value, 0);
      const exposures = deps.deployment.stocks.map((entry) => {
        const limit = limits.find((row) => row.name === entry.name);
        const spot = Number(contexts.get(entry.name)?.tick.spot ?? 0);
        const value = valueByName.get(entry.name) ?? 0;
        return {
          name: entry.name,
          netDelta: trimDecimal(limit?.netDelta ?? "0"), netGamma: trimDecimal(limit?.netGamma ?? "0"), netVega: trimDecimal(limit?.netVega ?? "0"),
          deltaNotionalUsdg: usd(Number(limit?.netDelta ?? 0) * spot),
          stressLossBps: trimDecimal(limit?.stressLossBps ?? "0"),
          outstandingValueUsdg: usd(value),
          outstandingPctOfNav: pct(value, navUsd),
        };
      });
      const worstStress = exposures.reduce((max, row) => Math.max(max, Number(row.stressLossBps)), 0);
      const currentNps = nav ? Number(nav.navPerShare) : null;
      const drawdown = currentNps !== null && peak !== null && Number(peak) > 0
        ? Number((Math.max(0, (Number(peak) - currentNps) / Number(peak)) * 100).toFixed(4)) : null;

      return {
        asOf: nav?.ts ?? null,
        nav: trimDecimal(nav?.nav ?? "0"),
        navPerShare: trimDecimal(nav?.navPerShare ?? "0"),
        usdg: trimDecimal(nav?.usdg ?? "0"),
        hedgeEquity: trimDecimal(nav?.hedgeEquity ?? "0"),
        optionLiability: trimDecimal(nav?.optionLiability ?? "0"),
        reserve: trimDecimal(nav?.reserve ?? "0"),
        // Decision 36: the liability bounds LP deposits (low) and claims (high) are priced at; null before the first read.
        navLiability: nav?.navLiabilityLow && nav.navLiabilityHigh
          ? { low: trimDecimal(nav.navLiabilityLow), high: trimDecimal(nav.navLiabilityHigh) }
          : null,
        fundingReceived: { windowHours: FUNDING_WINDOW_HOURS, usdg: usd(fundingUsd), estimate: true as const },
        exposures,
        stressLossBps: worstStress.toFixed(4),
        caps: {
          navCapUsdg: String(LAUNCH_CAPS.poolNavUsdg),
          navPctOfCap: pct(navUsd, LAUNCH_CAPS.poolNavUsdg),
          totalOptionValuePct: pct(totalValue, navUsd),
          totalOptionValueCapPct: LAUNCH_CAPS.totalOptionValuePctOfNav,
          perNameCapPct: LAUNCH_CAPS.perNamePctOfNav,
          perSeriesCapUsdg: String(LAUNCH_CAPS.perSeriesOutstandingUsdg),
          largestSeriesValueUsdg: usd(largestSeries),
          stressBudgetPct: LAUNCH_CAPS.stressBudgetPctOfNav,
          perAccountSeriesCapUsdg: String(LAUNCH_CAPS.perAccountSeriesUsdg),
        },
        hedgeEquityAgeSeconds: hedge ? Math.max(0, Math.round((now.getTime() - new Date(hedge.asOf).getTime()) / 1_000)) : null,
        drawdown30dPct: drawdown,
        drawdownPausePct: LAUNCH_CAPS.drawdownPausePct,
        queue: { withdrawals: queue.withdrawals, withdrawalShares: trimDecimal(queue.withdrawalShares), sells: queue.sells },
        buysPaused: pauses.global || (drawdown !== null && drawdown > LAUNCH_CAPS.drawdownPausePct),
      };
    });
    return context.json(body, 200);
  });
}
