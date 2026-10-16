import { z } from "zod";
import source from "./upcoming.json";

export const upcomingMarketConfigSchema = z.object({
  id: z.string().regex(/^[a-z0-9]{2,16}$/),
  symbol: z.string().regex(/^[A-Z][A-Z0-9]{0,15}$/),
  underlying: z.string().regex(/^[A-Z][A-Z0-9]{0,15}$/),
  curve: z.enum(["squared", "ratio", "cubed", "root", "downside"]),
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().min(1).max(200),
  tags: z.array(z.string().trim().min(1).max(32)).max(8),
}).strict();

export const upcomingMarketsConfigSchema = z.array(upcomingMarketConfigSchema)
  .refine((items) => new Set(items.map((item) => item.id)).size === items.length, "Upcoming ids must be unique.");

export const upcomingMarketConfig = upcomingMarketsConfigSchema.parse(source);
export type UpcomingMarketConfig = (typeof upcomingMarketConfig)[number];
