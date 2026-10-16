import type { TransactionSql } from "postgres";
import type { Sql } from "postgres";
import type { Address } from "viem";
import { WriterPoolAbi, LemniscateLensAbi, LemniscateEngineAbi } from "../abi";
import { LEMNISCATE_EVENTS_CHANNEL } from "../db/notify";
import type { ServiceClients } from "../chain/clients";
import type { Deployment } from "../chain/deployment";
import type { Logger } from "pino";
import type { MarketInfo } from "./types";
import { toMarketState, type MarketStateSnapshot } from "./markets-sync";
import { asAddress, asBigInt, asNumber, writerPool, parseChainTimestamp, parseUsdg, power, usdg, wad } from "./units";
import { timestampAtBlock } from "./rpc";
import { safeErrorSummary } from "../log";

export interface SnapshotRuntime {
  readonly clients: ServiceClients;
  readonly sql: Sql;
  readonly deployment: Deployment;
  readonly marketsById: Map<number, MarketInfo>;
  readonly marketStatesById: Map<number, Record<string, unknown>>;
  readonly globalConfig: Record<string, unknown>;
  readonly vaultConfig: Record<string, unknown>;
  readonly marketHours: Record<string, unknown>;
  readonly logger: Logger;
}

export interface SnapshotResult {
  readonly block: bigint;
  readonly chainTimestamp: string;
  readonly observedAt: string;
  readonly snapshotAt: Date;
  /** Queued accounts whose vault state was read and stored by this snapshot. */
  readonly processedAccounts: ReadonlySet<string>;
}

interface TickInsertRow {
  marketId: number;
  ts: string;
  block: string;
  spot: string;
  index: string;
  normFactor: string;
  price: string;
  bid: string;
  ask: string;
  carryWad: string;
  regime: number;
  buysPaused: boolean;
  vaultShort: string;
  liability: string;
  hedgeUnits: string;
  hedgeTarget: string;
  oracleUpdatedAt: string;
}

function objectField(value: unknown, key: string, index: number): unknown {
  if (Array.isArray(value)) return value[index];
  if (value && typeof value === "object") return (value as Record<string, unknown>)[key];
  return undefined;
}

function storedMarketMetadata(
  markets: ReadonlyMap<number, MarketInfo>,
  states: ReadonlyMap<number, Record<string, unknown>>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [id, market] of markets) {
    result[String(id)] = {
      id,
      symbol: market.symbol,
      token: market.token.toLowerCase(),
      stock: market.stock.toLowerCase(),
      feed: market.feed.toLowerCase(),
      scale: market.scale.toString(),
      poolFee: market.poolFee,
      config: market.config,
      ...(states.get(id) ? { state: states.get(id) } : {}),
    };
  }
  return result;
}

async function storeSnapshotStatus(
  tx: TransactionSql,
  runtime: SnapshotRuntime,
  block: bigint,
  chainTimestamp: string,
  observedAt: string,
  snapshotAt: Date,
  globalBuysPaused: boolean,
  vaultView: unknown,
  remainingAccounts: readonly string[],
): Promise<void> {
  runtime.globalConfig.globalBuysPaused = globalBuysPaused;
  runtime.globalConfig.maxGlobalExposureBps = asNumber(objectField(vaultView, "maxGlobalExposureBps", 6));
  runtime.vaultConfig.publicDeposits = Boolean(objectField(vaultView, "publicDeposits", 7));
  const patch = {
    globalConfig: runtime.globalConfig,
    vaultConfig: runtime.vaultConfig,
    marketHours: runtime.marketHours,
    marketsById: storedMarketMetadata(runtime.marketsById, runtime.marketStatesById),
    lastSnapshotAt: snapshotAt.toISOString(),
    lastSnapshotBlock: block.toString(),
    chainTimestamp,
    chainTimeObservedAt: observedAt,
    pendingSnapshot: false,
    registrySyncPending: false,
    pendingAccountSnapshots: remainingAccounts,
    rpc: runtime.clients.pool.stats(),
  };
  await tx`
    INSERT INTO keeper_status (job, last_run, last_ok, last_error, meta)
    VALUES ('indexer', NOW(), NOW(), NULL, ${JSON.stringify(patch)}::jsonb)
    ON CONFLICT (job) DO UPDATE SET
      last_run = NOW(),
      last_ok = NOW(),
      last_error = NULL,
      meta = keeper_status.meta || EXCLUDED.meta
  `;
}

