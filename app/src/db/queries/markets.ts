import { fixed, decimal, fromBps, projectNormFactor, priceAtNormFactor, changePercent, ratioPercent, fractionPercent, multiply, WAD } from "../../lib/fixed";
import { apiNow } from "../../api/clock";
import type { ApiDependencies, DbRow } from "../../api/types";
import { asRows, dateValue, jsonRecord, numberValue, textValue } from "../../api/types";
import { marketSession, type MarketSession } from "./sessions";
import { regimeName } from "./shared";
import { marketMeta, type MarketMeta } from "../../config/market-meta";
import { decodeKind, underlyingOf, type Curve } from "../../lib/market-kind";
import { isLaunched } from "../../config/launch";

interface MarketRawRow extends DbRow {
  id: number | string;
  symbol: string;
  token: string;
  stock: string;
  config: unknown;
  ts: Date | string | null;
  spot: string | null;
  index: string | null;
  norm_factor: string | null;
  price: string | null;
  bid: string | null;
  ask: string | null;
  carry_wad: string | null;
  regime: number | string | null;
  buys_paused: boolean | null;
  liability: string | null;
  hedge_units: string | null;
  hedge_target: string | null;
  oracle_updated_at: Date | string | null;
  previous_price: string | null;
  volume_24h: string | null;
  ref_bid: string | null;
  ref_ask: string | null;
  ref_token_bid: string | null;
  ref_token_ask: string | null;
  ref_daily_high: string | null;
  ref_daily_low: string | null;
  ref_halt: boolean | null;
  ref_generated_at: Date | string | null;
  ref_fetched_at: Date | string | null;
}

interface SparkRow extends DbRow {
  market_id: number | string;
  t: number | string;
  price: string;
}

interface CorpActionRow extends DbRow {
  symbol: string;
  kind: string;
  status: string;
  effective_at: Date | string | null;
}

export interface MarketView {
  id: number;
  symbol: string;
  curve: Curve;
  exponent: number | null;
  alwaysOpen: boolean;
  underlying: string;
  launched: boolean;
  meta?: MarketMeta | undefined;
  token: string;
  regime: "open" | "off_hours" | "paused";
  session: MarketSession;
  buysPaused: boolean;
  spot: string;
  index: string;
  price: string;
  bid: string;
  ask: string;
  dailyCarryPct: number;
  change24hPct: number;
  volume24hUsd: string;
  openInterestUsd: string;
  capacityUsd: string;
  utilizationPct: number;
  oracleUpdatedAt: string | null;
  asOf: string | null;
  sparkline: { t: number; p: string }[];
  corpAction?: { kind: string; effectiveAt: string | null; status: string };
  reference?: MarketReference | null;
  quoteParams: {
    feeBps: number;
    spreadBps: number;
    bandBps: number;
    impactBps: number;
    maxTradeUsd: string;
    minTradeUsd: string;
    capacityUsd: string;
    globalCapacityUsd: string;
  };
  config: Record<string, unknown>;
  stats: { trades24h: number; holders: number; buyVolume24hUsd: string; sellVolume24hUsd: string };
}

export interface MarketReference {
  bid: string;
  ask: string;
  mid: string;
  dayHigh: string | null;
  dayLow: string | null;
  lagBps: number | null;
  halt: boolean;
  quotedAt: string;
  stale: boolean;
}

function fixedValue(value: string | null): bigint | null {
  if (value === null || !/^\d+(?:\.\d+)?$/.test(value)) return null;
  try {
    return fixed(value);
  } catch {
    return null;
  }
}

