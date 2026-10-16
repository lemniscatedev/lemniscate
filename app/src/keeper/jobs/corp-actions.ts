import { encodeFunctionData, formatUnits, parseAbi, type Address } from "viem";
import { PriceGuardAbi } from "../../abi";
import { safeErrorSummary } from "../../log";
import type { KeeperContext } from "../context";

const multiplierAbi = parseAbi([
  "function uiMultiplier() view returns (uint256)",
  "function newUIMultiplier() view returns (uint256)",
  "function effectiveAt() view returns (uint256)",
]);
const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const array = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const decimal = (value: unknown): string | null => typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value) ? value : null;

export function processDate(value: unknown): string | null {
  const parts = object(value);
  if (![parts.year, parts.month, parts.day].every((part) => typeof part === "number" && Number.isInteger(part))) return null;
  const date = `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
  const parsed = new Date(`${date}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date ? date : null;
}

function matches(row: Record<string, unknown>, stock: string): boolean {
  return array(row.deployments).some((value) => {
    const deployment = object(value);
    return Number(deployment.chainId) === 4663 && String(deployment.contractAddress).toLowerCase() === stock.toLowerCase();
  });
}

interface Action {
  id: string; symbol: string; kind: string; status: string;
  processDate: string | null; effectiveAt: Date | null;
  oldMult: string | null; newMult: string | null;
  details: Record<string, unknown>; source: string;
}

export function normalizeCorporateActions(payload: unknown, markets: readonly { symbol: string; stock: string }[]): Action[] {
  return array(object(payload).corpActions).flatMap((value) => {
    const row = object(value);
    const market = markets.find((candidate) => matches(row, candidate.stock));
    if (!market || typeof row.id !== "string") return [];
    const kind = String(row.type ?? "unknown").replace(/^CORPORATE_ACTION_TYPE_/, "").toLowerCase();
    const status = String(row.status ?? "unknown").replace(/^CORPORATE_ACTION_STATUS_/, "").toLowerCase();
    return [{
      id: `robinhood:${row.id}`, symbol: market.symbol, kind, status,
      processDate: processDate(row.processDate), effectiveAt: null,
      oldMult: null, newMult: null, details: object(row.details), source: "robinhood",
    }];
  });
}

async function upsert(context: KeeperContext, action: Action): Promise<void> {
  await context.sql`insert into corp_actions (id,symbol,kind,status,process_date,effective_at,old_mult,new_mult,details,source)
    values (${action.id},${action.symbol},${action.kind},${action.status},${action.processDate},${action.effectiveAt?.toISOString() ?? null},
      ${action.oldMult},${action.newMult},${JSON.stringify(action.details)}::jsonb,${action.source})
    on conflict (id) do update set symbol=excluded.symbol,status=excluded.status,process_date=excluded.process_date,
      effective_at=coalesce(excluded.effective_at,corp_actions.effective_at),old_mult=coalesce(excluded.old_mult,corp_actions.old_mult),
      new_mult=coalesce(excluded.new_mult,corp_actions.new_mult),details=excluded.details,updated_at=now()`;
}

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`Robinhood informational API returned HTTP ${response.status}`);
  return response.json();
}

/** Issuer HTTP feeds are informational and rate-limited: asked at most this often. The on-chain reads run every time. */
const HTTP_EVERY_MS = 3_600_000;
/** PriceGuard is poked from this long before a multiplier change takes effect until this long after it. */
const POKE_BEFORE_SECONDS = 3_600;
const POKE_AFTER_SECONDS = 2 * 3_600;
const POKE_EVERY_MS = 1_800_000;

interface StockRef { symbol: string; stock: Address }

/** What a stock token says about its multiplier right now. */
export interface MultiplierReading { current: bigint; pending: bigint; effectiveAt: bigint }

/** True while a staged multiplier change is close enough to its effective time that PriceGuard should be poked so it
 * records the new baseline (it pauses buys and checks continuity by itself; the poke only advances its stored state). */
export function pokeDue(reading: MultiplierReading, nowSeconds: bigint): boolean {
  if (reading.pending === 0n || reading.pending === reading.current) {
    // A change that just took effect (the token may already report it as current): keep poking for a while.
    return reading.effectiveAt !== 0n && nowSeconds >= reading.effectiveAt && nowSeconds - reading.effectiveAt <= BigInt(POKE_AFTER_SECONDS);
  }
  if (reading.effectiveAt === 0n) return false;
  return nowSeconds + BigInt(POKE_BEFORE_SECONDS) >= reading.effectiveAt && nowSeconds <= reading.effectiveAt + BigInt(POKE_AFTER_SECONDS);
}

/** R4: records issuer corporate actions and staged multiplier changes, checks index continuity after they take
 * effect, and pokes PriceGuard around the effective time. It never changes a price or a series itself: PriceGuard
 * reacts on chain (pauses buys around a split-class change), the keeper informs and pokes. */
