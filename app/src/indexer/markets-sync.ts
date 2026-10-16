import type { TransactionSql } from "postgres";
import { parseAbi, type Address } from "viem";
import { WriterPoolAbi, MarketHoursAbi, LemniscateLensAbi, LemniscateEngineAbi } from "../abi";
import type { ServiceClients } from "../chain/clients";
import type { Deployment } from "../chain/deployment";
import type { MarketInfo } from "./types";
import { asAddress, asBigInt, asNumber, usdg, wad } from "./units";

const feedProxyAbi = parseAbi(["function aggregator() view returns (address)"]);

interface MarketViewLike extends Record<string, unknown> {
  id: unknown;
  symbol: unknown;
}

export interface MarketStateSnapshot extends Record<string, unknown> {
  baseCarryWad: string;
  baseCarryUpdatedAt: string;
  lastAccrual: string;
  normFactor: string;
  lastGoodIndex: string;
  lastGoodPrice: string;
  lastGoodAt: string;
  regime: number;
  buysPaused: boolean;
  vaultShort: string;
  lastUtilBps: number;
  hedgeUnits?: string;
  hedgeTarget?: string;
}

export interface RegistrySnapshot {
  readonly markets: readonly MarketInfo[];
  readonly statesByMarket: ReadonlyMap<number, MarketStateSnapshot>;
  readonly globalConfig: Record<string, unknown>;
  readonly vaultConfig: Record<string, unknown>;
  readonly marketHours: Record<string, unknown>;
}

function objectField(value: unknown, key: string, index: number): unknown {
  if (Array.isArray(value)) return value[index];
  if (value && typeof value === "object") return (value as Record<string, unknown>)[key];
  return undefined;
}

export function toMarketState(value: unknown): MarketStateSnapshot {
  const uintOrInt = (key: string, index: number) => asBigInt(objectField(value, key, index)).toString();
  return {
    normFactor: uintOrInt("normFactor", 0),
    lastAccrual: uintOrInt("lastAccrual", 1),
    regime: asNumber(objectField(value, "regime", 2)),
    buysPaused: Boolean(objectField(value, "buysPaused", 3)),
    baseCarryWad: uintOrInt("baseCarryWad", 4),
    baseCarryUpdatedAt: uintOrInt("baseCarryUpdatedAt", 5),
    lastGoodIndex: uintOrInt("lastGoodIndex", 6),
    lastGoodPrice: uintOrInt("lastGoodPrice", 7),
    lastGoodAt: uintOrInt("lastGoodAt", 8),
    vaultShort: uintOrInt("vaultShort", 9),
    lastUtilBps: asNumber(objectField(value, "lastUtilBps", 10)),
  };
}

function normalizeMarketConfig(value: unknown): Record<string, unknown> {
  const config = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const get = (key: string, index: number) => objectField(config, key, index);
  return {
    feeBps: asNumber(get("feeBps", 4)),
    openSpreadBps: asNumber(get("openSpreadBps", 5)),
    offHoursSpreadBps: asNumber(get("offHoursSpreadBps", 6)),
    pausedSpreadBps: asNumber(get("pausedSpreadBps", 7)),
    openBandBps: asNumber(get("openBandBps", 8)),
    offHoursBandBps: asNumber(get("offHoursBandBps", 9)),
    impactBps: asNumber(get("impactBps", 10)),
    maxMarketExposureBps: asNumber(get("maxMarketExposureBps", 11)),
    maxTradeUsdg: usdg(get("maxTradeUsdg", 12)),
    minTradeUsdg: usdg(get("minTradeUsdg", 13)),
    pausedSellCapPerBlockUsdg: usdg(get("pausedSellCapPerBlockUsdg", 14)),
    offHoursCarryWad: wad(get("offHoursCarryWad", 15)),
    skewCarryWad: wad(get("skewCarryWad", 16)),
    minCarryWad: wad(get("minCarryWad", 17)),
    maxCarryWad: wad(get("maxCarryWad", 18)),
    baseCarryMinWad: wad(get("baseCarryMinWad", 19)),
    baseCarryMaxWad: wad(get("baseCarryMaxWad", 20)),
    maxAgeOpen: asNumber(get("maxAgeOpen", 21)),
    maxAgeOffHours: asNumber(get("maxAgeOffHours", 22)),
    kind: asNumber(get("kind", 23)),
    feed2: typeof get("feed2", 24) === "string" ? String(get("feed2", 24)).toLowerCase() : "0x0000000000000000000000000000000000000000",
    offHoursBuyMaxAge: asNumber(get("offHoursBuyMaxAge", 25)),
  };
}

