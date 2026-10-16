import type { SeriesView } from "../../db/queries/series";
import { marketInputs, seriesInputs, type NameContext } from "./context";
import { displayCost, quoteUnits, unitQuote, usdgText, wadText, type BuyBlock } from "./model";

const ONE_UNIT = 10n ** 18n;

export interface ChainOption {
  id: string;
  isCall: boolean;
  token: string;
  ask: string;
  bid: string;
  mark: string;
  spreadBps: number;
  dailyCostUsdg: string;
  displayCost: string;
  breakeven: string;
  delta: number;
  gamma: number;
  vega: number;
  sigmaBps: number;
  buyable: boolean;
  blockReason: BuyBlock | null;
}

/** Drop trailing zeros of a stored decimal ("110.000000000000000000" becomes "110"). */
export function trimDecimal(value: string): string {
  if (!value.includes(".")) return value;
  return value.replace(/0+$/, "").replace(/\.$/, "");
}

const round = (value: number): number => Number(value.toPrecision(10));

/** One series priced for one option unit. Null when no vol was ever posted for its speed. */
export function chainOption(series: SeriesView, ctx: NameContext): ChainOption | null {
  const market = marketInputs(ctx, series);
  const input = seriesInputs(series);
  const buy = quoteUnits(input, market, ONE_UNIT, true);
  const sell = quoteUnits(input, market, ONE_UNIT, false);
  const unit = unitQuote(input, market, false);
  if (!buy || !sell || !unit) return null;
  return {
    id: series.id,
    isCall: series.isCall,
    token: series.token,
    ask: usdgText(buy.usdg),
    bid: usdgText(sell.usdg),
    mark: wadText(buy.vMarkWad),
    spreadBps: buy.spreadBps,
    dailyCostUsdg: usdgText(buy.dailyCostUsdg),
    displayCost: displayCost(buy.dailyCostUsdg),
    breakeven: wadText(buy.breakevenWad),
    delta: round(unit.greeks.delta),
    gamma: round(unit.greeks.gamma),
    vega: round(unit.greeks.vega),
    sigmaBps: buy.sigmaBps,
    buyable: buy.buyable,
    blockReason: buy.buyBlock,
  };
}