export function marketReference(
  row: Pick<MarketRawRow, "ref_bid" | "ref_ask" | "ref_token_bid" | "ref_token_ask" | "ref_daily_high" | "ref_daily_low" | "ref_halt" | "ref_generated_at" | "ref_fetched_at">,
  oracleSpot: string | null,
  nowMs: number,
): MarketReference | null {
  const tokenBid = fixedValue(row.ref_token_bid);
  const tokenAsk = fixedValue(row.ref_token_ask);
  if (tokenBid === null || tokenAsk === null || tokenBid <= 0n || tokenAsk <= 0n) return null;
  const mid = (tokenBid + tokenAsk) / 2n;
  if (mid <= 0n) return null;

  const rawBid = fixedValue(row.ref_bid);
  const rawAsk = fixedValue(row.ref_ask);
  const rawMid = rawBid !== null && rawAsk !== null ? (rawBid + rawAsk) / 2n : 0n;
  const tokenRatio = rawMid > 0n ? (mid * WAD) / rawMid : null;
  const dailyHigh = fixedValue(row.ref_daily_high);
  const dailyLow = fixedValue(row.ref_daily_low);
  const dayHigh = tokenRatio !== null && dailyHigh !== null ? decimal(multiply(dailyHigh, tokenRatio)) : null;
  const dayLow = tokenRatio !== null && dailyLow !== null ? decimal(multiply(dailyLow, tokenRatio)) : null;

  const oracle = fixedValue(oracleSpot);
  const lagBps = oracle !== null && oracle > 0n
    ? Math.round(Number(((oracle - mid) * 10_000n * WAD) / mid) / 1e18 * 10) / 10
    : null;
  const generatedAt = dateValue(row.ref_generated_at);
  const fetchedAt = dateValue(row.ref_fetched_at);
  const stale = !generatedAt || !fetchedAt
    || nowMs - fetchedAt.getTime() > 180_000
    || nowMs - generatedAt.getTime() > 600_000;

  return {
    bid: decimal(tokenBid),
    ask: decimal(tokenAsk),
    mid: decimal(mid),
    dayHigh,
    dayLow,
    lagBps,
    halt: row.ref_halt === true,
    quotedAt: generatedAt?.toISOString() ?? new Date(0).toISOString(),
    stale,
  };
}

function configNumber(config: Record<string, unknown>, name: string, fallback: number): number {
  const parsed = Number(config[name]);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.trunc(parsed) : fallback;
}

function humanUsdg(value: unknown, fallback: string): string {
  if (value === null || value === undefined) return fallback;
  return String(value);
}

function publicMarketConfig(config: Record<string, unknown>): Record<string, unknown> {
  return {
    feeBps: configNumber(config, "feeBps", 10),
    openSpreadBps: configNumber(config, "openSpreadBps", 40),
    offHoursSpreadBps: configNumber(config, "offHoursSpreadBps", 150),
    pausedSpreadBps: configNumber(config, "pausedSpreadBps", 300),
    openBandBps: configNumber(config, "openBandBps", 100),
    offHoursBandBps: configNumber(config, "offHoursBandBps", 300),
    impactBps: configNumber(config, "impactBps", 50),
    maxMarketExposureBps: configNumber(config, "maxMarketExposureBps", 2500),
    maxTradeUsd: humanUsdg(config.maxTradeUsdg, "25"),
    minTradeUsd: humanUsdg(config.minTradeUsdg, "1"),
    pausedSellCapUsd: humanUsdg(config.pausedSellCapPerBlockUsdg, "50"),
  };
}

