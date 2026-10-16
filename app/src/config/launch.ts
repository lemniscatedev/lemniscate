import { z } from "zod";
import source from "./launch.json";

export const launchConfigSchema = z.object({
  launchedByDefault: z.array(z.string().regex(/^[A-Z][A-Z0-9]{0,15}$/)).max(64),
}).strict();

const launchConfig = launchConfigSchema.parse(source);
const launchedByDefault = new Set(launchConfig.launchedByDefault);

export function isLaunched(symbol: string, override: boolean | undefined): boolean {
  return override ?? launchedByDefault.has(symbol.toUpperCase());
}
