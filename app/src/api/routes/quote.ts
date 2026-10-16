import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { encodeFunctionData, type Address } from "viem";
import type { ApiDependencies } from "../types";
import { apiNow } from "../clock";
import {
  apiErrorSchema, buyIntentBodySchema, intentResponseSchema, quoteBodySchema, quoteResponseSchema,
  sellIntentBodySchema, shieldIntentBodySchema,
} from "../option-schemas";
import { loadNameContext, marketInputs, seriesInputs, type NameContext } from "../quote/context";
import {
  displayCost, parseWad, quoteUnits, usdgText, wadText, type BuyBlock, type EngineQuote, type SessionName,
} from "../quote/model";
import { OptionEngineAbi } from "../../abi";
import { inviteGate } from "./invites";
import { getSeries, listSeries, type SeriesView } from "../../db/queries/series";

const WAD = 10n ** 18n;
const UINT128_MAX = (1n << 128n) - 1n;
const SESSION_INDEX: Record<SessionName, number> = { REGULAR: 0, EXTENDED: 1, CLOSED: 2, UNKNOWN: 3, HALTED: 4 };

const BLOCK_MESSAGES: Record<BuyBlock, string> = {
  SERIES_ARCHIVED: "This option is no longer listed for new purchases. It can still be sold.",
  SERIES_NOT_BUYABLE: "This option is not open for new purchases right now. It can still be sold.",
  BUYS_PAUSED: "New purchases are paused. Sells stay open.",
  SESSION_CLOSED: "New purchases are closed while the market is closed. Sells stay open at the last close with a wider spread.",
  SESSION_UNKNOWN: "New purchases are closed while the market session is unknown. Sells stay open at the last close with a wider spread.",
  SESSION_HALTED: "New purchases are paused while the price feed is halted. Sells queue until a fresh price returns.",
  PRICE_STALE: "New purchases are paused until the price is fresh.",
  PRICE_PAUSED: "New purchases are paused on this name while a price check completes.",
  NO_VOL: "New purchases are paused until volatility inputs are posted.",
  VOL_STALE: "New purchases are paused until volatility inputs are refreshed.",
  EARNINGS_BLOCK: "New purchases are paused around this name's earnings report. Sells stay open.",
  NO_PRICE: "No price is indexed for this name yet.",
  CAP_REACHED: "This option is at its size limit for now (a pool exposure cap, tighter outside regular hours). Sells stay open.",
};

type Failure = { status: 404 | 409 | 422 | 503; body: { error: string; message: string; reason?: BuyBlock } };

interface Prepared {
  readonly series: SeriesView;
  readonly ctx: NameContext;
  readonly now: Date;
}

async function prepare(deps: ApiDependencies, series: SeriesView | null): Promise<Prepared | Failure> {
  if (!series) return { status: 404, body: { error: "NOT_FOUND", message: "Unknown series." } };
  if (!series.name) return { status: 422, body: { error: "UNPRICEABLE", message: "This series has no known name." } };
  const now = await apiNow(deps);
  const ctx = await loadNameContext(deps, series.name, now);
  if (!ctx) return { status: 503, body: { error: "NO_PRICE", message: "No price is indexed for this name yet." } };
  return { series, ctx, now };
}

const failed = (value: Prepared | Failure): value is Failure => "status" in value;

function rawQuote(quote: EngineQuote) {
  return {
    usdg: quote.usdg.toString(), vMarkWad: quote.vMarkWad.toString(), spreadBps: String(quote.spreadBps),
    feeUsdg: quote.feeUsdg.toString(), dailyCostUsdg: quote.dailyCostUsdg.toString(), breakevenWad: quote.breakevenWad.toString(),
    sigmaBps: String(quote.sigmaBps), session: SESSION_INDEX[quote.session], buyable: quote.buyable,
  };
}

/** Units that burn into `tokens`: tokens x norm = units, so tokens = ceil(units / norm). */
function tokensForUnits(unitsWad: bigint, normText: string): bigint | null {
  const norm = parseWad(normText.replace(/^0+(?=\d)/, ""));
  if (!norm) return null;
  return (unitsWad * WAD + norm - 1n) / norm;
}