export async function listMarkets(deps: ApiDependencies, requestedNow?: Date): Promise<MarketView[]> {
  const now = requestedNow ?? await apiNow(deps);
  const nowIso = now.toISOString();
  const marketResult = await deps.sql`
    select m.id, m.symbol, m.token, m.stock, m.config,
      t.ts, t.spot, t."index", t.norm_factor, t.price, t.bid, t.ask, t.carry_wad, t.regime,
      t.buys_paused, t.liability, t.hedge_units, t.hedge_target, t.oracle_updated_at,
      prev.price as previous_price,
      coalesce(vol.volume_24h, 0)::text as volume_24h,
      r.bid::text as ref_bid, r.ask::text as ref_ask,
      r.token_bid::text as ref_token_bid, r.token_ask::text as ref_token_ask,
      r.daily_high::text as ref_daily_high, r.daily_low::text as ref_daily_low,
      r.halt as ref_halt, r.generated_at as ref_generated_at, r.fetched_at as ref_fetched_at
    from markets m
    left join ref_prices r on lower(r.stock) = lower(m.stock)
    left join lateral (
      select * from ticks where market_id = m.id and ts <= ${nowIso}::timestamptz order by ts desc limit 1
    ) t on true
    left join lateral (
      select price from ticks where market_id = m.id and ts <= ${nowIso}::timestamptz - interval '24 hours'
      order by ts desc limit 1
    ) prev on true
    left join lateral (
      select sum(usdg) as volume_24h from trades where market_id = m.id and ts >= ${nowIso}::timestamptz - interval '24 hours'
    ) vol on true
    order by m.id
  `;
  const rawMarkets = asRows<MarketRawRow>(marketResult);
  if (rawMarkets.length === 0) return [];

  const [vaultResult, sparkResult, corpResult, sessionResult, launchResult] = await Promise.all([
    deps.sql`select nav, total_liability, max_global_exposure_bps from vault_ticks order by ts desc limit 1`,
    deps.sql`
      select market_id, floor(extract(epoch from bucket))::bigint as t, price from (
        select market_id, time_bucket(interval '30 minutes', ts) as bucket, price,
          row_number() over (partition by market_id, time_bucket(interval '30 minutes', ts) order by ts desc) as rn
        from ticks where ts >= ${nowIso}::timestamptz - interval '24 hours'
          and ts <= ${nowIso}::timestamptz
      ) spark where rn = 1 order by market_id, bucket
    `,
    deps.sql`
      select distinct on (symbol) symbol, kind, status, effective_at
      from corp_actions
      where process_date >= ${nowIso}::date - 30 or effective_at >= ${nowIso}::timestamptz
        or lower(status) in ('in_progress', 'processing', 'pending')
      order by symbol,
        case when lower(status) in ('in_progress', 'processing') then 0 else 1 end,
        effective_at asc nulls last, process_date asc nulls last, updated_at desc
    `,
    marketSession(deps, now),
    deps.sql`select symbol, launched from market_launch`,
  ]);
  const { open, opensAt, closesAt } = sessionResult;
  const session = { open, opensAt, closesAt };
  const vaultRows = asRows<DbRow>(vaultResult);
  const sparkRows = asRows<SparkRow>(sparkResult);
  const corpRows = asRows<CorpActionRow>(corpResult);
  const launchRows = asRows<DbRow>(launchResult);
  const launchBySymbol = new Map(launchRows.map((row) => [textValue(row.symbol).toUpperCase(), row.launched === true]));
  const vault = vaultRows[0];
  const nav = fixed(vault?.nav as string | undefined);
  const maxGlobalExposureBps = numberValue(vault?.max_global_exposure_bps, 5000);
  const projectedLiabilityByMarket = new Map<number, bigint>();
  let totalTickLiability = 0n;
  let totalProjectedLiability = 0n;
  for (const row of rawMarkets) {
    const marketId = numberValue(row.id);
    const liability = fixed(row.liability);
    const tickNorm = fixed(row.norm_factor);
    const tickTs = dateValue(row.ts);
    const elapsed = tickTs ? Math.floor((now.getTime() - tickTs.getTime()) / 1000) : 0;
    const normNow = projectNormFactor(tickNorm, row.carry_wad ?? "0", elapsed);
    const projectedLiability = tickNorm > 0n ? (liability * normNow) / tickNorm : liability;
    totalTickLiability += liability;
    totalProjectedLiability += projectedLiability;
    projectedLiabilityByMarket.set(marketId, projectedLiability);
  }
  const totalLiability = totalProjectedLiability;
  const projectedNav = nav + totalTickLiability - totalProjectedLiability;
  const globalCapacity = projectedNav > 0n ? fromBps(projectedNav, maxGlobalExposureBps) : 0n;
  const globalRoom = globalCapacity > totalLiability ? globalCapacity - totalLiability : 0n;
  const sparkByMarket = new Map<number, { t: number; p: string }[]>();
  for (const row of sparkRows) {
    const id = numberValue(row.market_id);
    const items = sparkByMarket.get(id) ?? [];
    items.push({ t: numberValue(row.t), p: textValue(row.price, "0") });
    sparkByMarket.set(id, items);
  }
  const corpBySymbol = new Map(corpRows.map((row) => [row.symbol.toUpperCase(), row]));

  return rawMarkets.map((row) => {
    const marketId = numberValue(row.id);
    const config = jsonRecord(row.config);
    const { curve, exponent, alwaysOpen } = decodeKind(config.kind);
    const regime = regimeName(row.regime);
    const lastTs = dateValue(row.ts);
    const oracleTs = dateValue(row.oracle_updated_at);
    const tickPrice = fixed(row.price);
    const tickNorm = fixed(row.norm_factor);
    const elapsed = lastTs ? Math.floor((now.getTime() - lastTs.getTime()) / 1000) : 0;
    const normNow = projectNormFactor(tickNorm, row.carry_wad ?? "0", elapsed);
    const priceNow = tickNorm > 0n ? (tickPrice * normNow) / tickNorm : tickPrice;
    const bidNow = priceAtNormFactor(row.bid ?? row.price ?? "0", row.norm_factor ?? "0", normNow);
    const askNow = priceAtNormFactor(row.ask ?? row.price ?? "0", row.norm_factor ?? "0", normNow);
    const liability = projectedLiabilityByMarket.get(marketId) ?? fixed(row.liability);
    const exposureBps = configNumber(config, "maxMarketExposureBps", 2500);
    const marketCapacity = projectedNav > 0n ? fromBps(projectedNav, exposureBps) : 0n;
    const capacityRemaining = marketCapacity > liability ? marketCapacity - liability : 0n;
    const oraclePrice = fixed(row.previous_price);
    const publicConfig = publicMarketConfig(config);
    const spreadBps = regime === "open"
      ? Number(publicConfig.openSpreadBps)
      : regime === "off_hours" ? Number(publicConfig.offHoursSpreadBps) : Number(publicConfig.pausedSpreadBps);
    const bandBps = regime === "open"
      ? Number(publicConfig.openBandBps)
      : regime === "off_hours" ? Number(publicConfig.offHoursBandBps) : 300;
    const configuredSpark = sparkByMarket.get(marketId) ?? [];
    const sparkline = fillSparkline(configuredSpark, now);
    const corp = corpBySymbol.get(row.symbol.toUpperCase());
    const view: MarketView = {
      id: marketId,
      symbol: row.symbol,
      curve,
      exponent,
      alwaysOpen,
      underlying: underlyingOf(row.symbol, curve),
      launched: isLaunched(row.symbol, launchBySymbol.get(row.symbol.toUpperCase())),
      meta: marketMeta(row.symbol),
      token: row.token.toLowerCase(),
      regime,
      session,
      buysPaused: row.buys_paused === true,
      spot: textValue(row.spot, "0"),
      index: textValue(row.index, "0"),
      price: decimal(priceNow),
      bid: decimal(bidNow),
      ask: decimal(askNow),
      dailyCarryPct: fractionPercent(fixed(row.carry_wad)),
      change24hPct: changePercent(priceNow, oraclePrice),
      volume24hUsd: textValue(row.volume_24h, "0"),
      openInterestUsd: decimal(liability),
      capacityUsd: decimal(capacityRemaining),
      utilizationPct: ratioPercent(liability, marketCapacity),
      oracleUpdatedAt: oracleTs?.toISOString() ?? null,
      asOf: lastTs?.toISOString() ?? null,
      sparkline,
      reference: marketReference(row, row.spot, now.getTime()),
      quoteParams: {
        feeBps: Number(publicConfig.feeBps),
        spreadBps,
        bandBps,
        impactBps: Number(publicConfig.impactBps),
        maxTradeUsd: String(publicConfig.maxTradeUsd),
        minTradeUsd: String(publicConfig.minTradeUsd),
        capacityUsd: decimal(marketCapacity),
        globalCapacityUsd: decimal(globalRoom),
      },
      config: publicConfig,
      stats: { trades24h: 0, holders: 0, buyVolume24hUsd: "0", sellVolume24hUsd: "0" },
    };
    if (corp) {
      view.corpAction = {
        kind: corp.kind,
        effectiveAt: dateValue(corp.effective_at)?.toISOString() ?? null,
        status: corp.status,
      };
    }
    return view;
  });
}

