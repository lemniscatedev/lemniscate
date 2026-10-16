import type { Logger } from "pino";
import type { Sql } from "postgres";
import type { Address } from "viem";
import type { ServiceClients } from "../chain/clients";
import type { Deployment } from "../chain/deployment";
import type { RuntimeConfig } from "../config";
import { confirmationBlocks } from "../config";
import { LEMNISCATE_EVENTS_CHANNEL } from "../db/notify";
import { safeErrorSummary } from "../log";
import { decodeChainLog, watchedExternalTopics } from "./events";
import { handleEngineEvent } from "./handlers/engine";
import { handleHoursEvent } from "./handlers/hours";
import { handleOracleEvent } from "./handlers/oracle";
import { applyBalanceDeltas, handleTokenEvent, type TokenTransferDelta } from "./handlers/token";
import { handleVaultEvent } from "./handlers/vault";
import {
  marketAddressMaps,
  marketMap,
  persistMarketRegistry,
  readMarketRegistry,
  registryMetadata,
  resolveFeedAggregators,
  type RegistrySnapshot,
} from "./markets-sync";
import { fetchLogPair, timestampsForLogs, type BlockTimestampCache } from "./rpc";
import { takeSnapshot } from "./snapshot";
import type { ChainEvent, IndexerContext, MarketInfo, RpcLog } from "./types";
import { asAddress, asBigInt, asNumber } from "./units";

const INITIAL_RANGE = 50_000n;
const MAX_RANGE = 200_000n;
const SNAPSHOT_HEARTBEAT_MS = 10 * 60_000;
const SNAPSHOT_DEBOUNCE_MS = 2_000;
// Queued account reads left over from a capped snapshot drain at this pace.
const ACCOUNT_BACKLOG_SNAPSHOT_MS = 60_000;

function snapshotDue(state: IndexerState): boolean {
  const sinceLast = Date.now() - state.lastSnapshotAt;
  return state.pendingSnapshot || sinceLast >= SNAPSHOT_HEARTBEAT_MS
    || (state.pendingAccountSnapshots.size > 0 && sinceLast >= ACCOUNT_BACKLOG_SNAPSHOT_MS);
}
const ACTIVE_EVENT_MS = 2 * 60_000;
const IDLE_AFTER_MS = 30 * 60_000;

export interface IndexerState {
  readonly config: RuntimeConfig;
  readonly clients: ServiceClients;
  readonly sql: Sql;
  readonly logger: Logger;
  readonly deployment: Deployment;
  readonly blockTimestampCache: BlockTimestampCache;
  readonly lemniscateAddresses: Set<Address>;
  readonly externalAddresses: Set<Address>;
  readonly tokenToMarket: Map<string, number>;
  readonly stockToMarket: Map<string, number>;
  readonly feedToMarket: Map<string, number>;
  readonly aggregatorToMarket: Map<string, number>;
  readonly feedProxies: Set<string>;
  readonly marketsById: Map<number, MarketInfo>;
  readonly marketStatesById: Map<number, Record<string, unknown>>;
  readonly globalConfig: Record<string, unknown>;
  readonly vaultConfig: Record<string, unknown>;
  readonly marketHours: Record<string, unknown>;
  readonly listedBlocks: Map<number, bigint>;
  readonly existingListedBlocks: Map<number, bigint>;
  readonly pendingAccountSnapshots: Set<string>;
  cursor: bigint;
  range: bigint;
  successfulRanges: number;
  registryDirty: boolean;
  pendingSnapshot: boolean;
  initialized: boolean;
  lastEventAt: number;
  lastLemniscateEventAt: number;
  lastSnapshotAt: number;
  lastAggregatorResolveAt: number;
  failureBackoffMs: number;
}

export interface TickResult {
  readonly delayMs?: number;
  readonly caughtUp: boolean;
  readonly processedTo?: bigint;
  readonly events: number;
}

interface StoredMarketRow {
  id: number;
  symbol: string;
  token: string;
  stock: string;
  feed: string;
  scale: string;
  pool_fee: number;
  listed_block: string;
  config: Record<string, unknown> | string;
}