const quoteRoute = createRoute({
  method: "post", path: "/v1/quote", tags: ["markets"],
  request: { body: { required: true, content: { "application/json": { schema: quoteBodySchema } } } },
  responses: {
    200: { description: "A quote with the fields of IOptionEngine.Quote", content: { "application/json": { schema: quoteResponseSchema } } },
    404: { description: "Unknown series", content: { "application/json": { schema: apiErrorSchema } } },
    503: { description: "No price or volatility indexed yet", content: { "application/json": { schema: apiErrorSchema } } },
  },
});

const intentResponses = {
  200: { description: "Unsigned calldata and the approvals it needs", content: { "application/json": { schema: intentResponseSchema } } },
  404: { description: "Unknown series or name", content: { "application/json": { schema: apiErrorSchema } } },
  409: { description: "Buys are blocked right now", content: { "application/json": { schema: apiErrorSchema } } },
  422: { description: "Amount out of range", content: { "application/json": { schema: apiErrorSchema } } },
  503: { description: "No price or volatility indexed yet", content: { "application/json": { schema: apiErrorSchema } } },
  403: { description: "Invites are required and this wallet has not redeemed a code (buy and shield only; sells are never gated)", content: { "application/json": { schema: apiErrorSchema } } },
};
const jsonBody = <T extends import("zod").ZodType>(schema: T) => ({ required: true, content: { "application/json": { schema } } });
const buyRoute = createRoute({ method: "post", path: "/v1/intent/buy", tags: ["markets"], request: { body: jsonBody(buyIntentBodySchema) }, responses: intentResponses });
const sellRoute = createRoute({ method: "post", path: "/v1/intent/sell", tags: ["markets"], request: { body: jsonBody(sellIntentBodySchema) }, responses: intentResponses });
const shieldRoute = createRoute({ method: "post", path: "/v1/intent/shield", tags: ["markets"], request: { body: jsonBody(shieldIntentBodySchema) }, responses: intentResponses });