function fillSparkline(points: { t: number; p: string }[], now: Date): { t: number; p: string }[] {
  if (points.length === 0) return [];
  const stepSeconds = 30 * 60;
  const end = Math.floor(now.getTime() / (stepSeconds * 1000)) * stepSeconds;
  const first = end - 47 * stepSeconds;
  const values = new Map(points.map((point) => [point.t, point.p]));
  let last: string | undefined;
  for (const point of points) {
    if (point.t > first) break;
    last = point.p;
  }
  const result: { t: number; p: string }[] = [];
  for (let t = first; t <= end; t += stepSeconds) {
    const exact = values.get(t);
    if (exact !== undefined) last = exact;
    if (last !== undefined) result.push({ t, p: last });
  }
  return result;
}

export async function getMarketDetail(deps: ApiDependencies, symbol: string, requestedNow?: Date): Promise<MarketView | null> {
  const now = requestedNow ?? await apiNow(deps);
  const markets = await listMarkets(deps, now);
  const market = markets.find((candidate) => candidate.symbol.toUpperCase() === symbol.toUpperCase());
  if (!market) return null;
  const result = await deps.sql`
    select count(*)::int as trades_24h,
      coalesce(sum(usdg) filter (where side = 'buy'), 0)::text as buy_volume_24h,
      coalesce(sum(usdg) filter (where side = 'sell'), 0)::text as sell_volume_24h,
      (select count(*)::int from balances where token = ${market.token} and balance > 0) as holders
    from trades where market_id = ${market.id} and ts >= ${now.toISOString()}::timestamptz - interval '24 hours'
  `;
  const stats = asRows<DbRow>(result)[0] ?? {};
  market.stats = {
    trades24h: numberValue(stats.trades_24h),
    holders: numberValue(stats.holders),
    buyVolume24hUsd: textValue(stats.buy_volume_24h, "0"),
    sellVolume24hUsd: textValue(stats.sell_volume_24h, "0"),
  };
  return market;
}

