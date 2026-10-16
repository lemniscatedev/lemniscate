import { apiNow } from "../../api/clock";
import type { ApiDependencies, DbRow } from "../../api/types";
import { asRows, dateValue, numberValue, textValue } from "../../api/types";
import { decimal, divide, fixed, fromBps, multiply, ratioPercent, WAD } from "../../lib/fixed";
import { listMarkets, type MarketView } from "./markets";

export const BACKTEST_INVEST_USD = 100n;
export const BACKTEST_BUCKETS = { 7: "1 hour", 30: "4 hours" } as const;
export type BacktestDays = 7 | 30;

type BacktestOutcomeInput = {
  entryPrice: bigint;
  entryRegime: number;
  entryNorm: bigint;
  entrySpot: bigint;
  nowPrice: bigint;
  nowIndex: bigint;
  nowSpot: bigint;
  feeBps: number;
  entrySpreadBps: number;
  exitSpreadBps: number;
};

export function backtestOutcome(input: BacktestOutcomeInput) {
  const invest = BACKTEST_INVEST_USD * WAD;
  const entryFee = fromBps(invest, input.feeBps);
  const ask = input.entryPrice + fromBps(input.entryPrice, input.entrySpreadBps);
  const tokens = divide(invest - entryFee, ask);
  const markValue = multiply(tokens, input.nowPrice);
  const bid = input.nowPrice - fromBps(input.nowPrice, input.exitSpreadBps);
  const exitGross = multiply(tokens, bid);
  const exitFee = fromBps(exitGross, input.feeBps);
  const value = exitGross - exitFee;
  const costs = entryFee
    + multiply(tokens, ask - input.entryPrice)
    + multiply(tokens, input.nowPrice - bid)
    + exitFee;
  const nowNorm = input.nowIndex > 0n ? divide(input.nowPrice, input.nowIndex) : 0n;
  const carryPct = input.entryNorm > 0n && nowNorm > 0n
    ? ratioPercent(input.entryNorm - nowNorm, input.entryNorm)
    : null;

  return {
    tokens,
    markValue,
    value,
    costs,
    exitPrice: bid,
    changePct: ratioPercent(value - invest, invest),
    markChangePct: ratioPercent(markValue - invest, invest),
    stockChangePct: ratioPercent(input.nowSpot - input.entrySpot, input.entrySpot),
    carryPct,
  };
}

