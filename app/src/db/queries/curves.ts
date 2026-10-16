import { apiNow } from "../../api/clock";
import type { ApiDependencies } from "../../api/types";
import { upcomingMarketConfig, type UpcomingMarketConfig } from "../../config/upcoming";
import { CURVE_EXPONENTS, CURVE_NOTATION, CURVE_ORDER, curvePayoffPct, fairCarryAnnual, fairCarryDailyPct, type TradableCurve } from "../../lib/curves";
import type { Curve } from "../../lib/market-kind";
import { allMarketVols } from "./vol";
import { listMarkets, type MarketView } from "./markets";

export const CURVE_MOVES = [-20, -10, -5, 5, 10, 20] as const;

export type CurveSigmaSource = "realized30d" | "realized7d" | null;
export type CurveStatus = "live" | "coming" | "preview";

export interface CurveTableRow {
  curve: TradableCurve;
  exponent: number;
  notation: string;
  displaySymbol: string;
  status: CurveStatus;
  marketSymbol: string | null;
  payoffs: { movePct: number; indexPct: number | null }[];
  fairCarryDailyPct: number | null;
  fairCarryAnnualPct: number | null;
  carryDirection: "holder_pays" | "holder_receives" | "none" | null;
  liveDailyCarryPct: number | null;
}

export interface CurveTable {
  symbol: string;
  underlying: string;
  sigmaAnnualPct: number | null;
  sigmaSource: CurveSigmaSource;
  moves: number[];
  curves: CurveTableRow[];
  asOf: string;
}

export interface BuildCurveTableInput {
  symbol: string;
  underlying: string;
  liveCurve: Curve;
  sigmaAnnual: number | null;
  sigmaSource: CurveSigmaSource;
  liveDailyCarryPct: number | null;
  upcoming: ReadonlyArray<Pick<UpcomingMarketConfig, "underlying" | "curve" | "symbol">>;
  /** Explicit query time; this keeps the builder deterministic. */
  asOf: Date;
}

const round2 = (value: number): number => Math.round(value * 100) / 100;

export function buildCurveTable(input: BuildCurveTableInput): CurveTable {
  const sigma = input.sigmaAnnual !== null && Number.isFinite(input.sigmaAnnual) && input.sigmaAnnual >= 0
    ? input.sigmaAnnual
    : null;
  const upcomingByCurve = new Map<TradableCurve, Pick<UpcomingMarketConfig, "symbol">>();
  for (const item of input.upcoming) {
    if (item.underlying.toUpperCase() !== input.underlying.toUpperCase()) continue;
    if (CURVE_ORDER.includes(item.curve as TradableCurve)) upcomingByCurve.set(item.curve as TradableCurve, item);
  }

  const curves = CURVE_ORDER.map((curve): CurveTableRow => {
    const upcoming = upcomingByCurve.get(curve);
    const status: CurveStatus = curve === input.liveCurve ? "live" : upcoming ? "coming" : "preview";
    const annualCarry = sigma === null ? null : fairCarryAnnual(CURVE_EXPONENTS[curve], sigma);
    const carryDirection = annualCarry === null ? null
      : annualCarry > 0 ? "holder_pays"
      : annualCarry < 0 ? "holder_receives" : "none";

    return {
      curve,
      exponent: CURVE_EXPONENTS[curve],
      notation: CURVE_NOTATION[curve],
      displaySymbol: `${input.underlying}${CURVE_NOTATION[curve]}`,
      status,
      marketSymbol: status === "live" ? input.symbol : status === "coming" ? upcoming?.symbol ?? null : null,
      payoffs: CURVE_MOVES.map((movePct) => ({
        movePct,
        indexPct: curvePayoffPct(CURVE_EXPONENTS[curve], movePct),
      })),
      fairCarryDailyPct: sigma === null ? null : fairCarryDailyPct(CURVE_EXPONENTS[curve], sigma),
      fairCarryAnnualPct: annualCarry === null ? null : round2(annualCarry * 100),
      carryDirection,
      liveDailyCarryPct: status === "live" ? input.liveDailyCarryPct : null,
    };
  });

  return {
    symbol: input.symbol,
    underlying: input.underlying,
    sigmaAnnualPct: sigma === null ? null : round2(sigma * 100),
    sigmaSource: sigma === null ? null : input.sigmaSource,
    moves: [...CURVE_MOVES],
    curves,
    asOf: input.asOf.toISOString(),
  };
}

export async function marketCurves(deps: ApiDependencies, symbol: string, requestedNow?: Date): Promise<CurveTable | null> {
  const now = requestedNow ?? await apiNow(deps);
  const markets = await deps.cache.getOrLoad("markets:list", 3_000, () => listMarkets(deps, now));
  const market = markets.find((item: MarketView) => item.symbol.toUpperCase() === symbol.toUpperCase() && item.launched);
  if (!market) return null;

  const vols = await deps.cache.getOrLoad("vol:all", 600_000, () => allMarketVols(deps, now));
  const vol = vols.find((item) => item.symbol === market.symbol);
  const realized30d = vol?.realized30dPct;
  const realized7d = vol?.realized7dPct;
  const sigmaSource: CurveSigmaSource = typeof realized30d === "number" && Number.isFinite(realized30d)
    ? "realized30d"
    : typeof realized7d === "number" && Number.isFinite(realized7d) ? "realized7d" : null;
  const sigmaPct = sigmaSource === "realized30d" && realized30d !== undefined ? realized30d
    : sigmaSource === "realized7d" && realized7d !== undefined ? realized7d : null;

  return buildCurveTable({
    symbol: market.symbol,
    underlying: market.underlying,
    liveCurve: market.curve,
    sigmaAnnual: sigmaPct === null ? null : sigmaPct / 100,
    sigmaSource,
    liveDailyCarryPct: market.dailyCarryPct,
    upcoming: upcomingMarketConfig,
    asOf: now,
  });
}
