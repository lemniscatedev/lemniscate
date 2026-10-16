import type { Logger } from "pino";
import type { Sql } from "postgres";
import type { Address } from "viem";
import type { OptionDeployment } from "../chain/deployment";
import { LEMNISCATE_EVENTS_CHANNEL } from "../db/notify";
import { safeErrorSummary } from "../log";
import type { ChainSource } from "./chain-source";
import { decodeChainLog, listedSeries, watchedStockTopics } from "./events";
import { handleEvents } from "./handlers";
import { rollbackAfter } from "./rollback";
import { takeSnapshot, type SnapshotReader } from "./snapshot";
import type { BlockHeader, ChainEvent, IndexerContext, RpcLog, SeriesInfo } from "./types";
import { asNumber } from "./units";

const INITIAL_RANGE = 50_000n;
const MAX_RANGE = 200_000n;
/** pool_nav is snapshotted at least this often, and on every trade. */
export const SNAPSHOT_HEARTBEAT_MS = 10 * 60_000;
const SNAPSHOT_DEBOUNCE_MS = 2_000;
const ACTIVE_EVENT_MS = 2 * 60_000;
const IDLE_AFTER_MS = 30 * 60_000;
/** A block hash that changed deeper than this many blocks is not repaired automatically. */
export const MAX_REORG_DEPTH = 20n;
/** How many recent block hashes are kept for reorg detection. */
export const HASH_WINDOW = 32n;
const DISCOVERY_PASSES = 4;

export interface IndexerSettings {
  /** Blocks behind the head that are treated as final. 0 ingests the head and relies on reorg repair. */
  readonly confirmations: number;
  readonly pollActiveMs: number;
  readonly pollBaseMs: number;
  readonly pollIdleMs: number;
}

export class ReorgTooDeepError extends Error {
  constructor(readonly cursor: bigint, readonly depth: bigint | undefined) {
    super(
      depth === undefined
        ? `Block hashes disagree with the chain further back than the ${HASH_WINDOW} blocks kept (cursor ${cursor}); needs a manual re-index`
        : `Reorg of ${depth} blocks at cursor ${cursor} exceeds the automatic limit of ${MAX_REORG_DEPTH}; needs a manual re-index`,
    );
    this.name = "ReorgTooDeepError";
  }
}

export interface IndexerState {
  readonly settings: IndexerSettings;
  readonly source: ChainSource;
  readonly reader: SnapshotReader;
  readonly sql: Sql;
  readonly logger: Logger;
  readonly deployment: OptionDeployment;
  readonly now: () => number;
  /** Lightweight RPC counters for the status row (the RPC pool's stats in production). */
  readonly rpcStats: () => unknown;
  readonly seriesByToken: Map<string, SeriesInfo>;
  readonly stockNames: Map<string, string>;
  readonly stockFeeds: Map<string, string>;
  readonly lemniscateAddresses: Set<Address>;
  cursor: bigint;
  range: bigint;
  successfulRanges: number;
  pendingSnapshot: boolean;
  lastEventAt: number;
  lastLemniscateEventAt: number;
  lastSnapshotAt: number;
  /** Unix seconds of the last indexed block, for the keeper's fork clock. */
  lastIndexedBlockTime: number;
  failureBackoffMs: number;
}

export interface TickResult {
  readonly delayMs: number;
  readonly caughtUp: boolean;
  readonly processedTo?: bigint;
  readonly events: number;
  readonly reorgDepth?: bigint;
}

