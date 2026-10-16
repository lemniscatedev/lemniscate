import { join } from "node:path";

/** Local, gitignored cache of historical rounds. */
export const CACHE_DIR = join(import.meta.dir, "../../scripts/replay/.cache");

/** rounds: [roundNumber, updatedAtUnixSeconds, answerRaw (string, feed decimals)] */
export interface CachedRounds {
  name: string;
  decimals: number;
  rounds: [number, number, string][];
}
