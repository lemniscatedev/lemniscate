import type { ApiDependencies, DbRow } from "../../api/types";
import { asRows, jsonRecord, numberValue, textValue, dateValue } from "../../api/types";
import { safeErrorSummary } from "../../log";

interface StatusRow extends DbRow {
  job: string;
  last_ok: Date | string | null;
  last_error: string | null;
  last_run: Date | string | null;
  meta: unknown;
}

function optionalBlock(value: unknown): number | null {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function collectRpcCounters(value: unknown): Array<{ id: string; requestsToday: number; estimatedCuToday: number; cooling: boolean }> {
  const record = jsonRecord(value);
  const entries = Array.isArray(record.keys)
    ? record.keys
    : Array.isArray(record.endpoints)
      ? record.endpoints
      : Object.entries(record).map(([kind, counters]) => ({ kind, ...(jsonRecord(counters)) }));
  const byId = new Map<string, { id: string; requestsToday: number; estimatedCuToday: number; cooling: boolean }>();
  let alchemyNumber = 0;
  for (const entry of entries) {
    const row = jsonRecord(entry);
    const kind = String(row.kind ?? row.type ?? row.id ?? "").toLowerCase();
    const isOverride = kind.includes("override");
    const isAlchemy = kind.includes("alchemy") || /^key#\d+$/i.test(kind);
    const id = isOverride ? "override" : isAlchemy ? `key#${++alchemyNumber}` : kind.includes("public") ? "public" : undefined;
    if (!id) continue;
    const classes = jsonRecord(row.classes);
    const classCounters = Object.values(classes).map(jsonRecord);
    const requests = numberValue(row.requestsToday ?? row.requests ?? row.requestCount,
      classCounters.reduce((total, counters) => total + numberValue(counters.requests), 0));
    const cu = numberValue(row.estimatedCuToday ?? row.estimatedCu ?? row.cu,
      classCounters.reduce((total, counters) => total + numberValue(counters.estimatedCu), 0));
    const prior = byId.get(id);
    byId.set(id, {
      id,
      requestsToday: (prior?.requestsToday ?? 0) + requests,
      estimatedCuToday: (prior?.estimatedCuToday ?? 0) + cu,
      cooling: Boolean(prior?.cooling || row.cooling),
    });
  }
  return [...byId.values()];
}

const defaultIntervalsMs: Readonly<Record<string, number>> = {
  sessions: 60 * 60_000,
  accrue: 6 * 60 * 60_000,
  hedge: 15 * 60_000,
  carry: 24 * 60 * 60_000,
  risk: 60_000,
  "corp-actions": 60 * 60_000,
};

export async function healthResponse(deps: ApiDependencies) {
  const [ping, cursorResult, statusesResult] = await Promise.all([
    deps.sql`select 1 as ok`,
    deps.sql`select block from cursors where name = 'main' limit 1`,
    deps.sql`select job, last_ok, last_error, last_run, meta from keeper_status order by job`,
  ]);
  void ping;
  const cursor = asRows<DbRow>(cursorResult)[0];
  const statuses = asRows<StatusRow>(statusesResult);
  const statusByJob = new Map(statuses.map((row) => [row.job, row]));
  const indexer = statusByJob.get("indexer");
  const indexerMeta = jsonRecord(indexer?.meta);
  const keeper = Object.fromEntries(statuses
    .filter((row) => row.job !== "indexer" && row.job !== "api")
    // Coarse status only: raw job errors can carry RPC/node details and stay in logs.
    .map((row) => [row.job, {
      status: row.last_error ? "error" as const : dateValue(row.last_ok) ? "ok" as const : "pending" as const,
      lastOk: dateValue(row.last_ok)?.toISOString() ?? null,
      lastRun: dateValue(row.last_run)?.toISOString() ?? null,
    }]));
  const indexed = optionalBlock(indexerMeta.lastIndexedBlock ?? cursor?.block);
  const head = optionalBlock(indexerMeta.lastHeadBlock ?? indexerMeta.headBlock);
  const lag = indexed === null || head === null ? optionalBlock(indexerMeta.lagBlocks) : Math.max(0, head - indexed);
  const warnings: string[] = [];
  if (lag !== null && lag > 60) warnings.push(`Indexer is ${lag} blocks behind.`);
  const nowMs = Date.now();
  if (indexer?.last_error) warnings.push("Indexer processing failed.");
  const indexerLastOk = dateValue(indexer?.last_ok);
  if (!indexerLastOk) warnings.push("Indexer has not completed initial synchronization.");
  else if (nowMs - indexerLastOk.getTime() > Math.max(60_000, 3 * deps.config.INDEXER_POLL_IDLE_MS)) {
    warnings.push("Indexer has stopped reporting successful polls.");
  }
  for (const row of statuses) {
    if (row.job === "indexer" || row.job === "api") continue;
    const meta = jsonRecord(row.meta);
    const lastOk = dateValue(row.last_ok);
    const intervalMs = numberValue(meta.intervalMs, defaultIntervalsMs[row.job] ?? 0);
    if (row.last_error) warnings.push(`Keeper job ${row.job} is failing.`);
    if (!lastOk && (row.last_error || dateValue(row.last_run))) {
      warnings.push(`Keeper job ${row.job} has not succeeded yet.`);
      continue;
    }
    if (lastOk && intervalMs > 0 && nowMs - lastOk.getTime() > 3 * intervalMs) {
      warnings.push(`Keeper job ${row.job} has not succeeded within three intervals.`);
    }
  }
  const riskMeta = jsonRecord(statusByJob.get("risk")?.meta);
  const riskWarnings = Array.isArray(riskMeta.warnings) ? riskMeta.warnings.map(String) : [];
  warnings.push(...riskWarnings.map((warning) => safeErrorSummary(new Error(warning)).message));
  if (riskWarnings.some((warning) => /keeper.{0,20}eth|eth.{0,20}low/i.test(warning))) {
    warnings.push("Keeper ETH balance is low.");
  }
  const keeperEth = Number(riskMeta.keeperEth ?? riskMeta.keeperEthBalance);
  if (Number.isFinite(keeperEth) && keeperEth < 0.002) warnings.push("Keeper ETH balance is low.");

  const accrueMeta = jsonRecord(statusByJob.get("accrue")?.meta);
  const lateBoundaryObservedAt = dateValue(accrueMeta.lateBoundaryObservedAt);
  if (accrueMeta.lateBoundary && lateBoundaryObservedAt) {
    const ageMs = nowMs - lateBoundaryObservedAt.getTime();
    if (ageMs >= 0 && ageMs <= 24 * 60 * 60_000) {
      const lateSeconds = numberValue(accrueMeta.lateSeconds);
      warnings.push(lateSeconds > 0
        ? `Keeper session accrual ran ${Math.round(lateSeconds)} seconds late.`
        : "Keeper session accrual ran late.");
    }
  }

  const rpcSources = statuses.map((row) => jsonRecord(row.meta).rpc).filter(Boolean);
  const rpc = rpcSources.flatMap(collectRpcCounters);
  const rpcMap = new Map<string, { id: string; requestsToday: number; estimatedCuToday: number; cooling: boolean }>();
  for (const counter of rpc) {
    const prior = rpcMap.get(counter.id);
    rpcMap.set(counter.id, {
      id: counter.id,
      requestsToday: (prior?.requestsToday ?? 0) + counter.requestsToday,
      estimatedCuToday: (prior?.estimatedCuToday ?? 0) + counter.estimatedCuToday,
      cooling: Boolean(prior?.cooling || counter.cooling),
    });
  }
  const rpcDate = textValue(indexerMeta.rpcDate ?? jsonRecord(indexerMeta.rpc).date, new Date().toISOString().slice(0, 10));
  return {
    ok: true,
    db: { ok: true },
    lastIndexedBlock: indexed,
    headBlock: head,
    lagBlocks: lag,
    keeper,
    rpc: { date: rpcDate, keys: [...rpcMap.values()] },
    warnings: [...new Set(warnings)],
  };
}

export function databaseDownHealth() {
  return {
    ok: false,
    db: { ok: false },
    lastIndexedBlock: null,
    headBlock: null,
    lagBlocks: null,
    keeper: {},
    rpc: { date: null, keys: [] },
    warnings: ["Database is unavailable."],
  };
}