export async function marketCandles(
  deps: ApiDependencies,
  symbol: string,
  range: "1H" | "4H" | "1D" | "1W" | "1M" | "ALL",
  series: "price" | "index",
  requestedNow?: Date,
): Promise<Array<{ t: number; o: string; h: string; l: string; c: string; v: string; vb: string; vs: string; n: number }> | null> {
  const now = requestedNow ?? await apiNow(deps);
  const marketResult = await deps.sql`select id from markets where upper(symbol) = ${symbol.toUpperCase()} limit 1`;
  const market = asRows<DbRow>(marketResult)[0];
  if (!market) return null;
  const marketId = numberValue(market.id);

  const candlePlan = {
    "1H": { view: "candles_1m", baseInterval: "1 minute", interval: "1 minute", seconds: 60, slots: 60, lookback: "1 hour" },
    "4H": { view: "candles_1m", baseInterval: "1 minute", interval: "5 minutes", seconds: 5 * 60, slots: 48, lookback: "4 hours" },
    "1D": { view: "candles_1m", baseInterval: "1 minute", interval: "15 minutes", seconds: 15 * 60, slots: 96, lookback: "1 day" },
    "1W": { view: "candles_1h", baseInterval: "1 hour", interval: "1 hour", seconds: 60 * 60, slots: 168, lookback: "7 days" },
    "1M": { view: "candles_1h", baseInterval: "1 hour", interval: "4 hours", seconds: 4 * 60 * 60, slots: 180, lookback: "30 days" },
    ALL: { view: "candles_1d", baseInterval: "1 day", interval: "1 day", seconds: 24 * 60 * 60, slots: undefined, lookback: undefined },
  } as const;
  const plan = candlePlan[range];
  const prefix = series === "price" ? "price" : "index";
  const sourceColumn = series === "price" ? "price" : '"index"';
  const baseBound = plan.lookback
    ? `and candles.bucket >= $2::timestamptz - interval '${plan.lookback}' - interval '${plan.interval}'`
    : "";
  const rawBound = plan.lookback
    ? `and ticks.ts >= $2::timestamptz - interval '${plan.lookback}' - interval '${plan.interval}'`
    : "";
  const resultBound = plan.lookback
    ? `where bucket >= time_bucket(interval '${plan.interval}', $2::timestamptz - interval '${plan.lookback}')
        and bucket <= $2::timestamptz`
    : "where bucket <= $2::timestamptz";
  const rowsResult = await deps.sql.unsafe(
     `with cutoff as (
       select time_bucket(interval '${plan.baseInterval}', $2::timestamptz - interval '3 days') as bucket
     ), base as (
       select candles.bucket, candles.open_${prefix} as o, candles.high_${prefix} as h,
         candles.low_${prefix} as l, candles.close_${prefix} as c
       from ${plan.view} candles cross join cutoff
       where candles.market_id = $1 and candles.bucket < cutoff.bucket
         and candles.bucket <= $2::timestamptz ${baseBound}
       union all
       select time_bucket(interval '${plan.baseInterval}', ts) as bucket,
         first(${sourceColumn}, ts) as o, max(${sourceColumn}) as h,
         min(${sourceColumn}) as l, last(${sourceColumn}, ts) as c
       from ticks cross join cutoff
       where market_id = $1 and ts >= cutoff.bucket and ts <= $2::timestamptz ${rawBound}
       group by time_bucket(interval '${plan.baseInterval}', ts)
     ), rolled as (
       select time_bucket(interval '${plan.interval}', bucket) as bucket,
         first(o, bucket) as o, max(h) as h, min(l) as l, last(c, bucket) as c
       from base group by time_bucket(interval '${plan.interval}', bucket)
     )
     select floor(extract(epoch from bucket))::bigint as t,
       o::text as o, h::text as h, l::text as l, c::text as c
     from rolled ${resultBound} order by bucket`,
    [marketId, now.toISOString()],
  );
  const rows = asRows<DbRow>(rowsResult).map((row) => ({
    t: numberValue(row.t), o: textValue(row.o), h: textValue(row.h), l: textValue(row.l), c: textValue(row.c),
  }));
  const end = Math.floor(now.getTime() / (plan.seconds * 1000)) * plan.seconds;
  const start = Math.max(plan.slots ? end - (plan.slots - 1) * plan.seconds : rows[0]?.t ?? end, rows[0]?.t ?? end);
  const values = new Map(rows.map((row) => [row.t, row]));
  const fallback = rows[0]?.c ?? "0";
  let last = fallback;
  const filled: Array<{ t: number; o: string; h: string; l: string; c: string }> = [];
  for (let t = start; t <= end; t += plan.seconds) {
    const current = values.get(t);
    if (current) {
      last = current.c;
      filled.push(current);
    } else if (last !== "0") {
      filled.push({ t, o: last, h: last, l: last, c: last });
    }
  }
  const volumeBound = plan.lookback
    ? `and ts >= $2::timestamptz - interval '${plan.lookback}' - interval '${plan.interval}'`
    : "";
  const volumeResult = await deps.sql.unsafe(
    `select floor(extract(epoch from time_bucket(interval '${plan.interval}', ts)))::bigint as t,
       sum(usdg)::text as v,
       sum(case when side = 'buy' then usdg else 0 end)::text as vb,
       sum(case when side = 'sell' then usdg else 0 end)::text as vs,
       count(*)::int as n
     from trades where market_id = $1 and ts <= $2::timestamptz ${volumeBound}
     group by 1`,
    [marketId, now.toISOString()],
  );
  return mergeVolume(filled, asRows<DbRow>(volumeResult));
}