function normalizeGlobalConfig(values: readonly unknown[]): Record<string, unknown> {
  return {
    maxGlobalExposureBps: asNumber(values[1]),
    protocolFeeShareBps: asNumber(values[2]),
    treasury: asAddress(values[3]),
    sequencerFeed: asAddress(values[4]),
    globalBuysPaused: Boolean(values[5]),
  };
}

function normalizeVaultConfig(values: readonly unknown[]): Record<string, unknown> {
  return {
    lockSeconds: asNumber(values[6]),
    cashBufferBps: asNumber(values[7]),
    hedgeRatioBps: asNumber(values[8]),
    rebalanceThresholdBps: asNumber(values[9]),
    maxHedgeSlippageBps: asNumber(values[10]),
    minHedgeTradeUsdg: usdg(values[11]),
    maxTotalDeposits: usdg(values[12]),
    publicDeposits: Boolean(values[13]),
  };
}

function normalizeSessions(value: unknown): Record<string, unknown> {
  const sessions = Array.isArray(value) ? value : [];
  const first = sessions[0];
  const last = sessions[sessions.length - 1];
  const firstOpen = objectField(first, "open", 0);
  const lastClose = objectField(last, "close", 1);
  return {
    count: sessions.length,
    firstOpen: asBigInt(firstOpen).toString(),
    lastClose: asBigInt(lastClose).toString(),
  };
}

function canonicalSymbol(
  lensSymbol: unknown,
  deploymentSymbol: string | undefined,
  id: number,
): string {
  if (deploymentSymbol) return deploymentSymbol.toUpperCase();
  const tokenSymbol = String(lensSymbol ?? "").trim().toUpperCase();
  // OptionToken.symbol appends "2" to the underlying stock ticker (for example, NVDA2).
  // API market symbols use the underlying ticker; deployment symbols remain authoritative
  // for the initial markets.
  const stockSymbol = tokenSymbol.endsWith("2")
    ? tokenSymbol.slice(0, -1)
    : tokenSymbol;
  return stockSymbol || `MARKET${id}`;
}

function registryCalls(
  deployment: Deployment,
  marketIds: readonly number[],
): readonly unknown[] {
  const engine = deployment.contracts.engine;
  const vault = deployment.contracts.vault;
  const calls: unknown[] = [
    { address: deployment.contracts.lens, abi: LemniscateLensAbi, functionName: "markets", args: [engine] },
    { address: engine, abi: LemniscateEngineAbi, functionName: "maxGlobalExposureBps" },
    { address: engine, abi: LemniscateEngineAbi, functionName: "protocolFeeShareBps" },
    { address: engine, abi: LemniscateEngineAbi, functionName: "treasury" },
    { address: engine, abi: LemniscateEngineAbi, functionName: "sequencerFeed" },
    { address: engine, abi: LemniscateEngineAbi, functionName: "globalBuysPaused" },
    { address: vault, abi: WriterPoolAbi, functionName: "lockSeconds" },
    { address: vault, abi: WriterPoolAbi, functionName: "cashBufferBps" },
    { address: vault, abi: WriterPoolAbi, functionName: "hedgeRatioBps" },
    { address: vault, abi: WriterPoolAbi, functionName: "rebalanceThresholdBps" },
    { address: vault, abi: WriterPoolAbi, functionName: "maxHedgeSlippageBps" },
    { address: vault, abi: WriterPoolAbi, functionName: "minHedgeTradeUsdg" },
    { address: vault, abi: WriterPoolAbi, functionName: "maxTotalDeposits" },
    { address: vault, abi: WriterPoolAbi, functionName: "publicDeposits" },
    { address: deployment.contracts.marketHours, abi: MarketHoursAbi, functionName: "sessions" },
  ];
  for (const id of marketIds) {
    calls.push({ address: engine, abi: LemniscateEngineAbi, functionName: "getConfig", args: [id] });
    calls.push({ address: engine, abi: LemniscateEngineAbi, functionName: "getState", args: [id] });
    calls.push({ address: vault, abi: WriterPoolAbi, functionName: "routeForMarket", args: [id] });
  }
  return calls;
}

