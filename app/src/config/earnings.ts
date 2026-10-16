import { z } from "zod";
import source from "./earnings-overrides.json";

const overrideSchema = z.array(z.object({
  symbol: z.string().regex(/^[A-Z][A-Z0-9.-]{0,15}$/),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  session: z.enum(["pre", "post", "unknown"]),
  confirmed: z.boolean(),
  sourceUrl: z.string().url(),
  note: z.string().max(200).optional(),
}).strict());

export type EarningsOverride = z.infer<typeof overrideSchema>[number];

export const NO_EARNINGS = new Set(["SPY", "QQQ", "GLD", "ETH", "BTC"]);
export const earningsOverrides = overrideSchema.parse(source);

export function earningsSymbols(marketUnderlyings: string[], upcomingUnderlyings: string[]): string[] {
  return [...new Set([...marketUnderlyings, ...upcomingUnderlyings]
    .map((symbol) => symbol.toUpperCase())
    .filter((symbol) => symbol.length > 0 && !NO_EARNINGS.has(symbol)))].sort();
}