export async function updateCorporateActions(context: KeeperContext): Promise<Record<string, unknown>> {
  const metadata = await context.metadata();
  const now = context.now(metadata);
  const nowSeconds = BigInt(Math.floor(now.getTime() / 1000));
  const markets: StockRef[] = context.deployment.stocks.map((entry) => ({ symbol: entry.name, stock: entry.stock as Address }));
  if (!markets.length) throw new Error("Deployment lists no stocks");
  const failures: string[] = [];
  let stored = 0;

  const status = await context.sql<{ meta: Record<string, unknown> }[]>`select meta from keeper_status where job='corp-actions'`;
  const prior = status[0]?.meta ?? {};
  const lastHttpAt = Date.parse(String(prior.lastHttpAt ?? ""));
  let httpAt = String(prior.lastHttpAt ?? "");
  if (!Number.isFinite(lastHttpAt) || Date.now() - lastHttpAt >= HTTP_EVERY_MS) {
    const responses = await Promise.allSettled([
      fetchJson("https://api.robinhood.com/rhj/assets"),
      fetchJson("https://api.robinhood.com/rhj/corporate-actions"),
    ]);
    for (const response of responses) if (response.status === "rejected") {
      const error = safeErrorSummary(response.reason);
      failures.push(error.message);
      context.logger.warn({ err: error }, "Corporate-action HTTP source unavailable");
    }
    const assets = responses[0]!;
    if (assets.status === "fulfilled") for (const value of array(object(assets.value).assets)) {
      const row = object(value);
      const market = markets.find((candidate) => matches(row, candidate.stock));
      const current = decimal(row.currentMultiplier);
      const pending = decimal(row.pendingMultiplier);
      if (!market || !pending || !current || pending === current) continue;
      const effective = typeof row.pendingMultiplierEffectiveTime === "string" ? new Date(row.pendingMultiplierEffectiveTime) : null;
      const effectiveAt = effective && Number.isFinite(effective.getTime()) ? effective : null;
      await upsert(context, {
        id: `pending:${market.stock}:${effectiveAt?.toISOString() ?? pending}`, symbol: market.symbol,
        kind: "multiplier", status: "scheduled", processDate: null, effectiveAt,
        oldMult: current, newMult: pending, details: {}, source: "robinhood",
      });
      stored++;
    }
    const actions = responses[1]!;
    if (actions.status === "fulfilled") for (const action of normalizeCorporateActions(actions.value, markets)) {
      await upsert(context, action); stored++;
    }
    httpAt = new Date().toISOString();
  }

  // On-chain multiplier state of every launch stock, every run.
  const calls = markets.flatMap((market) => (["uiMultiplier", "newUIMultiplier", "effectiveAt"] as const)
    .map((functionName) => ({ address: market.stock, abi: multiplierAbi, functionName })));
  const result = await context.clients.stateClient.multicall({ contracts: calls, allowFailure: true });
  const pokes: Address[] = [];
  const pokedAt = (typeof prior.pokedAt === "object" && prior.pokedAt ? prior.pokedAt : {}) as Record<string, number>;
  for (let i = 0; i < markets.length; i++) {
    const market = markets[i]!;
    const values = result.slice(i * 3, i * 3 + 3);
    if (values.some((value) => value.status !== "success")) {
      failures.push(`Multiplier read failed for ${market.symbol}`); continue;
    }
    const [current, pending, effective] = values.map((value) => value.result as bigint) as [bigint, bigint, bigint];
    if (pending !== 0n && pending !== current && effective > nowSeconds) {
      await upsert(context, {
        id: `multiplier:${market.stock}:${effective}`, symbol: market.symbol, kind: "multiplier",
        status: "scheduled", processDate: null, effectiveAt: new Date(Number(effective) * 1000),
        oldMult: formatUnits(current, 18), newMult: formatUnits(pending, 18), details: {}, source: "onchain",
      });
      stored++;
    }
    if (pokeDue({ current, pending, effectiveAt: effective }, nowSeconds) && Date.now() - (pokedAt[market.stock] ?? 0) >= POKE_EVERY_MS) {
      pokes.push(market.stock);
    }
  }

  const poked: string[] = [];
  for (const stock of pokes) {
    try {
      const sent = await context.tx.submit({
        label: "corp-actions:poke", to: context.deployment.contracts.priceGuard as Address,
        data: encodeFunctionData({ abi: PriceGuardAbi, functionName: "poke", args: [stock] }),
      });
      if (!sent.simulated) pokedAt[stock] = Date.now();
      poked.push(stock);
    } catch (error) {
      const summary = safeErrorSummary(error);
      failures.push(`Poke failed: ${summary.message}`);
      context.logger.warn({ stock, err: summary }, "PriceGuard poke failed");
    }
  }

  // Index continuity an hour after a change took effect: the spot (multiplier embedded in the feed) must not jump.
  const stockOf = new Map(markets.map((market) => [market.symbol, market.stock]));
  const pending = await context.sql<{ id: string; symbol: string; effective_at: Date | string }[]>`
    select id, symbol, effective_at from corp_actions
    where effective_at <= ${new Date(now.getTime() - 3600000).toISOString()} and verified_continuity is null`;
  for (const action of pending) {
    const stockToken = stockOf.get(action.symbol);
    if (!stockToken) continue;
    const effectiveAt = new Date(action.effective_at);
    const from = new Date(effectiveAt.getTime() - 3600000);
    const to = new Date(effectiveAt.getTime() + 3600000);
    const rows = await context.sql<{ before: string | null; after: string | null }[]>`
      select avg(spot) filter(where ts < ${effectiveAt.toISOString()}) as before,
        avg(spot) filter(where ts >= ${effectiveAt.toISOString()}) as after
      from ticks where stock_token=${stockToken} and ts between ${from.toISOString()} and ${to.toISOString()}`;
    const before = Number(rows[0]?.before ?? 0);
    const after = Number(rows[0]?.after ?? 0);
    if (!(before > 0 && after > 0)) continue;
    const verified = Math.abs(after / before - 1) < 0.02;
    await context.sql`update corp_actions set verified_continuity=${verified},status='completed',updated_at=now() where id=${action.id}`;
    if (!verified) context.logger.warn({ action: action.id }, "Corporate-action index continuity differs by more than 2%");
  }
  return { stored, failures, poked, pokedAt, lastHttpAt: httpAt };
}