/** Accounts read per multicall, and the cap on account reads per snapshot.
 * Accounts beyond the cap (or whose reads failed) stay queued for the next
 * snapshot, so a burst of dust transfers cannot inflate one snapshot. */
export const ACCOUNT_CHUNK_SIZE = 200;
export const MAX_ACCOUNTS_PER_SNAPSHOT = 1_000;

interface AccountVaultState {
  readonly account: Address;
  readonly isDepositor: boolean;
  readonly unlockTime: bigint;
}

async function readAccountStates(
  runtime: SnapshotRuntime,
  block: bigint,
  accounts: readonly Address[],
): Promise<AccountVaultState[]> {
  const results: AccountVaultState[] = [];
  for (let start = 0; start < accounts.length; start += ACCOUNT_CHUNK_SIZE) {
    const chunk = accounts.slice(start, start + ACCOUNT_CHUNK_SIZE);
    const contracts = chunk.flatMap((account) => [
      { address: runtime.deployment.contracts.vault, abi: WriterPoolAbi, functionName: "isDepositor", args: [account] },
      { address: runtime.deployment.contracts.vault, abi: WriterPoolAbi, functionName: "unlockTime", args: [account] },
    ]);
    let values: { status: "success" | "failure"; result?: unknown }[];
    try {
      // batchSize 0: one eth_call per chunk, chunks run one after another.
      values = (await runtime.clients.stateClient.multicall({
        contracts: contracts as never,
        allowFailure: true,
        batchSize: 0,
        blockNumber: block,
      } as never)) as typeof values;
    } catch (error) {
      runtime.logger.warn({ err: safeErrorSummary(error), remaining: accounts.length - start },
        "Account snapshot chunk failed; remaining accounts stay queued");
      break;
    }
    let failed = 0;
    for (const [index, account] of chunk.entries()) {
      const isDepositor = values[index * 2];
      const unlockTime = values[index * 2 + 1];
      if (isDepositor?.status !== "success" || unlockTime?.status !== "success") { failed++; continue; }
      results.push({ account, isDepositor: Boolean(isDepositor.result), unlockTime: asBigInt(unlockTime.result) });
    }
    if (failed > 0) runtime.logger.warn({ failed }, "Some account snapshot reads failed; those accounts stay queued");
  }
  return results;
}

