import { formatUnits, parseAbi, type Address } from "viem";
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

export async function updateCorporateActions(context: KeeperContext): Promise<Record<string, unknown>> {
  const metadata = await context.metadata();
  const now = context.now(metadata);
  const markets = Object.values(metadata.marketsById ?? {});
  if (!markets.length) throw new Error("Waiting for indexed market registry before corporate-action checks");
  const responses = await Promise.allSettled([
    fetchJson("https://api.robinhood.com/rhj/assets"),
    fetchJson("https://api.robinhood.com/rhj/corporate-actions"),
  ]);
  let stored = 0;
  const failures: string[] = [];
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

  const status = await context.sql<{ meta: Record<string, unknown> }[]>`select meta from keeper_status where job='corp-actions'`;
  const today = now.toISOString().slice(0, 10);
  let multiplierCheckDate = String(status[0]?.meta.multiplierCheckDate ?? "");
  if (multiplierCheckDate !== today) {
    const calls = markets.flatMap((market) => (["uiMultiplier", "newUIMultiplier", "effectiveAt"] as const)
      .map((functionName) => ({ address: market.stock as Address, abi: multiplierAbi, functionName })));
    const result = await context.clients.stateClient.multicall({ contracts: calls, allowFailure: true });
    for (let i = 0; i < markets.length; i++) {
      const values = result.slice(i * 3, i * 3 + 3);
      if (values.some((value) => value.status !== "success")) {
        failures.push(`Multiplier read failed for ${markets[i]!.symbol}`); continue;
      }
      const [current, pending, effective] = values.map((value) => value.result as bigint);
      if (current === undefined || pending === undefined || effective === undefined || pending === 0n || pending === current || effective <= BigInt(Math.floor(now.getTime() / 1000))) continue;
      await upsert(context, {
        id: `multiplier:${markets[i]!.stock}:${effective}`, symbol: markets[i]!.symbol, kind: "multiplier",
        status: "scheduled", processDate: null, effectiveAt: new Date(Number(effective) * 1000),
        oldMult: formatUnits(current, 18), newMult: formatUnits(pending, 18), details: {}, source: "onchain",
      });
      stored++;
    }
    multiplierCheckDate = today;
  }

  const pending = await context.sql<{ id: string; market_id: number; effective_at: Date | string }[]>`
    select a.id,m.id as market_id,a.effective_at from corp_actions a join markets m on a.symbol=m.symbol
    where a.effective_at <= ${new Date(now.getTime() - 3600000).toISOString()} and a.verified_continuity is null`;
  for (const action of pending) {
    const effectiveAt = new Date(action.effective_at);
    const from = new Date(effectiveAt.getTime() - 3600000);
    const to = new Date(effectiveAt.getTime() + 3600000);
    const rows = await context.sql<{ before: string | null; after: string | null }[]>`
      select avg("index") filter(where ts < ${effectiveAt.toISOString()}) as before,
        avg("index") filter(where ts >= ${effectiveAt.toISOString()}) as after
      from ticks where market_id=${action.market_id} and ts between ${from.toISOString()} and ${to.toISOString()}`;
    const before = Number(rows[0]?.before ?? 0);
    const after = Number(rows[0]?.after ?? 0);
    if (!(before > 0 && after > 0)) continue;
    const verified = Math.abs(after / before - 1) < 0.02;
    await context.sql`update corp_actions set verified_continuity=${verified},status='completed',updated_at=now() where id=${action.id}`;
    if (!verified) context.logger.warn({ action: action.id }, "Corporate-action index continuity differs by more than 2%");
  }
  return { stored, failures, multiplierCheckDate };
}