interface StoredStatusRow {
  meta: Record<string, unknown> | string | null;
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function parseDate(value: unknown, fallback: number): number {
  if (typeof value !== "string") return fallback;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function objectAt(record: Record<string, unknown>, key: string): Record<string, unknown> {
  return parseJsonObject(record[key]);
}

async function storedMarkets(sql: Sql): Promise<StoredMarketRow[]> {
  return (await sql`
    SELECT id, symbol, token, stock, feed, scale, pool_fee, listed_block, config
    FROM markets
    ORDER BY id
  `) as StoredMarketRow[];
}

async function storedStatus(sql: Sql): Promise<Record<string, unknown>> {
  const rows = (await sql`SELECT meta FROM keeper_status WHERE job = 'indexer' LIMIT 1`) as StoredStatusRow[];
  return parseJsonObject(rows[0]?.meta);
}

function toMarketInfo(row: StoredMarketRow, state?: Record<string, unknown>): MarketInfo {
  return {
    id: Number(row.id),
    symbol: row.symbol,
    token: asAddress(row.token),
    stock: asAddress(row.stock),
    feed: asAddress(row.feed),
    scale: BigInt(row.scale),
    poolFee: Number(row.pool_fee),
    listedBlock: BigInt(row.listed_block),
    config: parseJsonObject(row.config),
    ...(state ? { state } : {}),
  };
}

function deploymentMarketInfos(deployment: Deployment): MarketInfo[] {
  return deployment.markets.map((market) => ({
    id: market.id,
    symbol: market.symbol.toUpperCase(),
    token: market.token,
    stock: market.stock,
    feed: market.feed,
    scale: BigInt(market.scale),
    poolFee: market.poolFee,
    listedBlock: BigInt(deployment.deployBlock),
    config: {},
  }));
}

function marketMetadataFromStored(meta: Record<string, unknown>): Map<number, Record<string, unknown>> {
  const result = new Map<number, Record<string, unknown>>();
  const values = objectAt(meta, "marketsById");
  for (const [key, value] of Object.entries(values)) {
    const id = Number(key);
    if (!Number.isInteger(id) || id < 0) continue;
    const market = parseJsonObject(value);
    const state = parseJsonObject(market.state);
    if (Object.keys(state).length > 0) result.set(id, state);
  }
  return result;
}

function deploymentSummary(deployment: Deployment): Record<string, unknown> {
  return {
    chainId: deployment.chainId,
    network: deployment.network,
    deployBlock: String(deployment.deployBlock),
    contracts: deployment.contracts,
  };
}

async function storedCursorOrCreate(sql: Sql, deployBlock: number): Promise<bigint> {
  const rows = (await sql`SELECT block FROM cursors WHERE name = 'main' LIMIT 1`) as { block: string }[];
  if (rows[0]) return BigInt(rows[0].block);
  const initialBlock = BigInt(deployBlock) - 1n;
  await sql`
    INSERT INTO cursors (name, block, updated_at)
    VALUES ('main', ${initialBlock.toString()}, NOW())
    ON CONFLICT (name) DO NOTHING
  `;
  const inserted = (await sql`SELECT block FROM cursors WHERE name = 'main' LIMIT 1`) as { block: string }[];
  return BigInt(inserted[0]?.block ?? initialBlock.toString());
}

function statusMeta(state: IndexerState, head: bigint, indexedBlock = state.cursor): Record<string, unknown> {
  const lag = head > indexedBlock ? head - indexedBlock : 0n;
  return {
    lastHeadBlock: head.toString(),
    lastIndexedBlock: indexedBlock.toString(),
    lagBlocks: lag.toString(),
    pendingSnapshot: state.pendingSnapshot,
    registrySyncPending: state.registryDirty,
    pendingAccountSnapshots: [...state.pendingAccountSnapshots].sort(),
    lastEventAt: new Date(state.lastEventAt).toISOString(),
    lastLemniscateEventAt: new Date(state.lastLemniscateEventAt).toISOString(),
    deployment: deploymentSummary(state.deployment),
    globalConfig: state.globalConfig,
    vaultConfig: state.vaultConfig,
    marketHours: state.marketHours,
    marketsById: Object.fromEntries(
      [...state.marketsById.entries()].map(([id, market]) => [
        String(id),
        {
          id,
          symbol: market.symbol,
          token: market.token.toLowerCase(),
          stock: market.stock.toLowerCase(),
          feed: market.feed.toLowerCase(),
          scale: market.scale.toString(),
          poolFee: market.poolFee,
          config: market.config,
          ...(state.marketStatesById.get(id) ? { state: state.marketStatesById.get(id) } : {}),
        },
      ]),
    ),
    rpc: state.clients.pool.stats(),
  };
}

async function writeIndexerStatus(
  state: IndexerState,
  head: bigint,
  errorMessage: string | null,
): Promise<void> {
  const meta = statusMeta(state, head);
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

async function syncStateMaps(state: IndexerState, registry: RegistrySnapshot): Promise<void> {
  const previousMarkets = new Map(state.marketsById);
  const nextMarkets = marketMap(registry.markets);
  for (const [id, market] of nextMarkets) {
    const stateSnapshot = registry.statesByMarket.get(id);
    nextMarkets.set(id, stateSnapshot ? { ...market, state: stateSnapshot } : market);
  }
  state.marketsById.clear();
  for (const [id, market] of nextMarkets) state.marketsById.set(id, market);
  state.marketStatesById.clear();
  for (const [id, marketState] of registry.statesByMarket) {
    const view = marketState;
    state.marketStatesById.set(id, { ...view });
  }
  Object.assign(state.globalConfig, registry.globalConfig);
  Object.assign(state.vaultConfig, registry.vaultConfig);
  Object.assign(state.marketHours, registry.marketHours);

  state.tokenToMarket.clear();
  state.stockToMarket.clear();
  state.feedToMarket.clear();
  const addressMaps = marketAddressMaps([...state.marketsById.values()]);
  for (const [address, id] of addressMaps.tokenToMarket) state.tokenToMarket.set(address, id);
  for (const [address, id] of addressMaps.stockToMarket) state.stockToMarket.set(address, id);
  for (const [address, id] of addressMaps.feedToMarket) state.feedToMarket.set(address, id);

  state.lemniscateAddresses.clear();
  state.lemniscateAddresses.add(state.deployment.contracts.engine);
  state.lemniscateAddresses.add(state.deployment.contracts.vault);
  state.lemniscateAddresses.add(state.deployment.contracts.marketHours);
  state.externalAddresses.clear();
  for (const market of state.marketsById.values()) {
    state.lemniscateAddresses.add(market.token);
    state.externalAddresses.add(market.stock);
  }
  state.feedProxies.clear();
  for (const feed of state.feedToMarket.keys()) state.feedProxies.add(feed);
  state.aggregatorToMarket.clear();
  const head = await state.clients.logsClient.getBlockNumber();
  const block = confirmedAt(state.config, head);
  if (block > 0n) {
    const aggregators = await resolveFeedAggregators(state.clients, state.feedToMarket, block);
    for (const [address, id] of aggregators) {
      state.aggregatorToMarket.set(address, id);
      state.externalAddresses.add(address as Address);
    }
  }
  state.lastAggregatorResolveAt = Date.now();

  // Existing market listing blocks must survive a routine config refresh.
  for (const [id, market] of previousMarkets) {
    const next = state.marketsById.get(id);
    if (next && market.listedBlock < next.listedBlock) {
      state.marketsById.set(id, { ...next, listedBlock: market.listedBlock });
    }
  }
}

function confirmedAt(config: RuntimeConfig, head: bigint): bigint {
  const confirmations = BigInt(confirmationBlocks(config));
  return head > confirmations ? head - confirmations : 0n;
}

export async function createIndexerState(args: {
  config: RuntimeConfig;
  clients: ServiceClients;
  sql: Sql;
  logger: Logger;
  deployment: Deployment;
}): Promise<IndexerState> {
  const { config, clients, sql, logger, deployment } = args;
  const [meta, dbMarkets, cursor] = await Promise.all([
    storedStatus(sql),
    storedMarkets(sql),
    storedCursorOrCreate(sql, deployment.deployBlock),
  ]);
  const statesFromMeta = marketMetadataFromStored(meta);
  const marketsById = new Map<number, MarketInfo>();
  const existingListedBlocks = new Map<number, bigint>();
  for (const row of dbMarkets) {
    const market = toMarketInfo(row, statesFromMeta.get(Number(row.id)));
    marketsById.set(market.id, market);
    existingListedBlocks.set(market.id, market.listedBlock);
  }
  for (const market of deploymentMarketInfos(deployment)) {
    if (!marketsById.has(market.id)) marketsById.set(market.id, market);
  }
  const addressMaps = marketAddressMaps([...marketsById.values()]);
  const now = Date.now();
  const pendingAccountsValue = meta.pendingAccountSnapshots;
  const pendingAccountSnapshots = new Set(
    Array.isArray(pendingAccountsValue)
      ? pendingAccountsValue.filter((item): item is string => typeof item === "string").map((item) => item.toLowerCase())
      : [],
  );
  const globalConfig = objectAt(meta, "globalConfig");
  const vaultConfig = objectAt(meta, "vaultConfig");
  const marketHours = objectAt(meta, "marketHours");
  const state: IndexerState = {
    config,
    clients,
    sql,
    logger,
    deployment,
    blockTimestampCache: new Map(),
    lemniscateAddresses: new Set([
      deployment.contracts.engine,
      deployment.contracts.vault,
      deployment.contracts.marketHours,
      ...[...marketsById.values()].map((market) => market.token),
    ]),
    externalAddresses: new Set([
      ...[...marketsById.values()].map((market) => market.stock),
    ]),
    tokenToMarket: new Map(addressMaps.tokenToMarket),
    stockToMarket: new Map(addressMaps.stockToMarket),
    feedToMarket: new Map(addressMaps.feedToMarket),
    aggregatorToMarket: new Map(),
    feedProxies: new Set(addressMaps.feedToMarket.keys()),
    marketsById,
    marketStatesById: statesFromMeta,
    globalConfig,
    vaultConfig,
    marketHours,
    listedBlocks: new Map(),
    existingListedBlocks,
    pendingAccountSnapshots,
    cursor,
    range: INITIAL_RANGE,
    successfulRanges: 0,
    registryDirty: Boolean(meta.registrySyncPending),
    pendingSnapshot: Boolean(meta.pendingSnapshot),
    initialized: false,
    lastEventAt: parseDate(meta.lastEventAt, now),
    lastLemniscateEventAt: parseDate(meta.lastLemniscateEventAt, now),
    lastSnapshotAt: parseDate(meta.lastSnapshotAt, 0),
    lastAggregatorResolveAt: 0,
    failureBackoffMs: 5_000,
  };
  return state;
}

function syncKnownMarketIds(state: IndexerState, events: readonly ChainEvent[]): void {
  for (const event of events) {
    if (event.source === "engine" && event.eventName === "MarketListed") {
      const id = asNumber(event.args.id, -1);
      const token = typeof event.args.token === "string" ? asAddress(event.args.token) : undefined;
      const stock = typeof event.args.stock === "string" ? asAddress(event.args.stock) : undefined;
      const feed = typeof event.args.feed === "string" ? asAddress(event.args.feed) : undefined;
      if (id < 0 || !token || !stock || !feed) continue;
      const market = state.marketsById.get(id);
      if (!market) {
        state.marketsById.set(id, {
          id,
          symbol: `MARKET${id}`,
          token,
          stock,
          feed,
          scale: asBigInt(event.args.scale),
          poolFee: 0,
          listedBlock: event.blockNumber,
          config: {},
        });
      }
      state.tokenToMarket.set(token.toLowerCase(), id);
      state.stockToMarket.set(stock.toLowerCase(), id);
      state.feedToMarket.set(feed.toLowerCase(), id);
      state.listedBlocks.set(id, event.blockNumber);
    }
  }
}

function addNewWatchedAddresses(state: IndexerState, events: readonly ChainEvent[]): boolean {
  let changed = false;
  for (const event of events) {
    if (event.source !== "engine" || event.eventName !== "MarketListed") continue;
    const id = asNumber(event.args.id, -1);
    const token = typeof event.args.token === "string" ? asAddress(event.args.token) : undefined;
    const stock = typeof event.args.stock === "string" ? asAddress(event.args.stock) : undefined;
    const feed = typeof event.args.feed === "string" ? asAddress(event.args.feed) : undefined;
    if (id < 0 || !token || !stock || !feed) continue;
    if (!state.lemniscateAddresses.has(token)) {
      state.lemniscateAddresses.add(token);
      changed = true;
    }
    if (!state.externalAddresses.has(stock)) {
      state.externalAddresses.add(stock);
      changed = true;
    }
    if (!state.feedProxies.has(feed.toLowerCase())) {
      state.feedProxies.add(feed.toLowerCase());
      state.feedToMarket.set(feed.toLowerCase(), id);
      changed = true;
    }
    state.tokenToMarket.set(token.toLowerCase(), id);
    state.stockToMarket.set(stock.toLowerCase(), id);
  }
  return changed;
}

async function reResolveAggregators(state: IndexerState, block: bigint): Promise<boolean> {
  const next = await resolveFeedAggregators(state.clients, state.feedToMarket, block);
  const changed =
    next.size !== state.aggregatorToMarket.size ||
    [...next.entries()].some(([address, id]) => state.aggregatorToMarket.get(address) !== id);
  state.aggregatorToMarket.clear();
  state.externalAddresses.clear();
  for (const address of state.stockToMarket.keys()) state.externalAddresses.add(address as Address);
  for (const [address, id] of next) {
    state.aggregatorToMarket.set(address, id);
    state.externalAddresses.add(address as Address);
  }
  state.lastAggregatorResolveAt = Date.now();
  return changed;
}

async function initializeAtFreshHead(state: IndexerState, head: bigint): Promise<boolean> {
  const confirmedHead = confirmedAt(state.config, head);
  if (confirmedHead < BigInt(state.deployment.deployBlock)) return false;
  const ids = [...state.marketsById.keys()].sort((a, b) => a - b);
  const registry = await readMarketRegistry(
    state.clients,
    state.deployment,
    ids,
    state.listedBlocks,
    state.existingListedBlocks,
    confirmedHead,
  );
  const previousMarkets = new Map(state.marketsById);
  await syncStateMaps(state, registry);
  await state.sql.begin(async (tx) => {
    await persistMarketRegistry(tx, registry, previousMarkets);
    await tx`
      INSERT INTO cursors (name, block, updated_at)
      VALUES ('main', ${state.cursor.toString()}, NOW())
      ON CONFLICT (name) DO NOTHING
    `;
    const metadata = registryMetadata(registry, previousMarkets);
    const meta = {
      ...metadata,
      ...statusMeta(state, head),
      registrySyncPending: false,
      pendingSnapshot: true,
      pendingAccountSnapshots: [...state.pendingAccountSnapshots],
    };
    await tx`
      INSERT INTO keeper_status (job, last_run, last_ok, last_error, meta)
      VALUES ('indexer', NOW(), NOW(), NULL, ${JSON.stringify(meta)}::jsonb)
      ON CONFLICT (job) DO UPDATE SET
        last_run = NOW(), last_ok = NOW(), last_error = NULL,
        meta = keeper_status.meta || EXCLUDED.meta
    `;
  });
  state.registryDirty = false;
  state.pendingSnapshot = true;
  const stateSnapshot = await takeSnapshot(state, confirmedHead, state.pendingAccountSnapshots);
  state.pendingSnapshot = false;
  for (const account of stateSnapshot.processedAccounts) state.pendingAccountSnapshots.delete(account);
  state.lastSnapshotAt = stateSnapshot.snapshotAt.getTime();
  state.initialized = true;
  state.failureBackoffMs = 5_000;
  state.logger.info({ block: confirmedHead.toString(), markets: state.marketsById.size }, "Indexer initialized from confirmed chain state");
  return true;
}

function eventAddressMaps(state: IndexerState) {
  return {
    deployment: state.deployment,
    marketById: state.marketsById,
    tokenToMarket: state.tokenToMarket,
    stockToMarket: state.stockToMarket,
    aggregatorToMarket: state.aggregatorToMarket,
  };
}

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

function makeContext(state: IndexerState, tx: IndexerContext["tx"]): IndexerContext {
  return {
    tx,
    deployment: state.deployment,
    logger: state.logger,
    tokenToMarket: state.tokenToMarket,
    marketById: state.marketsById,
    stockToMarket: state.stockToMarket,
    touchedAccounts: new Set(),
    insertedTradeTxs: new Set(),
    insertedVaultActionTxs: new Set(),
    marketIds: new Set(),
    kinds: new Set(),
    metaPatch: {},
    globalConfig: state.globalConfig,
    vaultConfig: state.vaultConfig,
    marketHours: state.marketHours,
    marketStatesById: state.marketStatesById,
    snapshotNeeded: false,
    registryNeeded: false,
    hasLemniscateEvents: false,
  };
}

async function ingestDecodedRange(
  state: IndexerState,
  events: readonly ChainEvent[],
  toBlock: bigint,
  head: bigint,
  registry: RegistrySnapshot | undefined,
): Promise<void> {
  const previousMarkets = new Map(state.marketsById);
  const contextHolder: { context?: IndexerContext; balanceTransfers: TokenTransferDelta[] } = {
    balanceTransfers: [],
  };
  await state.sql.begin(async (tx) => {
    if (registry) {
      await persistMarketRegistry(tx, registry, previousMarkets);
      const registryPatch = registryMetadata(registry, previousMarkets);
      Object.assign(state.globalConfig, registry.globalConfig);
      Object.assign(state.vaultConfig, registry.vaultConfig);
      Object.assign(state.marketHours, registry.marketHours);
      for (const [id, market] of state.marketsById) {
        const refreshed = registry.markets.find((item) => item.id === id);
        if (refreshed) state.marketsById.set(id, refreshed);
      }
      for (const [id, marketState] of registry.statesByMarket) {
        state.marketStatesById.set(id, { ...marketState });
      }
      contextHolder.context = makeContext(state, tx);
      contextHolder.context.metaPatch.registry = registryPatch;
    } else {
      contextHolder.context = makeContext(state, tx);
    }
    const context = contextHolder.context;
    if (!context) throw new Error("Indexer transaction context was not initialized");

    for (const event of events) {
      if (event.eventName === "Transfer" && (event.source === "token" || event.source === "vault")) continue;
      await handleEngineEvent(context, event);
      await handleVaultEvent(context, event);
      await handleHoursEvent(context, event);
      await handleOracleEvent(context, event);
    }
    for (const event of events) {
      if (event.eventName !== "Transfer" || (event.source !== "token" && event.source !== "vault")) continue;
      const transfer = await handleTokenEvent(context, event);
      if (transfer) contextHolder.balanceTransfers.push(transfer);
    }
    await applyBalanceDeltas(context, contextHolder.balanceTransfers);

    state.pendingSnapshot ||= context.snapshotNeeded;
    state.registryDirty ||= context.registryNeeded;
    for (const account of context.touchedAccounts) state.pendingAccountSnapshots.add(account);
    if (events.length > 0) state.lastEventAt = Date.now();
    if (context.hasLemniscateEvents) state.lastLemniscateEventAt = Date.now();
    if (registry) state.registryDirty = false;

    await tx`
      UPDATE cursors SET block = ${toBlock.toString()}, updated_at = NOW()
      WHERE name = 'main'
    `;
    const meta = {
      ...(registry ? registryMetadata(registry, previousMarkets) : {}),
      ...statusMeta(state, head, toBlock),
    };
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
          markets: [...context.marketIds].sort((a, b) => a - b),
          kinds: context.kinds.size > 0 ? [...context.kinds].sort() : ["chain"],
          logCount: events.length,
        }),
      );
    }
  });

  state.cursor = toBlock;
}

