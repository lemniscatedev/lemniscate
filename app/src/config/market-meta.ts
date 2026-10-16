import { z } from "zod";
import source from "./market-meta.json";

export const marketMetaSchema = z.object({
  name: z.string().trim().min(1).max(80),
  category: z.string().trim().min(1).max(40),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
}).strict();
export const marketMetadataSchema = z.record(z.string().regex(/^[A-Z][A-Z0-9.-]{0,15}$/), marketMetaSchema);
export type MarketMeta = z.infer<typeof marketMetaSchema>;
const metadata = marketMetadataSchema.parse(source);

export function marketMeta(symbol: string): MarketMeta | undefined {
  return Object.hasOwn(metadata, symbol.toUpperCase()) ? metadata[symbol.toUpperCase()] : undefined;
}
