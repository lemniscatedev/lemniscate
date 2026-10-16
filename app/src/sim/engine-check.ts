// R3 harness: the simulator's quote against the on-chain engine for 20 states. The chain side is injected
// (a ChainQuoter), exactly like api/quote/parity.ts. The states below are deterministic; todo 23 sets each one on the
// anvil deployment (price, session, posted sigma) through `apply` and passes a quoter that calls
// IOptionEngine.quote(id, units, isBuy). Until the engine contract exists the CLI reports "pending-engine".
import { quoteUnits, type MarketInputs, type SeriesInputs, type SessionName, type Speed } from "../api/quote/model";
import { parityFailures, toRaw, type ChainQuoter } from "../api/quote/parity";
import { Rng } from "./rng";

export interface EngineState {
  name: string;
  series: SeriesInputs;
  market: MarketInputs;
  unitsWad: bigint;
  isBuy: boolean;
}

export const STATE_COUNT = 20;

export function buildStates(seed = 21, names: readonly string[] = ["NVDA", "TSLA", "SPY", "QQQ", "AAPL"]): EngineState[] {
  const rng = new Rng(seed);
  const sessions: SessionName[] = ["REGULAR", "REGULAR", "REGULAR", "EXTENDED", "CLOSED"];
  const out: EngineState[] = [];
  for (let i = 0; i < STATE_COUNT; i++) {
    const spot = rng.uniform(100, 800);
    const speed: Speed = i % 2 === 0 ? "DAILY" : "WEEKLY";
    const session = sessions[i % sessions.length]!;
    const strike = Math.round((spot * (1 + rng.pick([-0.1, -0.05, 0, 0.05, 0.1]))) / 5) * 5;
    out.push({
      name: names[i % names.length]!,
      series: { isCall: rng.chance(0.5), speed, strike, buyable: true, archived: false },
      market: {
        spot, session, fresh: true, priceBuysPaused: false, engineBuysPaused: false,
        sigmaBps: Math.round(rng.uniform(3000, 9000)), volStale: i % 7 === 6, buyBlockFromMs: null, buyBlockToMs: null, nowMs: 0,
      },
      unitsWad: BigInt(Math.round(rng.uniform(1, 200) * 1e6)) * 10n ** 12n,
      isBuy: i % 3 !== 2,
    });
  }
  return out;
}

export interface EngineCheckResult {
  status: "pass" | "fail" | "pending-engine";
  compared: number;
  failures: { index: number; fields: string[] }[];
}

export async function compareWithEngine(
  quoter: ChainQuoter,
  idFor: (state: EngineState) => string,
  apply: (state: EngineState) => Promise<void>,
  states: readonly EngineState[] = buildStates(),
): Promise<EngineCheckResult> {
  const failures: EngineCheckResult["failures"] = [];
  for (let i = 0; i < states.length; i++) {
    const state = states[i]!;
    await apply(state);
    const sim = quoteUnits(state.series, state.market, state.unitsWad, state.isBuy);
    if (!sim) { failures.push({ index: i, fields: ["sim returned no quote"] }); continue; }
    const chain = await quoter({ id: idFor(state), unitsWad: state.unitsWad, isBuy: state.isBuy });
    const fields = parityFailures(toRaw(sim), chain);
    if (fields.length > 0) failures.push({ index: i, fields });
  }
  return { status: failures.length === 0 ? "pass" : "fail", compared: states.length, failures };
}