async function takePendingSnapshot(state: IndexerState, block: bigint): Promise<void> {
  const snapshot = await takeSnapshot(state, block, state.pendingAccountSnapshots);
  state.pendingSnapshot = false;
  // Accounts beyond the per-snapshot cap, or whose reads failed, carry over.
  for (const account of snapshot.processedAccounts) state.pendingAccountSnapshots.delete(account);
  state.lastSnapshotAt = snapshot.snapshotAt.getTime();
  await writeIndexerStatus(state, block, null);
}

async function maybeResolveAggregators(state: IndexerState, head: bigint, force: boolean): Promise<void> {
  if (!force && Date.now() - state.lastAggregatorResolveAt < 6 * 60 * 60_000) return;
  const block = confirmedAt(state.config, head);
  if (block <= 0n) return;
  const changed = await reResolveAggregators(state, block);
  if (changed) {
    state.logger.info({ feeds: state.feedProxies.size, aggregators: state.aggregatorToMarket.size }, "Indexer refreshed feed aggregators");
  }
}

async function allMarketsOffHours(sql: Sql): Promise<boolean> {
  const rows = (await sql`
    SELECT
      (SELECT COUNT(*) FROM markets) AS market_count,
      (SELECT COUNT(*) FROM (
        SELECT DISTINCT ON (market_id) market_id, regime
        FROM ticks
        ORDER BY market_id, ts DESC
      ) latest WHERE latest.regime = 1) AS off_hours_count
  `) as { market_count: string; off_hours_count: string }[];
  const count = Number(rows[0]?.market_count ?? 0);
  return count > 0 && Number(rows[0]?.off_hours_count ?? -1) === count;
}