export async function readMarketRegistry(
  clients: ServiceClients,
  deployment: Deployment,
  marketIds: readonly number[],
  listedBlocks: ReadonlyMap<number, bigint>,
  existingListedBlocks: ReadonlyMap<number, bigint>,
  blockNumber: bigint,
): Promise<RegistrySnapshot> {
  const sortedIds = [...new Set(marketIds)].sort((a, b) => a - b);
  const values = (await clients.stateClient.multicall({
    contracts: registryCalls(deployment, sortedIds) as never,
    allowFailure: false,
    blockNumber,
  } as never)) as unknown[];
  const lensMarkets = (Array.isArray(values[0]) ? values[0] : []) as MarketViewLike[];
  const globalConfig = normalizeGlobalConfig(values);
  const vaultConfig = normalizeVaultConfig(values);
  const marketHours = normalizeSessions(values[14]);
  const deploymentMarket = new Map(deployment.markets.map((market) => [market.id, market]));
  const lensById = new Map(lensMarkets.map((market) => [asNumber(market.id), market]));
  const syncedMarkets: MarketInfo[] = [];
  const statesByMarket = new Map<number, MarketStateSnapshot>();

  for (let index = 0; index < sortedIds.length; index += 1) {
    const id = sortedIds[index]!;
    const offset = 15 + index * 3;
    const rawConfig = values[offset] as Record<string, unknown> | undefined;
    const rawState = values[offset + 1];
    const rawRoute = values[offset + 2];
    const lensMarket = lensById.get(id);
    const onchainConfig = rawConfig ?? {};
    const deploymentEntry = deploymentMarket.get(id);
    const stock = asAddress(onchainConfig.stock ?? lensMarket?.stock ?? deploymentEntry?.stock);
    const token = asAddress(onchainConfig.token ?? lensMarket?.token ?? deploymentEntry?.token);
    const feed = asAddress(onchainConfig.feed ?? deploymentEntry?.feed);
    const scale = asBigInt(onchainConfig.scale ?? lensMarket?.scale ?? deploymentEntry?.scale);
    const routeFee = asNumber(objectField(rawRoute, "poolFee", 1));
    const symbol = canonicalSymbol(lensMarket?.symbol, deploymentEntry?.symbol, id);
    const listedBlock =
      listedBlocks.get(id) ??
      existingListedBlocks.get(id) ??
      BigInt(deployment.deployBlock);

    syncedMarkets.push({
      id,
      symbol,
      token,
      stock,
      feed,
      scale,
      poolFee: deploymentEntry?.poolFee || routeFee,
      listedBlock,
      config: normalizeMarketConfig(onchainConfig),
    });
    if (rawState !== undefined) {
      const state = toMarketState(rawState);
      const lensMarket = lensById.get(id);
      statesByMarket.set(id, {
        ...state,
        ...(lensMarket
          ? {
              hedgeUnits: asBigInt(objectField(lensMarket, "hedgeUnits", 16)).toString(),
              hedgeTarget: asBigInt(objectField(lensMarket, "hedgeTarget", 17)).toString(),
            }
          : {}),
      });
    }
  }

  const missingIds = lensMarkets
    .map((market) => asNumber(market.id))
    .filter((id) => !new Set(sortedIds).has(id));
  if (missingIds.length > 0) {
    return readMarketRegistry(
      clients,
      deployment,
      [...sortedIds, ...missingIds],
      listedBlocks,
      existingListedBlocks,
      blockNumber,
    );
  }

  return { markets: syncedMarkets, statesByMarket, globalConfig, vaultConfig, marketHours };
}

