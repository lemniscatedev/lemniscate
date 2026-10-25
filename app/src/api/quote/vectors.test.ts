// Todo 15c R2: every case in contracts/test/vectors/quote-vectors.json, the file the engine's own test
// (EngineRisk.t.sol::test_R2_spreadScheduleMatchesApiModel) reproduces on chain, is reproduced by this model. The vector
// file is extended from the engine side only (cases 20-29: the worse-of trade TWAP and the sell hold). Inventory is off in the vectors (no pool/book state).
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { TAU } from "../../pricing";
import { quoteUnits, type MarketInputs, type SeriesInputs, type SessionName } from "./model";

interface VectorCase {
  isCall: boolean; tau: number; s: string; k: string; sigmaBps: number; session: number; units: string; isBuy: boolean;
  volStale: boolean; usdg: string; vMarkWad: string; spreadBps: number; feeUsdg: string; dailyCostUsdg: string;
  breakevenWad: string; outSigmaBps: number; buyable: boolean;
  /** 27d: PriceGuard.tradeTwap and the account's buy-time S (a hold on a sell), WAD; absent or "0": none. */
  tradeTwap?: string; holdS?: string;
}

const file = join(import.meta.dir, "../../../../contracts/test/vectors/quote-vectors.json");
const vectors = JSON.parse(readFileSync(file, "utf8")) as { cases: VectorCase[] };
const SESSIONS: SessionName[] = ["REGULAR", "EXTENDED", "CLOSED", "UNKNOWN", "HALTED"];
const usd = (wad: string): number => Number(BigInt(wad)) / 1e18;

/** |a - b| within one unit of the last place, or 1e-9 relative. */
function near(actual: bigint, expected: string, unit: bigint, label: string): void {
  const want = BigInt(expected);
  const diff = actual > want ? actual - want : want - actual;
  const rel = want === 0n ? Number(diff) : Number(diff) / Number(want);
  if (diff > unit && rel > 1e-9) throw new Error(`${label}: got ${actual}, vector ${want}`);
}

describe("quote-vectors.json", () => {
  test("has the 30 cases the engine test reads (20 base, 10 with the trade TWAP and hold rules)", () => {
    expect(vectors.cases.length).toBe(30);
    expect(vectors.cases.filter((c) => BigInt(c.tradeTwap ?? "0") > 0n || BigInt(c.holdS ?? "0") > 0n).length).toBe(10);
  });

  vectors.cases.forEach((c, i) => {
    test(`case ${i}: ${c.tau === TAU.DAILY ? "Daily" : "Weekly"} ${c.isCall ? "call" : "put"} K=${usd(c.k)} S=${usd(c.s)} ${c.isBuy ? "buy" : "sell"} ${SESSIONS[c.session]}${c.volStale ? " stale-vol" : ""}${BigInt(c.tradeTwap ?? "0") > 0n ? ` twap=${usd(c.tradeTwap!)}` : ""}${BigInt(c.holdS ?? "0") > 0n ? ` hold=${usd(c.holdS!)}` : ""}`, () => {
      const series: SeriesInputs = { isCall: c.isCall, speed: c.tau === TAU.DAILY ? "DAILY" : "WEEKLY", strike: usd(c.k), buyable: true, archived: false };
      const market: MarketInputs = {
        spot: usd(c.s), session: SESSIONS[c.session]!, fresh: true, priceBuysPaused: false, engineBuysPaused: false, sigmaBps: c.sigmaBps,
        skewK: 0n, volStale: c.volStale, buyBlockFromMs: null, buyBlockToMs: null, nowMs: 1_000_000,
        tradeTwap: BigInt(c.tradeTwap ?? "0") > 0n ? usd(c.tradeTwap!) : null,
        hold: BigInt(c.holdS ?? "0") > 0n ? { s: usd(c.holdS!), untilMs: 2_000_000 } : null,
      };
      const q = quoteUnits(series, market, BigInt(c.units), c.isBuy)!;
      near(q.usdg, c.usdg, 1n, "usdg");
      near(q.feeUsdg, c.feeUsdg, 1n, "feeUsdg");
      near(q.dailyCostUsdg, c.dailyCostUsdg, 1n, "dailyCostUsdg");
      near(q.vMarkWad, c.vMarkWad, 1n, "vMarkWad");
      near(q.breakevenWad, c.breakevenWad, 1n, "breakevenWad");
      expect(q.spreadBps).toBe(c.spreadBps);
      expect(q.sigmaBps).toBe(c.outSigmaBps);
      expect(q.session).toBe(SESSIONS[c.session]!);
      expect(q.buyable).toBe(c.buyable);
      expect(q.inventoryApplied).toBe(false);
    });
  });
});