export function mergeVolume<T extends { t: number }>(candles: T[], rows: DbRow[]) {
  const byT = new Map(rows.map((row) => [numberValue(row.t), row]));
  return candles.map((candle) => {
    const row = byT.get(candle.t);
    return { ...candle, v: textValue(row?.v, "0"), vb: textValue(row?.vb, "0"), vs: textValue(row?.vs, "0"), n: numberValue(row?.n) };
  });
}

export async function marketCarry(
  deps: ApiDependencies,
  symbol: string,
  range: "1W" | "1M" | "ALL",
  requestedNow?: Date,
): Promise<Array<{ t: number; dailyCarryPct: number; regime: "open" | "off_hours" | "paused" }> | null> {
  const now = requestedNow ?? await apiNow(deps);
  const marketResult = await deps.sql`select id from markets where upper(symbol) = ${symbol.toUpperCase()} limit 1`;
  const market = asRows<DbRow>(marketResult)[0];
  if (!market) return null;
  const marketId = numberValue(market.id);
  const period = range === "1W" ? "7 days" : range === "1M" ? "30 days" : null;
  const rowsResult = period
    ? await deps.sql.unsafe(
      `select floor(extract(epoch from bucket))::bigint as t, carry_wad, regime from (
         select time_bucket(interval '1 hour', ts) as bucket, carry_wad, regime,
           row_number() over (partition by time_bucket(interval '1 hour', ts) order by ts desc) as rn
         from ticks where market_id = $1 and ts >= $2::timestamptz - interval '${period}'
           and ts <= $2::timestamptz
       ) hourly where rn = 1 order by bucket`,
      [marketId, now.toISOString()],
    )
    : await deps.sql.unsafe(
      `with cutoff as (
         select time_bucket(interval '1 day', $2::timestamptz - interval '30 days') as bucket
       ), points as (
         select history.bucket, history.carry_wad, history.regime
         from market_carry_1d history cross join cutoff
         where history.market_id = $1 and history.bucket < cutoff.bucket
           and history.bucket <= $2::timestamptz
         union all
         select time_bucket(interval '1 day', ts) as bucket,
           last(carry_wad, ts) as carry_wad, last(regime, ts) as regime
         from ticks cross join cutoff
         where market_id = $1 and ts >= cutoff.bucket and ts <= $2::timestamptz
         group by time_bucket(interval '1 day', ts)
       )
       select floor(extract(epoch from bucket))::bigint as t,
         carry_wad::text as carry_wad, regime::int as regime
       from points order by bucket`,
      [marketId, now.toISOString()],
    );
  const points = asRows<DbRow>(rowsResult).map((row) => ({
    t: numberValue(row.t),
    dailyCarryPct: fractionPercent(fixed(row.carry_wad as string | undefined)),
    regime: regimeName(row.regime),
  }));
  if (points.length === 0) return [];
  const step = range === "ALL" ? 24 * 60 * 60 : 60 * 60;
  const slots = range === "1W" ? 168 : range === "1M" ? 30 * 24 : undefined;
  const end = Math.floor(now.getTime() / (step * 1000)) * step;
  const start = Math.max(slots ? end - (slots - 1) * step : points[0]!.t, points[0]!.t);
  const byTime = new Map(points.map((point) => [point.t, point]));
  let last = points[0]!;
  const filled: typeof points = [];
  for (let t = start; t <= end; t += step) {
    const current = byTime.get(t);
    if (current) last = current;
    filled.push(current ?? { t, dailyCarryPct: last.dailyCarryPct, regime: last.regime });
  }
  return filled;
}

