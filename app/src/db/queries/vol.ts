import { apiNow } from "../../api/clock";
import type { ApiDependencies, DbRow } from "../../api/types";
import { asRows, numberValue, textValue } from "../../api/types";

const DAY_MS = 86_400_000;
const YEAR_MS = 365 * DAY_MS;
const round2 = (value: number): number => Math.round(value * 100) / 100;

export interface VolPoint { t: number; spot: number }
export interface MarketVol {
  symbol: string;
  realized7dPct: number | null;
  realized30dPct: number | null;
  carryImpliedPct: number | null;
  annualCarryPct: number | null;
  carryToVariance: number | null;
  samples7d: number;
  samples30d: number;
  history: { t: number; realized7dPct: number }[];
}

/** Annualize squared log returns by elapsed calendar time, including session gaps. */
export function realizedVolPct(points: VolPoint[], fromMs: number, toMs: number): { pct: number | null; samples: number } {
  const kept = points.filter(({ t, spot }) => t >= fromMs && t <= toMs && Number.isFinite(spot) && spot > 0)
    .sort((a, b) => a.t - b.t);
  const samples = Math.max(0, kept.length - 1);
  const elapsed = kept.length > 1 ? kept[kept.length - 1]!.t - kept[0]!.t : 0;
  if (samples < 24 || elapsed < 2 * DAY_MS) return { pct: null, samples };
  const sumSquares = kept.slice(1).reduce((sum, point, index) =>
    sum + Math.log(point.spot / kept[index]!.spot) ** 2, 0);
  return { pct: round2(Math.sqrt(sumSquares / (elapsed / YEAR_MS)) * 100), samples };
}

export function carryImplied(dailyCarry: number | null): { carryImpliedPct: number | null; annualCarryPct: number | null } {
  if (dailyCarry === null || !Number.isFinite(dailyCarry)) return { carryImpliedPct: null, annualCarryPct: null };
  return {
    carryImpliedPct: dailyCarry > 0 ? round2(Math.sqrt(dailyCarry * 365) * 100) : null,
    annualCarryPct: round2(dailyCarry * 365 * 100),
  };
}

export function carryToVariance(annualCarryPct: number | null, realized30dPct: number | null): number | null {
  if (annualCarryPct === null || realized30dPct === null || !Number.isFinite(annualCarryPct)
    || !Number.isFinite(realized30dPct) || realized30dPct <= 0) return null;
  return round2((annualCarryPct / 100) / (realized30dPct / 100) ** 2);
}

export function volHistory(points: VolPoint[], nowMs: number): MarketVol["history"] {
  const midnight = Math.floor(nowMs / DAY_MS) * DAY_MS;
  const history: MarketVol["history"] = [];
  for (let ago = 29; ago >= 0; ago--) {
    const t = midnight - ago * DAY_MS;
    const { pct } = realizedVolPct(points, t - 7 * DAY_MS, t);
    if (pct !== null) history.push({ t, realized7dPct: pct });
  }
  return history;
}

export function sortVolBoard<T extends Pick<MarketVol, "symbol" | "carryToVariance">>(markets: T[]): T[] {
  return [...markets].sort((a, b) =>
    (a.carryToVariance ?? Infinity) - (b.carryToVariance ?? Infinity) || a.symbol.localeCompare(b.symbol));
}

export async function allMarketVols(deps: ApiDependencies, requestedNow?: Date): Promise<MarketVol[]> {
  const now = requestedNow ?? await apiNow(deps);
  const nowIso = now.toISOString();
  const nowMs = now.getTime();
  const [closes, carries] = await Promise.all([
    deps.sql`
      select m.symbol, floor(extract(epoch from time_bucket(interval '1 hour', t.ts)) * 1000)::bigint as t,
        last(t.spot, t.ts)::text as spot
      from ticks t join markets m on m.id = t.market_id
      where t.regime = 0 and t.ts >= ${nowIso}::timestamptz - interval '37 days' and t.ts <= ${nowIso}::timestamptz
      group by m.symbol, time_bucket(interval '1 hour', t.ts)
      order by m.symbol, 2
    `,
    deps.sql`
      select m.symbol, x.carry_wad::text as carry_wad
      from markets m
      left join lateral (
        select carry_wad from ticks where market_id = m.id and ts <= ${nowIso}::timestamptz order by ts desc limit 1
      ) x on true
      order by m.id
    `,
  ]);
  const bySymbol = new Map<string, VolPoint[]>();
  for (const row of asRows<DbRow>(closes)) {
    const symbol = textValue(row.symbol);
    const points = bySymbol.get(symbol) ?? [];
    points.push({ t: numberValue(row.t, NaN), spot: numberValue(row.spot, NaN) });
    bySymbol.set(symbol, points);
  }
  return asRows<DbRow>(carries).map((row) => {
    const symbol = textValue(row.symbol);
    const points = bySymbol.get(symbol) ?? [];
    const r7 = realizedVolPct(points, nowMs - 7 * DAY_MS, nowMs);
    const r30 = realizedVolPct(points, nowMs - 30 * DAY_MS, nowMs);
    const implied = carryImplied(row.carry_wad === null ? null : Number(row.carry_wad));
    return {
      symbol, realized7dPct: r7.pct, realized30dPct: r30.pct, ...implied,
      carryToVariance: carryToVariance(implied.annualCarryPct, r30.pct),
      samples7d: r7.samples, samples30d: r30.samples, history: volHistory(points, nowMs),
    };
  });
}