export function registerQuoteRoutes(app: OpenAPIHono, deps: ApiDependencies): void {
  const engine = deps.deployment.contracts.engine as Address;
  const usdg = deps.deployment.contracts.usdg as Address;

  app.openapi(quoteRoute, async (context) => {
    context.header("Cache-Control", "no-store");
    const body = context.req.valid("json");
    const unitsWad = parseWad(body.units);
    if (!unitsWad) return context.json({ error: "BAD_REQUEST", message: "Units must be a positive number." }, 422 as never);
    const prepared = await prepare(deps, await getSeries(deps, body.series));
    if (failed(prepared)) return context.json(prepared.body, prepared.status as 404);
    const { series, ctx } = prepared;
    const quote = quoteUnits(seriesInputs(series), marketInputs(ctx, series), unitsWad, body.side === "buy");
    if (!quote) return context.json({ error: "NO_VOL", message: "No volatility inputs are indexed for this series yet." }, 503);
    return context.json({
      series: series.id, side: body.side, unitsWad: unitsWad.toString(), quote: rawQuote(quote),
      display: {
        session: quote.session, usdg: usdgText(quote.usdg), feeUsdg: usdgText(quote.feeUsdg),
        dailyCostUsdg: usdgText(quote.dailyCostUsdg), displayCost: displayCost(quote.dailyCostUsdg),
        breakeven: wadText(quote.breakevenWad), vMark: wadText(quote.vMarkWad),
      },
      blockReason: body.side === "buy" ? quote.buyBlock : null,
      sellQueued: quote.sellQueued,
      asOf: ctx.tick.ts,
    }, 200);
  });

  app.openapi(buyRoute, async (context) => {
    context.header("Cache-Control", "no-store");
    const body = context.req.valid("json");
    const gated = await inviteGate(deps, [body.account, body.owner]);
    if (gated) return context.json(gated, 403);
    const unitsWad = parseWad(body.units);
    if (!unitsWad || unitsWad > UINT128_MAX) return context.json({ error: "BAD_REQUEST", message: "Units must be a positive number." }, 422);
    const prepared = await prepare(deps, await getSeries(deps, body.series));
    if (failed(prepared)) return context.json(prepared.body, prepared.status);
    const { series, ctx, now } = prepared;
    const quote = quoteUnits(seriesInputs(series), marketInputs(ctx, series), unitsWad, true);
    if (!quote) return context.json({ error: "NO_VOL", message: BLOCK_MESSAGES.NO_VOL, reason: "NO_VOL" as const }, 409);
    if (quote.buyBlock) return context.json({ error: "BUY_BLOCKED", message: BLOCK_MESSAGES[quote.buyBlock], reason: quote.buyBlock }, 409);
    const maxCost = (quote.usdg * BigInt(10_000 + body.slippageBps) + 9_999n) / 10_000n;
    if (maxCost > UINT128_MAX) return context.json({ error: "BAD_REQUEST", message: "Amount out of range." }, 422);
    const deadline = Math.floor(now.getTime() / 1_000) + body.deadlineSeconds;
    const data = encodeFunctionData({
      abi: OptionEngineAbi, functionName: "buy",
      args: [series.id as `0x${string}`, unitsWad, maxCost, BigInt(deadline), (body.recipient ?? body.account) as Address],
    });
    return context.json({
      kind: "buy" as const, to: engine, data, value: "0" as const,
      approvals: [{ token: usdg, spender: engine, amount: maxCost.toString() }],
      maxCostUsdg: maxCost.toString(), deadline, series: series.id, quote: rawQuote(quote),
      display: { usdg: usdgText(quote.usdg), displayCost: displayCost(quote.dailyCostUsdg), breakeven: wadText(quote.breakevenWad) },
      queued: false, note: null,
    }, 200);
  });

  app.openapi(sellRoute, async (context) => {
    context.header("Cache-Control", "no-store");
    const body = context.req.valid("json");
    const unitsWad = parseWad(body.units);
    if (!unitsWad || unitsWad > UINT128_MAX) return context.json({ error: "BAD_REQUEST", message: "Units must be a positive number." }, 422);
    const prepared = await prepare(deps, await getSeries(deps, body.series));
    if (failed(prepared)) return context.json(prepared.body, prepared.status);
    const { series, ctx, now } = prepared;
    const quote = quoteUnits(seriesInputs(series), marketInputs(ctx, series), unitsWad, false);
    if (!quote) return context.json({ error: "NO_VOL", message: "No volatility inputs are indexed for this series yet." }, 503);
    const tokens = tokensForUnits(unitsWad, series.norm);
    if (tokens === null || tokens > UINT128_MAX) return context.json({ error: "BAD_REQUEST", message: "Amount out of range." }, 422);
    const queued = quote.sellQueued;
    const minProceeds = queued ? 0n : (quote.usdg * BigInt(10_000 - body.slippageBps)) / 10_000n;
    const deadline = Math.floor(now.getTime() / 1_000) + body.deadlineSeconds;
    const data = encodeFunctionData({
      abi: OptionEngineAbi, functionName: "sell",
      args: [series.id as `0x${string}`, tokens, minProceeds, BigInt(deadline), (body.recipient ?? body.account) as Address],
    });
    const note = queued
      ? "The price feed is halted. This sell joins a queue and fills at the first fresh price; no minimum is set because the fill price is not known yet."
      : quote.session === "CLOSED" || quote.session === "UNKNOWN"
        ? "The market is closed. This sell is priced at the last close with a wider spread."
        : null;
    return context.json({
      kind: "sell" as const, to: engine, data, value: "0" as const, approvals: [],
      minProceedsUsdg: minProceeds.toString(), deadline, series: series.id, tokens: tokens.toString(), quote: rawQuote(quote),
      display: { usdg: usdgText(quote.usdg), displayCost: displayCost(quote.dailyCostUsdg), breakeven: wadText(quote.breakevenWad) },
      queued, note,
    }, 200);
  });

  app.openapi(shieldRoute, async (context) => {
    context.header("Cache-Control", "no-store");
    const body = context.req.valid("json");
    const gated = await inviteGate(deps, [body.account, body.owner]);
    if (gated) return context.json(gated, 403);
    const stockEntry = deps.deployment.stocks.find((entry) => entry.name === body.name);
    if (!stockEntry) return context.json({ error: "NOT_FOUND", message: `Unknown name: ${body.name}` }, 404);
    const tokenUnits = parseWad(body.tokenUnits);
    if (!tokenUnits || tokenUnits > UINT128_MAX) return context.json({ error: "BAD_REQUEST", message: "Token units must be a positive number." }, 422);
    const now = await apiNow(deps);
    const ctx = await loadNameContext(deps, body.name, now);
    if (!ctx) return context.json({ error: "NO_PRICE", message: BLOCK_MESSAGES.NO_PRICE }, 503);
    const spot = Number(ctx.tick.spot);
    const target = spot * (10_000 - body.strikePctBelowBps) / 10_000;
    // Shield is a Weekly Down option: the listed, buyable Weekly put below the price whose strike is nearest the target.
    const puts = (await listSeries(deps, { name: body.name, speed: "WEEKLY" })).filter((entry) => !entry.isCall && entry.buyable);
    const candidates = puts.filter((entry) => Number(entry.strike) < spot)
      .sort((a, b) => Math.abs(Number(a.strike) - target) - Math.abs(Number(b.strike) - target));
    const series = candidates[0];
    if (!series) return context.json({ error: "NO_SHIELD_SERIES", message: "No Weekly Down option is open for purchase on this name." }, 409);
    const strikePctBelowBps = shieldPctFor(Number(series.strike), spot, puts.map((entry) => Number(entry.strike)));
    const quote = quoteUnits(seriesInputs(series), marketInputs(ctx, series), tokenUnits, true);
    if (!quote) return context.json({ error: "NO_VOL", message: BLOCK_MESSAGES.NO_VOL, reason: "NO_VOL" as const }, 409);
    if (quote.buyBlock) return context.json({ error: "BUY_BLOCKED", message: BLOCK_MESSAGES[quote.buyBlock], reason: quote.buyBlock }, 409);
    const maxCost = (quote.usdg * BigInt(10_000 + body.slippageBps) + 9_999n) / 10_000n;
    if (maxCost > UINT128_MAX) return context.json({ error: "BAD_REQUEST", message: "Amount out of range." }, 422);
    const deadline = Math.floor(now.getTime() / 1_000) + body.deadlineSeconds;
    const data = encodeFunctionData({
      abi: OptionEngineAbi, functionName: "shield",
      args: [stockEntry.stock as Address, tokenUnits, strikePctBelowBps, maxCost, BigInt(deadline)],
    });
    return context.json({
      kind: "shield" as const, to: engine, data, value: "0" as const,
      approvals: [{ token: usdg, spender: engine, amount: maxCost.toString() }],
      maxCostUsdg: maxCost.toString(), deadline, series: series.id, quote: rawQuote(quote),
      display: { usdg: usdgText(quote.usdg), displayCost: displayCost(quote.dailyCostUsdg), breakeven: wadText(quote.breakevenWad) },
      queued: false,
      note: "The engine picks the listed Weekly Down series nearest your protection level when the transaction runs.",
    }, 200);
  });
}

/** The engine's shield() buys the LARGEST buyable Weekly put with strike <= S x (1 - pct) (EngineTradeLib.pickShield).
 * The level the user asked for is only used to choose the strike above; this returns the pct that makes the engine land
 * on that same strike: it aims half way to the next listed strike up, so a price move of up to about half a strike step
 * between the quote and the transaction still selects it (the engine never sees the requested level). todo 23: the raw
 * requested pct was passed before, so the default 10% level targeted below the lowest listed strike and reverted. */
export function shieldPctFor(strike: number, spot: number, listedStrikes: readonly number[]): number {
  const above = listedStrikes.filter((k) => k > strike).sort((a, b) => a - b)[0];
  const aim = above !== undefined ? (strike + above) / 2 : strike * 1.005;
  const pct = Math.floor((1 - aim / spot) * 10_000);
  return Math.min(9_999, Math.max(0, pct));
}