export async function takeSnapshot(
  runtime: SnapshotRuntime,
  block: bigint,
  touchedAccounts: ReadonlySet<string>,
): Promise<SnapshotResult> {
  const blockTime = await timestampAtBlock(runtime.clients.pool, block);
  const observedAt = new Date().toISOString();
  const queuedAccounts = [...new Set([...touchedAccounts].map((address) => address.toLowerCase()))].sort();
  const marketIds = [...runtime.marketsById.keys()].sort((a, b) => a - b);
  const contracts: unknown[] = [
    { address: runtime.deployment.contracts.lens, abi: LemniscateLensAbi, functionName: "markets", args: [runtime.deployment.contracts.engine] },
    { address: runtime.deployment.contracts.lens, abi: LemniscateLensAbi, functionName: "vault", args: [runtime.deployment.contracts.engine] },
    { address: runtime.deployment.contracts.engine, abi: LemniscateEngineAbi, functionName: "globalBuysPaused" },
  ];
  for (const id of marketIds) {
    contracts.push({ address: runtime.deployment.contracts.engine, abi: LemniscateEngineAbi, functionName: "getState", args: [id] });
  }
  const values = (await runtime.clients.stateClient.multicall({
    contracts: contracts as never,
    allowFailure: false,
    blockNumber: block,
  } as never)) as unknown[];
  const accountStates = await readAccountStates(
    runtime, block, queuedAccounts.slice(0, MAX_ACCOUNTS_PER_SNAPSHOT) as Address[]);
  const processed = new Set<string>(accountStates.map((state) => state.account));
  const remainingAccounts = queuedAccounts.filter((account) => !processed.has(account));
  const marketViews = (Array.isArray(values[0]) ? values[0] : []) as Record<string, unknown>[];
  const vaultView = values[1] as Record<string, unknown>;
  const globalBuysPaused = Boolean(values[2]);
  const marketById = new Map(marketViews.map((market) => [asNumber(objectField(market, "id", 0)), market]));
  const snapshotAt = new Date();
  const chainDate = blockTime;
  const tickRows: TickInsertRow[] = [];

  for (const [index, id] of marketIds.entries()) {
    const marketView = marketById.get(id);
    if (!marketView) continue;
    const market = runtime.marketsById.get(id);
    if (!market) continue;
    const localBuysPaused = Boolean(objectField(marketView, "buysPaused", 6));
    const state = toMarketState(values[3 + index]);
    const hedgeUnitsRaw = objectField(marketView, "hedgeUnits", 16);
    const hedgeTargetRaw = objectField(marketView, "hedgeTarget", 17);
    const stateWithLens = {
      ...state,
      hedgeUnits: asBigInt(hedgeUnitsRaw).toString(),
      hedgeTarget: asBigInt(hedgeTargetRaw).toString(),
    } satisfies MarketStateSnapshot & Record<string, unknown>;
    runtime.marketStatesById.set(id, stateWithLens);

    const spotUpdatedAt = parseChainTimestamp(objectField(marketView, "spotUpdatedAt", 8)) ?? chainDate;
    tickRows.push({
      marketId: id,
      ts: chainDate.toISOString(),
      block: block.toString(),
      spot: wad(objectField(marketView, "spot", 7)),
      index: wad(objectField(marketView, "index", 9)),
      normFactor: wad(objectField(marketView, "normFactor", 10)),
      price: wad(objectField(marketView, "price", 11)),
      bid: wad(objectField(marketView, "bidPrice1", 18)),
      ask: wad(objectField(marketView, "askPrice1", 19)),
      carryWad: wad(objectField(marketView, "carryWad", 12)),
      regime: asNumber(objectField(marketView, "regime", 5)),
      buysPaused: localBuysPaused || globalBuysPaused,
      vaultShort: power(objectField(marketView, "vaultShort", 13)),
      liability: wad(objectField(marketView, "liability", 14)),
      hedgeUnits: power(hedgeUnitsRaw),
      hedgeTarget: power(hedgeTargetRaw),
      oracleUpdatedAt: spotUpdatedAt.toISOString(),
    });
  }

  const maxTotalDeposits =
    typeof runtime.vaultConfig.maxTotalDeposits === "string"
      ? parseUsdg(runtime.vaultConfig.maxTotalDeposits)
      : 0n;
  const totalAssetsRaw = asBigInt(objectField(vaultView, "totalAssets", 1));
  const depositCapRemaining = usdg(maxTotalDeposits > totalAssetsRaw ? maxTotalDeposits - totalAssetsRaw : 0n);
  const vaultTick = {
    ts: chainDate.toISOString(),
    block: block.toString(),
    nav: wad(objectField(vaultView, "nav", 0)),
    totalAssets: usdg(totalAssetsRaw),
    totalSupply: writerPool(objectField(vaultView, "totalSupply", 2)),
    navPerShare: wad(objectField(vaultView, "navPerShare", 3)),
    usdg: usdg(objectField(vaultView, "usdgBalance", 4)),
    totalLiability: wad(objectField(vaultView, "totalLiability", 5)),
    maxGlobalExposureBps: asNumber(objectField(vaultView, "maxGlobalExposureBps", 6)),
    publicDeposits: Boolean(objectField(vaultView, "publicDeposits", 7)),
    depositCapRemaining,
  };

  await runtime.sql.begin(async (tx) => {
    for (const row of tickRows) {
      await tx`
        INSERT INTO ticks (
          market_id, ts, block, spot, "index", norm_factor, price, bid, ask, carry_wad, regime,
          buys_paused, vault_short, liability, hedge_units, hedge_target, oracle_updated_at
        )
        VALUES (
          ${row.marketId}, ${row.ts}, ${row.block}, ${row.spot}, ${row.index}, ${row.normFactor},
          ${row.price}, ${row.bid}, ${row.ask}, ${row.carryWad}, ${row.regime}, ${row.buysPaused},
          ${row.vaultShort}, ${row.liability}, ${row.hedgeUnits}, ${row.hedgeTarget}, ${row.oracleUpdatedAt}
        )
        ON CONFLICT (market_id, ts) DO UPDATE SET
          block = EXCLUDED.block,
          spot = EXCLUDED.spot,
          "index" = EXCLUDED."index",
          norm_factor = EXCLUDED.norm_factor,
          price = EXCLUDED.price,
          bid = EXCLUDED.bid,
          ask = EXCLUDED.ask,
          carry_wad = EXCLUDED.carry_wad,
          regime = EXCLUDED.regime,
          buys_paused = EXCLUDED.buys_paused,
          vault_short = EXCLUDED.vault_short,
          liability = EXCLUDED.liability,
          hedge_units = EXCLUDED.hedge_units,
          hedge_target = EXCLUDED.hedge_target,
          oracle_updated_at = EXCLUDED.oracle_updated_at
      `;
    }
    await tx`
      INSERT INTO vault_ticks (
        ts, block, nav, total_assets, total_supply, nav_per_share, usdg, total_liability,
        max_global_exposure_bps, public_deposits, deposit_cap_remaining
      )
      VALUES (
        ${vaultTick.ts}, ${vaultTick.block}, ${vaultTick.nav}, ${vaultTick.totalAssets},
        ${vaultTick.totalSupply}, ${vaultTick.navPerShare}, ${vaultTick.usdg}, ${vaultTick.totalLiability},
        ${vaultTick.maxGlobalExposureBps}, ${vaultTick.publicDeposits}, ${vaultTick.depositCapRemaining}
      )
      ON CONFLICT (ts) DO UPDATE SET
        block = EXCLUDED.block,
        nav = EXCLUDED.nav,
        total_assets = EXCLUDED.total_assets,
        total_supply = EXCLUDED.total_supply,
        nav_per_share = EXCLUDED.nav_per_share,
        usdg = EXCLUDED.usdg,
        total_liability = EXCLUDED.total_liability,
        max_global_exposure_bps = EXCLUDED.max_global_exposure_bps,
        public_deposits = EXCLUDED.public_deposits,
        deposit_cap_remaining = EXCLUDED.deposit_cap_remaining
    `;

    for (const { account, isDepositor, unlockTime } of accountStates) {
      await tx`
        INSERT INTO vault_account_state (account, is_depositor, unlock_time, updated_block, updated_at)
        VALUES (
          ${account}, ${isDepositor},
          ${unlockTime === 0n ? null : new Date(Number(unlockTime) * 1_000).toISOString()},
          ${block.toString()}, NOW()
        )
        ON CONFLICT (account) DO UPDATE SET
          is_depositor = EXCLUDED.is_depositor,
          unlock_time = EXCLUDED.unlock_time,
          updated_block = GREATEST(vault_account_state.updated_block, EXCLUDED.updated_block),
          updated_at = NOW()
      `;
    }
    await storeSnapshotStatus(
      tx,
      runtime,
      block,
      chainTimestampFromDate(blockTime),
      observedAt,
      snapshotAt,
      globalBuysPaused,
      vaultView,
      remainingAccounts,
    );
    await tx.notify(
      LEMNISCATE_EVENTS_CHANNEL,
      JSON.stringify({
        block: block.toString(),
        markets: marketIds,
        kinds: ["snapshot"],
        logCount: 0,
      }),
    );
  });

  return {
    block,
    chainTimestamp: Math.floor(blockTime.getTime() / 1_000).toString(),
    observedAt,
    snapshotAt,
    processedAccounts: processed,
  };
}

function chainTimestampFromDate(value: Date): string {
  return Math.floor(value.getTime() / 1_000).toString();
}