export interface CreateIndexerStateArgs {
  readonly settings: IndexerSettings;
  readonly source: ChainSource;
  readonly reader: SnapshotReader;
  readonly sql: Sql;
  readonly logger: Logger;
  readonly deployment: OptionDeployment;
  readonly now?: () => number;
  readonly rpcStats?: () => unknown;
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function parseDate(value: unknown, fallback: number): number {
  if (typeof value !== "string") return fallback;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function confirmedAt(settings: IndexerSettings, head: bigint): bigint {
  const confirmations = BigInt(settings.confirmations);
  return head > confirmations ? head - confirmations : 0n;
}

export async function createIndexerState(args: CreateIndexerStateArgs): Promise<IndexerState> {
  const { sql, deployment } = args;
  const initialBlock = BigInt(deployment.deployBlock) - 1n;
  await sql`
    INSERT INTO cursors (name, block, updated_at) VALUES ('main', ${initialBlock.toString()}, NOW())
    ON CONFLICT (name) DO NOTHING
  `;
  const [cursorRows, statusRows, seriesRows] = await Promise.all([
    sql`SELECT block FROM cursors WHERE name = 'main'`,
    sql`SELECT meta FROM keeper_status WHERE job = 'indexer'`,
    sql`SELECT id, token, stock_token FROM series`,
  ]);
  const meta = parseJsonObject((statusRows[0] as { meta?: unknown } | undefined)?.meta);
  const now = args.now ?? Date.now;

  const stockNames = new Map<string, string>();
  const stockFeeds = new Map<string, string>();
  for (const entry of deployment.stocks) {
    stockNames.set(entry.stock, entry.name);
    if (entry.feed) stockFeeds.set(entry.stock, entry.feed);
  }
  const seriesByToken = new Map<string, SeriesInfo>();
  for (const row of seriesRows as unknown as { id: string; token: string; stock_token: string }[]) {
    seriesByToken.set(row.token, { id: row.id, token: row.token, stock: row.stock_token });
  }
  const contracts = deployment.contracts;
  const lemniscateAddresses = new Set<Address>([contracts.engine, contracts.pool, contracts.registry, contracts.volOracle, contracts.priceGuard]);
  if (contracts.agentRouter) lemniscateAddresses.add(contracts.agentRouter);
  for (const token of seriesByToken.keys()) lemniscateAddresses.add(token as Address);

  const startedAt = now();
  return {
    settings: args.settings,
    source: args.source,
    reader: args.reader,
    sql,
    logger: args.logger,
    deployment,
    now,
    rpcStats: args.rpcStats ?? (() => ({})),
    seriesByToken,
    stockNames,
    stockFeeds,
    lemniscateAddresses,
    cursor: BigInt((cursorRows[0] as { block: string }).block),
    range: INITIAL_RANGE,
    successfulRanges: 0,
    // A fresh process always starts with a snapshot so the status row reflects the chain right away.
    pendingSnapshot: true,
    lastEventAt: parseDate(meta.lastEventAt, startedAt),
    lastLemniscateEventAt: parseDate(meta.lastLemniscateEventAt, startedAt),
    lastSnapshotAt: parseDate(meta.lastSnapshotAt, 0),
    lastIndexedBlockTime: asNumber(meta.chainTimestamp, 0),
    failureBackoffMs: 5_000,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Status (R8): what the keeper and the API health route read to judge staleness.
// ---------------------------------------------------------------------------------------------------------------

export function buildStatusMeta(state: IndexerState, head: bigint, indexedBlock: bigint = state.cursor): Record<string, unknown> {
  const lag = head > indexedBlock ? head - indexedBlock : 0n;
  return {
    lastHeadBlock: head.toString(),
    lastIndexedBlock: indexedBlock.toString(),
    lagBlocks: lag.toString(),
    pendingSnapshot: state.pendingSnapshot,
    lastSnapshotAt: state.lastSnapshotAt > 0 ? new Date(state.lastSnapshotAt).toISOString() : null,
    lastEventAt: new Date(state.lastEventAt).toISOString(),
    lastLemniscateEventAt: new Date(state.lastLemniscateEventAt).toISOString(),
    chainTimestamp: String(state.lastIndexedBlockTime),
    chainTimeObservedAt: new Date(state.now()).toISOString(),
    deployment: {
      chainId: state.deployment.chainId,
      network: state.deployment.network,
      deployBlock: String(state.deployment.deployBlock),
      contracts: state.deployment.contracts,
      stocks: state.deployment.stocks.map((entry) => entry.name),
    },
    seriesWatched: state.seriesByToken.size,
    rpc: state.rpcStats(),
  };
}

async function writeIndexerStatus(state: IndexerState, head: bigint, errorMessage: string | null): Promise<void> {
  const meta = buildStatusMeta(state, head);
  await state.sql`
    INSERT INTO keeper_status (job, last_run, last_ok, last_error, meta)
    VALUES (
      'indexer', NOW(), CASE WHEN ${errorMessage}::text IS NULL THEN NOW() ELSE NULL END,
      ${errorMessage}, ${JSON.stringify(meta)}::jsonb
    )
    ON CONFLICT (job) DO UPDATE SET
      last_run = NOW(),
      last_ok = CASE WHEN EXCLUDED.last_error IS NULL THEN NOW() ELSE keeper_status.last_ok END,
      last_error = EXCLUDED.last_error,
      meta = keeper_status.meta || EXCLUDED.meta
  `;
}

// ---------------------------------------------------------------------------------------------------------------
// Reorg detection and repair (R5)
// ---------------------------------------------------------------------------------------------------------------

/**
 * Compares the stored hash of the last ingested block with the chain. If it changed, finds the newest block both
 * agree on, deletes everything derived from the orphaned blocks and moves the cursor back, so the normal loop
 * re-ingests the replacement chain. Returns the depth of the reorg (0 = none).
 */
export async function repairReorg(state: IndexerState): Promise<bigint> {
  const stored = (await state.sql`
    SELECT block, hash FROM block_hashes ORDER BY block DESC LIMIT ${Number(HASH_WINDOW)}
  `) as unknown as { block: string; hash: string }[];
  const top = stored[0];
  if (!top) return 0n;
  const topBlock = BigInt(top.block);

  const topHeader = (await state.source.getHeaders([topBlock])).get(topBlock);
  if (topHeader && topHeader.hash === top.hash) return 0n;

  const numbers = stored.map((row) => BigInt(row.block));
  const headers = await state.source.getHeaders(numbers);
  const ancestor = stored.find((row) => {
    const header = headers.get(BigInt(row.block));
    return header !== undefined && header.hash === row.hash;
  });
  if (!ancestor) throw new ReorgTooDeepError(state.cursor, undefined);
  const ancestorBlock = BigInt(ancestor.block);
  const depth = state.cursor - ancestorBlock;
  if (depth > MAX_REORG_DEPTH) throw new ReorgTooDeepError(state.cursor, depth);

  await state.sql.begin(async (tx) => {
    await rollbackAfter(tx, ancestorBlock);
  });
  state.logger.warn(
    { depth: depth.toString(), ancestor: ancestorBlock.toString(), previousCursor: state.cursor.toString() },
    "Chain reorganised: rolled back orphaned blocks and will re-ingest them",
  );
  state.cursor = ancestorBlock;
  state.pendingSnapshot = true;
  state.successfulRanges = 0;
  // Tokens of series listed on the orphaned branch stay watched; they simply stop producing logs.
  return depth;
}

// ---------------------------------------------------------------------------------------------------------------
// Ingest
// ---------------------------------------------------------------------------------------------------------------

function eventOrder(a: ChainEvent, b: ChainEvent): number {
  if (a.blockNumber !== b.blockNumber) return a.blockNumber < b.blockNumber ? -1 : 1;
  return a.logIndex - b.logIndex;
}

function uniqueLogs(logs: readonly RpcLog[]): RpcLog[] {
  const byId = new Map<string, RpcLog>();
  for (const log of logs) {
    const hash = log.transactionHash?.toLowerCase();
    const index = asNumber(log.logIndex, -1);
    if (!hash || index < 0) continue;
    byId.set(`${hash}:${index}`, log);
  }
  return [...byId.values()];
}

function isRangeLimitError(error: unknown): boolean {
  const message = safeErrorSummary(error).message.toLowerCase();
  return /range|too many results|response.{0,12}too large|result.{0,12}limit|query returned more|block limit/.test(message);
}

function eventMaps(state: IndexerState) {
  return { deployment: state.deployment, seriesByToken: state.seriesByToken, stockNames: state.stockNames };
}

function blockOf(log: RpcLog): bigint {
  const value = log.blockNumber;
  return typeof value === "bigint" ? value : BigInt(value ?? 0);
}

/** Fetches the logs of a range, adding the token of every series listed inside it and fetching again until the set of
 * watched tokens is stable (a series can be listed and traded in the same range). */
async function fetchLogs(state: IndexerState, fromBlock: bigint, toBlock: bigint): Promise<RpcLog[]> {
  for (let pass = 0; ; pass += 1) {
    const raw = await state.source.getLogs({
      fromBlock,
      toBlock,
      lemniscateAddresses: [...state.lemniscateAddresses],
      stockAddresses: [...state.stockNames.keys()] as Address[],
      stockTopics: watchedStockTopics,
    });
    const logs = uniqueLogs([...raw.lemniscateLogs, ...raw.stockLogs]);
    if (pass >= DISCOVERY_PASSES) return logs;
    const discovered = listedSeries(
      logs.map((log) => decodeChainLog(log, eventMaps(state), new Date(0))).filter((event): event is ChainEvent => event !== undefined),
    ).filter((series) => !state.lemniscateAddresses.has(series.token as Address));
    if (discovered.length === 0) return logs;
    for (const series of discovered) {
      state.seriesByToken.set(series.token, series);
      state.lemniscateAddresses.add(series.token as Address);
    }
  }
}

async function headersFor(
  state: IndexerState,
  logs: readonly RpcLog[],
  fromBlock: bigint,
  toBlock: bigint,
): Promise<{ headers: Map<bigint, BlockHeader>; tail: BlockHeader[] }> {
  const wanted = new Set<bigint>([fromBlock]);
  for (const log of logs) wanted.add(blockOf(log));
  const tailStart = toBlock - HASH_WINDOW + 1n > fromBlock ? toBlock - HASH_WINDOW + 1n : fromBlock;
  for (let block = tailStart; block <= toBlock; block += 1n) wanted.add(block);
  const fetched = await state.source.getHeaders([...wanted]);
  const headers = new Map<bigint, BlockHeader>();
  for (const block of wanted) {
    const header = fetched.get(block);
    if (!header) throw new Error(`Block header unavailable for ${block}`);
    headers.set(block, header);
  }
  const tail: BlockHeader[] = [];
  for (let block = tailStart; block <= toBlock; block += 1n) tail.push(headers.get(block)!);
  return { headers, tail };
}

async function ingestRange(state: IndexerState, fromBlock: bigint, toBlock: bigint, head: bigint): Promise<number> {
  const logs = await fetchLogs(state, fromBlock, toBlock);
  const { headers, tail } = await headersFor(state, logs, fromBlock, toBlock);

  // The first block of the range must still sit on the branch we stored; otherwise the chain moved under us.
  const previous = (await state.sql`SELECT hash FROM block_hashes WHERE block = ${(fromBlock - 1n).toString()}`) as unknown as { hash: string }[];
  const first = headers.get(fromBlock)!;
  if (previous[0] && previous[0].hash !== first.parentHash) {
    throw new Error(`Chain reorganised while ingesting ${fromBlock}; retrying after repair`);
  }

  const events: ChainEvent[] = [];
  for (const log of logs) {
    const header = headers.get(blockOf(log));
    const event = header ? decodeChainLog(log, eventMaps(state), header.timestamp) : undefined;
    if (event) events.push(event);
  }
  events.sort(eventOrder);

  const toHeader = headers.get(toBlock)!;
  await state.sql.begin(async (tx) => {
    const context: IndexerContext = {
      tx,
      deployment: state.deployment,
      logger: state.logger,
      seriesByToken: state.seriesByToken,
      stockNames: state.stockNames,
      stockFeeds: state.stockFeeds,
      transactionInput: (hash) => state.source.getTransactionInput(hash),
      touchedBalances: new Map(),
      newSeries: [],
      kinds: new Set(),
      snapshotNeeded: false,
      seriesRefreshNeeded: false,
    };
    await handleEvents(context, events);

    for (const header of tail) {
      await tx`
        INSERT INTO block_hashes (block, hash, parent_hash, ts)
        VALUES (${header.number.toString()}, ${header.hash}, ${header.parentHash}, ${header.timestamp.toISOString()})
        ON CONFLICT (block) DO UPDATE SET hash = EXCLUDED.hash, parent_hash = EXCLUDED.parent_hash, ts = EXCLUDED.ts
      `;
    }
    await tx`DELETE FROM block_hashes WHERE block <= ${(toBlock - 2n * HASH_WINDOW).toString()}`;

    const touched = events.length > 0;
    state.pendingSnapshot ||= context.snapshotNeeded || context.seriesRefreshNeeded;
    if (touched) state.lastEventAt = state.now();
    if (events.some((event) => event.source !== "stock")) state.lastLemniscateEventAt = state.now();
    state.lastIndexedBlockTime = Math.floor(toHeader.timestamp.getTime() / 1_000);

    await tx`UPDATE cursors SET block = ${toBlock.toString()}, updated_at = NOW() WHERE name = 'main'`;
    const meta = buildStatusMeta(state, head, toBlock);
    await tx`
      INSERT INTO keeper_status (job, last_run, last_ok, last_error, meta)
      VALUES ('indexer', NOW(), NOW(), NULL, ${JSON.stringify(meta)}::jsonb)
      ON CONFLICT (job) DO UPDATE SET
        last_run = NOW(), last_ok = NOW(), last_error = NULL,
        meta = keeper_status.meta || EXCLUDED.meta
    `;
    if (events.length > 0) {
      await tx.notify(
        LEMNISCATE_EVENTS_CHANNEL,
        JSON.stringify({
          block: toBlock.toString(),
          kinds: context.kinds.size > 0 ? [...context.kinds].sort() : ["chain"],
          logCount: events.length,
        }),
      );
    }
  });
  state.cursor = toBlock;
  return events.length;
}

// ---------------------------------------------------------------------------------------------------------------
// Snapshots (R7)
// ---------------------------------------------------------------------------------------------------------------

function snapshotDue(state: IndexerState): boolean {
  return state.pendingSnapshot || state.now() - state.lastSnapshotAt >= SNAPSHOT_HEARTBEAT_MS;
}

async function takePendingSnapshot(state: IndexerState, block: bigint, head: bigint): Promise<void> {
  const header = (await state.source.getHeaders([block])).get(block);
  if (!header) throw new Error(`Block header unavailable for snapshot block ${block}`);
  await takeSnapshot(
    { sql: state.sql, deployment: state.deployment, reader: state.reader, logger: state.logger },
    block,
    header.timestamp,
  );
  state.pendingSnapshot = false;
  state.lastSnapshotAt = state.now();
  state.lastIndexedBlockTime = Math.floor(header.timestamp.getTime() / 1_000);
  await writeIndexerStatus(state, head, null);
}

async function allQuiet(state: IndexerState): Promise<boolean> {
  const rows = (await state.sql`
    SELECT COUNT(*)::int AS stocks, COUNT(*) FILTER (WHERE session IN ('CLOSED', 'UNKNOWN'))::int AS closed
    FROM (SELECT DISTINCT ON (stock_token) stock_token, session FROM ticks ORDER BY stock_token, ts DESC) latest
  `) as unknown as { stocks: number; closed: number }[];
  const row = rows[0];
  return Boolean(row && row.stocks > 0 && row.stocks === row.closed);
}

export async function nextPollDelay(state: IndexerState): Promise<number> {
  const now = state.now();
  // Poll cadence follows on-chain activity only; public API traffic must not drive indexer (and RPC) load.
  if (now - state.lastLemniscateEventAt < ACTIVE_EVENT_MS) return state.settings.pollActiveMs;
  if (now - state.lastEventAt >= IDLE_AFTER_MS && (await allQuiet(state))) return state.settings.pollIdleMs;
  return state.settings.pollBaseMs;
}

export async function runIndexerTick(state: IndexerState): Promise<TickResult> {
  const head = await state.source.getHead();
  const confirmedHead = confirmedAt(state.settings, head);
  const reorgDepth = await repairReorg(state);
  const fromBlock = state.cursor + 1n;

  if (fromBlock <= confirmedHead) {
    const toBlock = confirmedHead < fromBlock + state.range - 1n ? confirmedHead : fromBlock + state.range - 1n;
    let eventCount: number;
    try {
      eventCount = await ingestRange(state, fromBlock, toBlock, head);
    } catch (error) {
      if (isRangeLimitError(error) && state.range > 1n) {
        state.range = state.range / 2n > 0n ? state.range / 2n : 1n;
        state.successfulRanges = 0;
        state.logger.warn({ fromBlock: fromBlock.toString(), toBlock: toBlock.toString(), nextRange: state.range.toString() }, "Indexer reduced the log range after an RPC size limit");
        return { delayMs: 250, caughtUp: false, events: 0 };
      }
      throw error;
    }
    state.successfulRanges += 1;
    if (state.successfulRanges >= 10 && state.range < MAX_RANGE) {
      state.range = state.range * 2n > MAX_RANGE ? MAX_RANGE : state.range * 2n;
      state.successfulRanges = 0;
    }
    if (snapshotDue(state) && toBlock === confirmedHead) {
      if (state.pendingSnapshot && state.settings.pollActiveMs > 0) await new Promise((resolve) => setTimeout(resolve, Math.min(SNAPSHOT_DEBOUNCE_MS, state.settings.pollActiveMs)));
      try {
        await takePendingSnapshot(state, confirmedHead, head);
      } catch (error) {
        state.logger.warn({ err: safeErrorSummary(error) }, "Indexer snapshot failed and remains queued for retry");
        await writeIndexerStatus(state, head, safeErrorSummary(error).message).catch(() => undefined);
      }
    }
    return {
      delayMs: await nextPollDelay(state),
      caughtUp: state.cursor >= confirmedHead,
      processedTo: state.cursor,
      events: eventCount,
      ...(reorgDepth > 0n ? { reorgDepth } : {}),
    };
  }

  if (snapshotDue(state) && confirmedHead > 0n && state.cursor >= confirmedHead) {
    try {
      await takePendingSnapshot(state, confirmedHead, head);
    } catch (error) {
      state.logger.warn({ err: safeErrorSummary(error) }, "Indexer snapshot retry failed");
      await writeIndexerStatus(state, head, safeErrorSummary(error).message).catch(() => undefined);
    }
  } else {
    await writeIndexerStatus(state, head, null);
  }
  return {
    delayMs: await nextPollDelay(state),
    caughtUp: true,
    processedTo: state.cursor,
    events: 0,
    ...(reorgDepth > 0n ? { reorgDepth } : {}),
  };
}

export async function recordIndexerFailure(state: IndexerState, error: unknown): Promise<number> {
  const safe = safeErrorSummary(error);
  state.logger.error({ err: safe }, "Indexer poll failed; the event cursor was not advanced");
  try {
    const head = await state.source.getHead();
    await writeIndexerStatus(state, head, safe.message);
  } catch {
    // Keep the chain cursor as the durable recovery point when Postgres is down.
  }
  const delay = state.failureBackoffMs;
  state.failureBackoffMs = Math.min(60_000, state.failureBackoffMs * 2);
  return delay;
}

export async function persistMissingDeploymentStatus(sql: Sql, error: unknown): Promise<void> {
  const safe = safeErrorSummary(error);
  const meta = {
    deployment: null,
    deploymentError: safe.message,
    lastHeadBlock: null,
    lastIndexedBlock: null,
    lagBlocks: null,
  };
  await sql`
    INSERT INTO keeper_status (job, last_run, last_error, meta)
    VALUES ('indexer', NOW(), ${safe.message}, ${JSON.stringify(meta)}::jsonb)
    ON CONFLICT (job) DO UPDATE SET
      last_run = NOW(),
      last_error = EXCLUDED.last_error,
      meta = keeper_status.meta || EXCLUDED.meta
  `;
}