export async function nextPollDelay(state: IndexerState): Promise<number> {
  const now = Date.now();
  // Poll cadence follows on-chain activity only; public API traffic must not
  // be able to drive indexer (and RPC) load.
  if (now - state.lastLemniscateEventAt < ACTIVE_EVENT_MS) {
    return state.config.INDEXER_POLL_ACTIVE_MS;
  }
  if (now - state.lastEventAt >= IDLE_AFTER_MS && await allMarketsOffHours(state.sql)) {
    return state.config.INDEXER_POLL_IDLE_MS;
  }
  return state.config.INDEXER_POLL_BASE_MS;
}

export async function runIndexerTick(state: IndexerState): Promise<TickResult> {
  const head = await state.clients.logsClient.getBlockNumber();
  const confirmedHead = confirmedAt(state.config, head);
  if (!state.initialized) {
    if (!(await initializeAtFreshHead(state, head))) {
      await writeIndexerStatus(state, head, null);
      return { delayMs: state.config.INDEXER_POLL_BASE_MS, caughtUp: false, events: 0 };
    }
    return { delayMs: await nextPollDelay(state), caughtUp: true, processedTo: state.cursor, events: 0 };
  }

  await maybeResolveAggregators(state, head, false);
  const fromBlock = state.cursor + 1n;
  if (fromBlock <= confirmedHead) {
    const toBlock = confirmedHead < fromBlock + state.range - 1n ? confirmedHead : fromBlock + state.range - 1n;
    let raw: Awaited<ReturnType<typeof fetchLogPair>>;
    try {
      raw = await fetchLogPair(state.clients.pool, {
        fromBlock,
        toBlock,
        lemniscateAddresses: [...state.lemniscateAddresses],
        externalAddresses: [...state.externalAddresses],
        externalTopics: watchedExternalTopics,
      });
    } catch (error) {
      if (isRangeLimitError(error) && state.range > 1n) {
        state.range = state.range / 2n > 0n ? state.range / 2n : 1n;
        state.successfulRanges = 0;
        state.logger.warn({ fromBlock: fromBlock.toString(), toBlock: toBlock.toString(), nextRange: state.range.toString() }, "Indexer reduced the log range after an RPC size limit");
        return { delayMs: 250, caughtUp: false, events: 0 };
      }
      throw error;
    }
    const allLogs = uniqueLogs([...raw.lemniscateLogs, ...raw.externalLogs]);
    const discoveryEvents = allLogs
      .map((log) => decodeChainLog(log, eventAddressMaps(state), new Date(0)))
      .filter((event): event is ChainEvent => event !== undefined);
    syncKnownMarketIds(state, discoveryEvents);
    if (addNewWatchedAddresses(state, discoveryEvents)) {
      const discoveryHead = confirmedHead > 0n ? confirmedHead : head;
      await reResolveAggregators(state, discoveryHead);
      return { delayMs: 100, caughtUp: false, processedTo: state.cursor, events: 0 };
    }

    const timestamps = await timestampsForLogs(state.clients.pool, allLogs, state.blockTimestampCache);
    const events = allLogs
      .map((log) => {
        const ts = timestamps.get(log);
        return ts ? decodeChainLog(log, eventAddressMaps(state), ts) : undefined;
      })
      .filter((event): event is ChainEvent => event !== undefined)
      .sort(eventOrder);
    const registryEvent = events.some(
      (event) =>
        (event.source === "engine" && ["MarketListed", "MarketConfigUpdated"].includes(event.eventName)) ||
        (event.source === "vault" && event.eventName === "HedgeRouteUpdated"),
    );
    state.registryDirty ||= registryEvent;
    const shouldSyncRegistry = state.registryDirty && toBlock === confirmedHead;
    let registry: RegistrySnapshot | undefined;
    if (shouldSyncRegistry) {
      const ids = [...new Set([...state.marketsById.keys(), ...events.map((event) => event.marketId).filter((id): id is number => id !== undefined)])];
      registry = await readMarketRegistry(
        state.clients,
        state.deployment,
        ids,
        state.listedBlocks,
        state.existingListedBlocks,
        toBlock,
      );
      await syncStateMaps(state, registry);
    }

    await ingestDecodedRange(state, events, toBlock, head, registry);

    if (registry) state.registryDirty = false;
    state.successfulRanges += 1;
    if (state.successfulRanges >= 10 && state.range < MAX_RANGE) {
      state.range = state.range * 2n > MAX_RANGE ? MAX_RANGE : state.range * 2n;
      state.successfulRanges = 0;
    }
    if (snapshotDue(state) && toBlock === confirmedHead) {
      if (state.pendingSnapshot) await new Promise((resolve) => setTimeout(resolve, SNAPSHOT_DEBOUNCE_MS));
      try {
        await takePendingSnapshot(state, confirmedHead);
      } catch (error) {
        state.logger.warn({ err: safeErrorSummary(error) }, "Indexer snapshot failed and remains queued for retry");
        await writeIndexerStatus(state, head, safeErrorSummary(error).message).catch(() => undefined);
      }
    }
    return {
      delayMs: await nextPollDelay(state),
      caughtUp: state.cursor >= confirmedHead,
      processedTo: state.cursor,
      events: events.length,
    };
  }

  if (snapshotDue(state) && confirmedHead > 0n) {
    try {
      await takePendingSnapshot(state, confirmedHead);
    } catch (error) {
      state.logger.warn({ err: safeErrorSummary(error) }, "Indexer snapshot retry failed");
      await writeIndexerStatus(state, head, safeErrorSummary(error).message).catch(() => undefined);
    }
  } else {
    await writeIndexerStatus(state, head, null);
  }

  return { delayMs: await nextPollDelay(state), caughtUp: true, processedTo: state.cursor, events: 0 };
}

export async function recordIndexerFailure(state: IndexerState, error: unknown): Promise<number> {
  const safe = safeErrorSummary(error);
  state.logger.error({ err: safe }, "Indexer poll failed; the event cursor was not advanced");
  try {
    const head = await state.clients.logsClient.getBlockNumber();
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