export async function marketTrades(deps: ApiDependencies, symbol: string, limit: number): Promise<DbRow[] | null> {
  const rows = await deps.sql`
    select t.tx_hash, t.side, t.account, t.recipient, t.usdg::text, t.fee::text, t.tokens::text,
      t.price::text, t.ts
    from trades t join markets m on m.id = t.market_id
    where upper(m.symbol) = ${symbol.toUpperCase()}
    order by t.ts desc, t.tx_hash desc, t.log_index desc limit ${limit}
  `;
  if (asRows<DbRow>(rows).length === 0) {
    const exists = await deps.sql`select 1 from markets where upper(symbol) = ${symbol.toUpperCase()} limit 1`;
    if (asRows<DbRow>(exists).length === 0) return null;
  }
  return asRows<DbRow>(rows);
}

export async function marketRegimes(deps: ApiDependencies, symbol: string, limit: number): Promise<DbRow[] | null> {
  const rows = await deps.sql`
    select r.tx_hash, r.from_regime, r.to_regime, r.ts
    from regime_log r join markets m on m.id = r.market_id
    where upper(m.symbol) = ${symbol.toUpperCase()}
    order by r.ts desc, r.tx_hash desc, r.log_index desc limit ${limit}
  `;
  if (asRows<DbRow>(rows).length === 0) {
    const exists = await deps.sql`select 1 from markets where upper(symbol) = ${symbol.toUpperCase()} limit 1`;
    if (asRows<DbRow>(exists).length === 0) return null;
  }
  return asRows<DbRow>(rows);
}
