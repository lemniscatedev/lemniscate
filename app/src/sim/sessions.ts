import { FULL_DAY_CLOSURES } from "../keeper/holidays";
import type { SessionName } from "../api/quote/model";

/** US equity session for a unix-second timestamp, against the 24/5 feed calendar (chain-facts R7):
 * REGULAR 09:30-16:00 New York (13:30-20:00 UTC while EDT, which covers the Jul to mid-Oct 2026 window),
 * EXTENDED the rest of Mon 00:00 UTC to Sat 00:00 UTC (the overnight and pre/post sessions), CLOSED over the weekend
 * and on full-day NYSE closures. */
export function sessionAt(tSec: number): SessionName {
  const d = new Date(tSec * 1000);
  const day = d.getUTCDay(); // 0 Sun .. 6 Sat
  if (day === 0 || day === 6) return "CLOSED";
  if (FULL_DAY_CLOSURES.has(d.toISOString().slice(0, 10))) return "CLOSED";
  const minutes = d.getUTCHours() * 60 + d.getUTCMinutes();
  return minutes >= 13 * 60 + 30 && minutes < 20 * 60 ? "REGULAR" : "EXTENDED";
}

export const isBuyableSession = (s: SessionName): boolean => s === "REGULAR" || s === "EXTENDED";
