import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import type { ApiDependencies } from "../types";
import { configResponseSchema } from "../option-schemas";
import { LAUNCH_CAPS } from "../caps";
import { QUOTE_PARAMS, TAU_SECONDS } from "../quote/model";

const route = createRoute({
  method: "get", path: "/v1/config", tags: ["system"],
  responses: { 200: { description: "Addresses, names, caps and pricing constants", content: { "application/json": { schema: configResponseSchema } } } },
});

export function registerConfigRoutes(app: OpenAPIHono, deps: ApiDependencies): void {
  const { deployment } = deps;
  const body = {
    chainId: deployment.chainId,
    network: deployment.network,
    ...(deployment.forkProof ? { forkProof: deployment.forkProof } : {}),
    contracts: Object.fromEntries(Object.entries(deployment.contracts).filter(([, value]) => typeof value === "string")) as Record<string, string>,
    stocks: deployment.stocks.map((entry) => ({ name: entry.name, stock: entry.stock, feed: entry.feed ?? null })),
    names: deployment.stocks.map((entry) => entry.name),
    usdgDecimals: 6 as const,
    optionDecimals: 18 as const,
    poolShareDecimals: deployment.poolShareDecimals,
    speeds: [
      { speed: "DAILY" as const, tauSeconds: TAU_SECONDS.DAILY },
      { speed: "WEEKLY" as const, tauSeconds: TAU_SECONDS.WEEKLY },
    ],
    caps: {
      poolNavUsdg: LAUNCH_CAPS.poolNavUsdg === null ? null : String(LAUNCH_CAPS.poolNavUsdg),
      perSeriesOutstandingUsdg: String(LAUNCH_CAPS.perSeriesOutstandingUsdg),
      perAccountSeriesUsdg: String(LAUNCH_CAPS.perAccountSeriesUsdg),
      totalOptionValuePctOfNav: LAUNCH_CAPS.totalOptionValuePctOfNav,
      perNamePctOfNav: LAUNCH_CAPS.perNamePctOfNav,
      stressBudgetPctOfNav: LAUNCH_CAPS.stressBudgetPctOfNav,
      drawdownPausePct: LAUNCH_CAPS.drawdownPausePct,
      writerVaultsOpen: LAUNCH_CAPS.writerVaultsOpen,
    },
    pricing: {
      feeBps: QUOTE_PARAMS.feeBps, minSpreadUsd: QUOTE_PARAMS.minSpreadUsd,
      spreadBpsAtm: QUOTE_PARAMS.spreadBpsAtm, spreadBpsFar: QUOTE_PARAMS.spreadBpsFar,
      sessionMultipliers: { ...QUOTE_PARAMS.sessionMultiplier },
    },
  };
  app.openapi(route, (context) => {
    context.header("Cache-Control", "public, max-age=60");
    return context.json(body, 200);
  });
}