export async function persistMarketRegistry(
  tx: TransactionSql,
  registry: RegistrySnapshot,
  previousMarketsById: ReadonlyMap<number, MarketInfo>,
): Promise<void> {
  for (const market of registry.markets) {
    const existingListed = previousMarketsById.get(market.id)?.listedBlock;
    const listedBlock = existingListed !== undefined && market.listedBlock > existingListed
      ? existingListed
      : market.listedBlock;
    await tx`
      INSERT INTO markets (id, symbol, token, stock, feed, scale, pool_fee, listed_block, config, updated_at)
      VALUES (
        ${market.id}, ${market.symbol}, ${market.token.toLowerCase()}, ${market.stock.toLowerCase()},
        ${market.feed.toLowerCase()}, ${market.scale.toString()}, ${market.poolFee}, ${listedBlock.toString()},
        ${JSON.stringify(market.config)}::jsonb, NOW()
      )
      ON CONFLICT (id) DO UPDATE SET
        symbol = EXCLUDED.symbol,
        token = EXCLUDED.token,
        stock = EXCLUDED.stock,
        feed = EXCLUDED.feed,
        scale = EXCLUDED.scale,
        pool_fee = EXCLUDED.pool_fee,
        listed_block = LEAST(markets.listed_block, EXCLUDED.listed_block),
        config = EXCLUDED.config,
        updated_at = NOW()
    `;
    await tx`
      UPDATE corp_actions SET symbol = ${market.symbol}
      WHERE details->>'stockAddress' = ${market.stock.toLowerCase()}
    `;
  }
}

export function registryMetadata(
  registry: RegistrySnapshot,
  previousMarketsById: ReadonlyMap<number, MarketInfo>,
): Record<string, unknown> {
  const marketsById: Record<string, unknown> = {};
  for (const market of registry.markets) {
    marketsById[String(market.id)] = {
      id: market.id,
      symbol: market.symbol,
      token: market.token.toLowerCase(),
      stock: market.stock.toLowerCase(),
      feed: market.feed.toLowerCase(),
      scale: market.scale.toString(),
      poolFee: market.poolFee,
      config: market.config,
      ...(registry.statesByMarket.get(market.id) ?? market.state
        ? { state: registry.statesByMarket.get(market.id) ?? market.state }
        : {}),
    };
  }
  for (const [id, market] of previousMarketsById) {
    if (marketsById[String(id)]) continue;
    marketsById[String(id)] = { id, symbol: market.symbol, token: market.token, stock: market.stock, feed: market.feed, scale: market.scale.toString(), poolFee: market.poolFee, config: market.config, ...(market.state ? { state: market.state } : {}) };
  }
  return {
    globalConfig: registry.globalConfig,
    vaultConfig: registry.vaultConfig,
    marketHours: registry.marketHours,
    marketsById,
  };
}

export function marketMap(markets: readonly MarketInfo[]): Map<number, MarketInfo> {
  return new Map(markets.map((market) => [market.id, market]));
}

export function marketAddressMaps(markets: readonly MarketInfo[]): {
  tokenToMarket: Map<string, number>;
  stockToMarket: Map<string, number>;
  feedToMarket: Map<string, number>;
} {
  const tokenToMarket = new Map<string, number>();
  const stockToMarket = new Map<string, number>();
  const feedToMarket = new Map<string, number>();
  for (const market of markets) {
    tokenToMarket.set(market.token.toLowerCase(), market.id);
    stockToMarket.set(market.stock.toLowerCase(), market.id);
    feedToMarket.set(market.feed.toLowerCase(), market.id);
  }
  return { tokenToMarket, stockToMarket, feedToMarket };
}

export async function resolveFeedAggregators(
  clients: ServiceClients,
  feedToMarket: ReadonlyMap<string, number>,
  blockNumber: bigint,
): Promise<Map<string, number>> {
  const feeds = [...feedToMarket.keys()];
  if (feeds.length === 0) return new Map();
  const values = (await clients.stateClient.multicall({
    contracts: feeds.map((feed) => ({
      address: feed as Address,
      abi: feedProxyAbi,
      functionName: "aggregator",
    })) as never,
    allowFailure: false,
    blockNumber,
  } as never)) as unknown[];
  const result = new Map<string, number>();
  for (const [index, value] of values.entries()) {
    const marketId = feedToMarket.get(feeds[index]!);
    if (marketId === undefined) continue;
    result.set(asAddress(value), marketId);
  }
  return result;
}

export function marketIdsFromViews(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value.map((market) => asNumber(objectField(market, "id", 0))).filter((id) => id >= 0);
}