export function spreadForRegime(config: Record<string, unknown>, regime: number): number {
  const [key, fallback] = regime === 1
    ? ["offHoursSpreadBps", 150]
    : regime === 2
      ? ["pausedSpreadBps", 300]
      : ["openSpreadBps", 40];
  const raw = config[key];
  const value = raw === null || raw === undefined || raw === "" ? Number.NaN : Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

export function fillValueSeries(
  rows: { t: number; price: string }[],
  tokens: bigint,
  startSec: number,
  endSec: number,
  stepSec: number,
): { t: number; valueUsd: string }[] {
  const first = Math.floor(startSec / stepSec) * stepSec;
  const end = Math.floor(endSec / stepSec) * stepSec;
  const points: { t: number; valueUsd: string }[] = [];
  let next = 0;
  let lastPrice: string | undefined;

  for (let t = first; t <= end; t += stepSec) {
    while (next < rows.length && rows[next]!.t <= t) {
      lastPrice = rows[next]!.price;
      next += 1;
    }
    if (lastPrice !== undefined) {
      points.push({ t, valueUsd: decimal(multiply(tokens, fixed(lastPrice))) });
    }
  }
  return points;
}

type BacktestRow = DbRow & {
  ts: Date | string;
  price: string;
  norm_factor: string;
  spot: string;
  regime: number | string;
};

export type MarketBacktest = {
  symbol: string;
  days: BacktestDays;
  available: boolean;
  reason?: string;
  shortened?: boolean;
  actualDays?: number;
  startAt?: string;
  endAt?: string;
  investUsd?: string;
  entryPrice?: string;
  exitPrice?: string;
  tokens?: string;
  markValueUsd?: string;
  valueUsd?: string;
  costsUsd?: string;
  changePct?: number;
  markChangePct?: number;
  stockChangePct?: number;
  carryPct?: number | null;
  points: { t: number; valueUsd: string }[];
};

export async function marketBacktest(
  deps: ApiDependencies,
  symbol: string,
  days: BacktestDays,
  requestedNow?: Date,
): Promise<MarketBacktest | null> {
  const now = requestedNow ?? await apiNow(deps);
  const markets = await deps.cache.getOrLoad("markets:list", 3_000, () => listMarkets(deps, now));
  const market = markets.find((item: MarketView) =>
    item.symbol.toUpperCase() === symbol.toUpperCase() && item.launched,
  );
  if (!market) return null;

  const requestedStart = new Date(now.getTime() - days * 86_400_000);
  const entryResult = await deps.sql`
    select ts, price::text as price, norm_factor::text as norm_factor, spot::text as spot, regime
    from ticks
    where market_id = ${market.id} and ts >= ${requestedStart.toISOString()}::timestamptz
      and ts <= ${now.toISOString()}::timestamptz and price > 0
    order by ts asc limit 1
  `;
  const entry = asRows<BacktestRow>(entryResult)[0];
  if (!entry) {
    return { symbol: market.symbol, days, available: false, reason: "Not enough history yet.", points: [] };
  }
  const startAt = dateValue(entry.ts);
  if (!startAt) {
    return { symbol: market.symbol, days, available: false, reason: "Not enough history yet.", points: [] };
  }

  const shortened = startAt.getTime() - requestedStart.getTime() > 6 * 60 * 60 * 1_000;
  const actualDays = Math.max(1, Math.round((now.getTime() - startAt.getTime()) / 86_400_000));
  const entryPrice = fixed(textValue(entry.price));
  const entryRegime = numberValue(entry.regime);
  const outcome = backtestOutcome({
    entryPrice,
    entryRegime,
    entryNorm: fixed(textValue(entry.norm_factor)),
    entrySpot: fixed(textValue(entry.spot)),
    nowPrice: fixed(market.price),
    nowIndex: fixed(market.index),
    nowSpot: fixed(market.spot),
    feeBps: market.quoteParams.feeBps,
    entrySpreadBps: spreadForRegime(market.config, entryRegime),
    exitSpreadBps: market.quoteParams.spreadBps,
  });

  const stepSec = days === 7 ? 3_600 : 14_400;
  const nowSec = Math.floor(now.getTime() / 1_000);
  const rowsResult = await deps.sql.unsafe(
    `select floor(extract(epoch from time_bucket(interval '${BACKTEST_BUCKETS[days]}', ts)))::bigint as t,
       last(price, ts)::text as price
     from ticks where market_id = $1 and ts >= $2::timestamptz and ts <= $3::timestamptz
     group by 1 order by 1`,
    [market.id, startAt.toISOString(), now.toISOString()],
  );
  const rows = asRows<DbRow>(rowsResult).map((row) => ({
    t: numberValue(row.t),
    price: textValue(row.price),
  }));
  const points = fillValueSeries(rows, outcome.tokens, Math.floor(startAt.getTime() / 1_000), nowSec, stepSec);
  const finalPoint = { t: points.at(-1)?.t ?? nowSec, valueUsd: decimal(outcome.markValue) };
  if (points.length === 0) points.push(finalPoint);
  else points[points.length - 1] = finalPoint;

  return {
    symbol: market.symbol,
    days,
    available: true,
    shortened,
    actualDays,
    startAt: startAt.toISOString(),
    endAt: now.toISOString(),
    investUsd: "100",
    entryPrice: decimal(entryPrice),
    exitPrice: decimal(outcome.exitPrice),
    tokens: decimal(outcome.tokens),
    markValueUsd: decimal(outcome.markValue),
    valueUsd: decimal(outcome.value),
    costsUsd: decimal(outcome.costs),
    changePct: outcome.changePct,
    markChangePct: outcome.markChangePct,
    stockChangePct: outcome.stockChangePct,
    carryPct: outcome.carryPct,
    points,
  };
}
