// Fixtures for the indexer tests: an in-memory chain that can be reorganised, log encoders built on the generated
// ABIs, a deployment and a snapshot reader that returns scripted values. Test code only.
import {
  encodeAbiParameters,
  encodeEventTopics,
  keccak256,
  toHex,
  type Abi,
  type AbiEvent,
  type Address,
  type Hex,
} from "viem";
import { pino } from "pino";
import {
  AgentRouterAbi,
  OptionEngineAbi,
  OptionTokenAbi,
  PoolAbi,
  PriceGuardAbi,
  SeriesRegistryAbi,
  VolOracleAbi,
} from "../abi";
import { parseOptionDeployment, type OptionDeployment } from "../chain/deployment";
import type { ChainSource, LogRange } from "./chain-source";
import type { IndexerSettings } from "./ingest";
import type { HoldReading, PoolReading, SeriesReading, SnapshotReader, StockReading } from "./snapshot";
import type { BlockHeader, RpcLog } from "./types";

export const a = (n: number): Address => `0x${n.toString(16).padStart(40, "0")}` as Address;
export const b32 = (n: number): Hex => `0x${n.toString(16).padStart(64, "0")}` as Hex;

export const ADDR = {
  engine: a(0x1001),
  pool: a(0x1002),
  registry: a(0x1003),
  priceGuard: a(0x1004),
  volOracle: a(0x1005),
  usdg: a(0x1006),
  agentRouter: a(0x1007),
  reserve: a(0x1008),
  nvda: a(0x2001),
  tsla: a(0x2002),
  nvdaFeed: a(0x3001),
  alice: a(0xa11ce),
  bob: a(0xb0b),
  carol: a(0xca401),
  dave: a(0xda7e),
  agent: a(0xa6e47),
  tokenCall: a(0x4001),
  tokenPut: a(0x4002),
} as const;

export const SERIES_CALL = b32(0xc0ffee);
export const SERIES_PUT = b32(0xdeadbeef);

export const DEPLOY_BLOCK = 100;

export function testDeployment(overrides: Record<string, unknown> = {}): OptionDeployment {
  return parseOptionDeployment({
    chainId: 4663,
    network: "fork",
    deployBlock: DEPLOY_BLOCK,
    contracts: {
      engine: ADDR.engine,
      pool: ADDR.pool,
      registry: ADDR.registry,
      priceGuard: ADDR.priceGuard,
      volOracle: ADDR.volOracle,
      usdg: ADDR.usdg,
      agentRouter: ADDR.agentRouter,
      reserve: ADDR.reserve,
    },
    poolShareDecimals: 12,
    stocks: [
      { name: "NVDA", stock: ADDR.nvda, feed: ADDR.nvdaFeed },
      { name: "TSLA", stock: ADDR.tsla },
    ],
    ...overrides,
  });
}

export const testSettings: IndexerSettings = { confirmations: 0, pollActiveMs: 0, pollBaseMs: 1, pollIdleMs: 1 };
export const silentLogger = pino({ level: "silent" });

/** One log to place in a block. */
export interface LogSpec {
  readonly address: Address;
  readonly abi: Abi;
  readonly eventName: string;
  readonly args: Record<string, unknown>;
  /** Transactions are identified by this label within a block; logs with the same label share a tx hash. */
  readonly tx?: string;
}

export function encodeLogData(abi: Abi, eventName: string, args: Record<string, unknown>): { topics: Hex[]; data: Hex } {
  const event = (abi as readonly AbiEvent[]).find((item) => item.type === "event" && item.name === eventName);
  if (!event) throw new Error(`event ${eventName} not in ABI`);
  const topics = encodeEventTopics({ abi, eventName, args } as never) as Hex[];
  const nonIndexed = event.inputs.filter((input) => !input.indexed);
  const data = nonIndexed.length === 0 ? "0x" : encodeAbiParameters(nonIndexed, nonIndexed.map((input) => args[input.name as string]) as never);
  return { topics, data };
}

interface StoredBlock {
  readonly header: BlockHeader;
  readonly logs: RpcLog[];
}

export const BASE_TIME = 1_790_000_000;

/** A chain in memory. `reorg` replaces the tail with a different branch (new hashes, new transactions). */
export class FakeChain implements ChainSource {
  readonly blocks = new Map<bigint, StoredBlock>();
  readonly inputs = new Map<string, Hex>();
  private salt = "a";
  private headNumber: bigint;
  getLogsCalls = 0;

  constructor(readonly genesis: bigint = BigInt(DEPLOY_BLOCK - 1)) {
    this.headNumber = genesis;
    this.put(genesis, []);
  }

  private hashOf(number: bigint, content: string): Hex {
    return keccak256(toHex(`${this.salt}:${number}:${content}`));
  }

  private put(number: bigint, specs: readonly LogSpec[]): void {
    const parent = this.blocks.get(number - 1n)?.header.hash ?? keccak256(toHex("genesis"));
    const txHashes = new Map<string, Hex>();
    const logs: RpcLog[] = specs.map((spec, index) => {
      const label = spec.tx ?? `tx${index}`;
      let txHash = txHashes.get(label);
      if (!txHash) {
        txHash = keccak256(toHex(`${this.salt}:tx:${number}:${label}`));
        txHashes.set(label, txHash);
      }
      const { topics, data } = encodeLogData(spec.abi, spec.eventName, spec.args);
      return {
        address: spec.address,
        blockNumber: toHex(number),
        transactionHash: txHash,
        logIndex: toHex(index),
        data,
        topics,
      };
    });
    const content = logs.map((log) => `${log.address}${log.topics.join("")}${log.data}`).join("|");
    this.blocks.set(number, {
      header: { number, hash: this.hashOf(number, content), parentHash: parent, timestamp: new Date((BASE_TIME + Number(number) * 2) * 1_000) },
      logs,
    });
  }

  /** Mines one block holding `specs`. Returns its number. */
  mine(specs: readonly LogSpec[] = []): bigint {
    this.headNumber += 1n;
    this.put(this.headNumber, specs);
    return this.headNumber;
  }

  mineEmpty(count: number): void {
    for (let i = 0; i < count; i += 1) this.mine();
  }

  /** Drops every block above `keep` and mines `branch` (one entry per block) on top, under a new branch salt. */
  reorg(keep: bigint, branch: readonly (readonly LogSpec[])[], salt = `b${keep}`): void {
    for (const number of [...this.blocks.keys()]) if (number > keep) this.blocks.delete(number);
    this.headNumber = keep;
    this.salt = salt;
    for (const specs of branch) this.mine(specs);
  }

  setTransactionInput(hash: string, input: Hex): void {
    this.inputs.set(hash.toLowerCase(), input);
  }

  txHashOf(number: bigint, logIndex: number): string {
    return String(this.blocks.get(number)!.logs[logIndex]!.transactionHash);
  }

  async getHead(): Promise<bigint> {
    return this.headNumber;
  }

  async getLogs(range: LogRange) {
    this.getLogsCalls += 1;
    const lemniscate = new Set(range.lemniscateAddresses.map((address) => address.toLowerCase()));
    const stocks = new Set(range.stockAddresses.map((address) => address.toLowerCase()));
    const lemniscateLogs: RpcLog[] = [];
    const stockLogs: RpcLog[] = [];
    for (let number = range.fromBlock; number <= range.toBlock; number += 1n) {
      for (const log of this.blocks.get(number)?.logs ?? []) {
        const address = log.address.toLowerCase();
        if (lemniscate.has(address)) lemniscateLogs.push(log);
        else if (stocks.has(address) && range.stockTopics.includes(log.topics[0]!)) stockLogs.push(log);
      }
    }
    return { lemniscateLogs, stockLogs };
  }

  async getHeaders(numbers: readonly bigint[]) {
    const result = new Map<bigint, BlockHeader | undefined>();
    for (const number of numbers) result.set(number, this.blocks.get(number)?.header);
    return result;
  }

  async getTransactionInput(hash: string) {
    return this.inputs.get(hash.toLowerCase());
  }
}

/** Snapshot reader returning scripted values (and counting how often it was asked). */
export class FakeReader implements SnapshotReader {
  poolCalls = 0;
  pool: PoolReading = {
    usdgBalance: 1_500_000_000n, // 1,500 USDG
    hedgeEquity: 250_000_000n, // 250 USDG
    liabilityWad: 400n * 10n ** 18n,
    navWad: 1_350n * 10n ** 18n,
    navPerShareWad: 1_050_000_000_000_000_000n,
    reserveUsdg: 75_000_000n,
  };
  stocks: Record<string, Partial<StockReading>> = {};
  series: Record<string, Partial<SeriesReading>> = {};
  /** engine.holdOf answers by `${seriesId}:${account}`; pairs asked for are recorded. */
  holds: Record<string, { until: bigint; sWad: bigint }> = {};
  holdPairs: string[] = [];
  fail = false;

  async readHolds(pairs: readonly { seriesId: string; account: string }[], _block: bigint): Promise<HoldReading[]> {
    return pairs.map(({ seriesId, account }) => {
      this.holdPairs.push(`${seriesId}:${account}`);
      return { seriesId, account, ...(this.holds[`${seriesId}:${account}`] ?? { until: 0n, sWad: 0n }) };
    });
  }

  async readPool(_block: bigint) {
    this.poolCalls += 1;
    if (this.fail) throw new Error("rpc down");
    return this.pool;
  }

  async readStocks(stocks: readonly string[], _block: bigint): Promise<StockReading[]> {
    return stocks.map((stock) => ({
      stock,
      spotWad: 120n * 10n ** 18n,
      session: 0,
      fresh: true,
      buysPaused: false,
      updatedAt: BigInt(BASE_TIME),
      volDaily: { sigmaBps: 5000, stale: false },
      volWeekly: { sigmaBps: 4800, stale: false },
      deltaWad: 0n,
      gammaWad: 0n,
      vegaWad: 0n,
      ...(this.stocks[stock] ?? {}),
    }));
  }

  async readSeries(ids: readonly string[], _block: bigint): Promise<SeriesReading[]> {
    return ids.map((id) => ({
      id,
      norm: 10n ** 18n,
      lastAccrual: BigInt(BASE_TIME),
      buyable: true,
      archived: false,
      ...(this.series[id] ?? {}),
    }));
  }
}

// -- log specs for the frozen events ------------------------------------------------------------------------------

export const ev = {
  seriesListed: (id: Hex, stock: Address, isCall: boolean, speed: number, strike: bigint, token: Address): LogSpec => ({
    address: ADDR.registry, abi: SeriesRegistryAbi as Abi, eventName: "SeriesListed", args: { id, stock, isCall, speed, strike, token },
  }),
  buyableSet: (id: Hex, buyable: boolean): LogSpec => ({ address: ADDR.registry, abi: SeriesRegistryAbi as Abi, eventName: "SeriesBuyableSet", args: { id, buyable } }),
  archived: (id: Hex): LogSpec => ({ address: ADDR.registry, abi: SeriesRegistryAbi as Abi, eventName: "SeriesArchived", args: { id } }),
  bought: (id: Hex, account: Address, recipient: Address, units: bigint, tokens: bigint, usdgPaid: bigint, vMarkWad: bigint, sigmaBps = 5000n, session = 0, tx?: string): LogSpec => ({
    address: ADDR.engine, abi: OptionEngineAbi as Abi, eventName: "Bought", args: { id, account, recipient, units, tokens, usdgPaid, vMarkWad, sigmaBps, session },
    ...(tx ? { tx } : {}),
  }),
  sold: (id: Hex, account: Address, recipient: Address, units: bigint, tokens: bigint, usdgReceived: bigint, vMarkWad: bigint, sigmaBps = 5000n, session = 0): LogSpec => ({
    address: ADDR.engine, abi: OptionEngineAbi as Abi, eventName: "Sold", args: { id, account, recipient, units, tokens, usdgReceived, vMarkWad, sigmaBps, session },
  }),
  accrued: (id: Hex, norm: bigint, vMarkWad: bigint, payoffWad: bigint, session = 0): LogSpec => ({
    address: ADDR.engine, abi: OptionEngineAbi as Abi, eventName: "Accrued", args: { id, norm, vMarkWad, payoffWad, session },
  }),
  shield: (account: Address, stock: Address, id: Hex, tokenUnits: bigint, usdgPaid: bigint): LogSpec => ({
    address: ADDR.engine, abi: OptionEngineAbi as Abi, eventName: "ShieldBought", args: { account, stock, id, tokenUnits, usdgPaid },
  }),
  buysPaused: (global: boolean, id: Hex, paused: boolean): LogSpec => ({ address: ADDR.engine, abi: OptionEngineAbi as Abi, eventName: "BuysPaused", args: { global, id, paused } }),
  sellQueued: (ticket: bigint, id: Hex, seller: Address, recipient: Address, tokens: bigint, queuedAt: bigint): LogSpec => ({
    address: ADDR.engine, abi: OptionEngineAbi as Abi, eventName: "SellQueued", args: { ticket, id, seller, recipient, tokens, queuedAt },
  }),
  queuedFilled: (ticket: bigint, filler: Address, usdgOut: bigint): LogSpec => ({ address: ADDR.engine, abi: OptionEngineAbi as Abi, eventName: "QueuedSellFilled", args: { ticket, filler, usdgOut } }),
  queuedCancelled: (ticket: bigint): LogSpec => ({ address: ADDR.engine, abi: OptionEngineAbi as Abi, eventName: "QueuedSellCancelled", args: { ticket } }),
  volPosted: (stock: Address, speed: number, sigmaBps: bigint, skewK: bigint, eventBumpBps: bigint, validUntil: bigint, nonce: bigint): LogSpec => ({
    address: ADDR.volOracle, abi: VolOracleAbi as Abi, eventName: "VolPosted", args: { stock, speed, sigmaBps, skewK, eventBumpBps, validUntil, nonce },
  }),
  rebalanced: (stock: Address, buy: boolean, amountIn: bigint, amountOut: bigint, unitsAfter: bigint): LogSpec => ({ address: ADDR.pool, abi: PoolAbi as Abi, eventName: "Rebalanced", args: { stock, buy, amountIn, amountOut, unitsAfter } }),
  cashRaised: (stock: Address, stockSold: bigint, usdgOut: bigint): LogSpec => ({ address: ADDR.pool, abi: PoolAbi as Abi, eventName: "CashRaised", args: { stock, stockSold, usdgOut } }),
  hedgeUnitsSynced: (stock: Address, units: bigint): LogSpec => ({ address: ADDR.pool, abi: PoolAbi as Abi, eventName: "HedgeUnitsSynced", args: { stock, units } }),
  hedgeEquity: (equityUsdg: bigint, asOf: bigint, ref: Hex): LogSpec => ({ address: ADDR.pool, abi: PoolAbi as Abi, eventName: "HedgeEquityPosted", args: { equityUsdg, asOf, ref } }),
  withdrawalQueued: (owner: Address, ticket: bigint, shares: bigint, claimableAt: bigint): LogSpec => ({ address: ADDR.pool, abi: PoolAbi as Abi, eventName: "WithdrawalQueued", args: { owner, ticket, shares, claimableAt } }),
  withdrawalClaimed: (owner: Address, ticket: bigint, usdg: bigint): LogSpec => ({ address: ADDR.pool, abi: PoolAbi as Abi, eventName: "WithdrawalClaimed", args: { owner, ticket, usdg } }),
  poolDeposit: (sender: Address, owner: Address, assets: bigint, shares: bigint): LogSpec => ({ address: ADDR.pool, abi: PoolAbi as Abi, eventName: "Deposit", args: { sender, owner, assets, shares } }),
  poolWithdraw: (sender: Address, receiver: Address, owner: Address, assets: bigint, shares: bigint): LogSpec => ({ address: ADDR.pool, abi: PoolAbi as Abi, eventName: "Withdraw", args: { sender, receiver, owner, assets, shares } }),
  poolTransfer: (from: Address, to: Address, value: bigint): LogSpec => ({ address: ADDR.pool, abi: PoolAbi as Abi, eventName: "Transfer", args: { from, to, value } }),
  agentTrade: (owner: Address, agent: Address, seriesId: Hex, isBuy: boolean, usdg: bigint): LogSpec => ({
    address: ADDR.agentRouter, abi: AgentRouterAbi as Abi, eventName: "AgentTrade", args: { owner, agent, seriesId, isBuy, usdg },
  }),
  policySet: (owner: Address, agent: Address, budgetUsdg: bigint, maxPerTradeUsdg: bigint, expiresAt: bigint, canSell: boolean, canShield: boolean): LogSpec => ({
    address: ADDR.agentRouter, abi: AgentRouterAbi as Abi, eventName: "PolicySet", args: { owner, agent, budgetUsdg, maxPerTradeUsdg, expiresAt, canSell, canShield },
  }),
  policyStocks: (owner: Address, agent: Address, stocks: Address[]): LogSpec => ({
    address: ADDR.agentRouter, abi: AgentRouterAbi as Abi, eventName: "PolicyStocks", args: { owner, agent, stocks },
  }),
  queuedSellFor: (ticket: bigint, owner: Address, agent: Address, seriesId: Hex): LogSpec => ({
    address: ADDR.agentRouter, abi: AgentRouterAbi as Abi, eventName: "QueuedSellFor", args: { ticket, owner, agent, seriesId },
  }),
  policyRevoked: (owner: Address, agent: Address): LogSpec => ({
    address: ADDR.agentRouter, abi: AgentRouterAbi as Abi, eventName: "PolicyRevoked", args: { owner, agent },
  }),
  stockPaused: (stock: Address, paused: boolean, reason: Hex): LogSpec => ({ address: ADDR.priceGuard, abi: PriceGuardAbi as Abi, eventName: "BuysPausedSet", args: { stock, paused, reason } }),
  transfer: (token: Address, from: Address, to: Address, value: bigint): LogSpec => ({ address: token, abi: OptionTokenAbi as Abi, eventName: "Transfer", args: { from, to, value } }),
  seriesRetired: (id: Hex): LogSpec => ({ address: ADDR.engine, abi: OptionEngineAbi as Abi, eventName: "SeriesRetired", args: { id } }),
  stockSettled: (stock: Address, s: bigint): LogSpec => ({ address: ADDR.engine, abi: OptionEngineAbi as Abi, eventName: "StockSettled", args: { stock, s } }),
  haltLatched: (stock: Address, since: bigint): LogSpec => ({ address: ADDR.priceGuard, abi: PriceGuardAbi as Abi, eventName: "HaltLatched", args: { stock, since } }),
};

/** All the rows of the tables the indexer writes, in a stable order, for equality checks between two runs. */
export async function dumpTables(sql: import("postgres").Sql): Promise<Record<string, unknown[]>> {
  const queries: Record<string, string> = {
    series: "SELECT * FROM series ORDER BY id",
    series_flag_log: "SELECT * FROM series_flag_log ORDER BY block, log_index, kind",
    trades: "SELECT * FROM trades ORDER BY block, log_index",
    shields: "SELECT * FROM shields ORDER BY block, log_index",
    agent_trades: "SELECT * FROM agent_trades ORDER BY block, log_index",
    agent_policy_events: "SELECT * FROM agent_policy_events ORDER BY block, log_index",
    agent_policy_stocks: "SELECT * FROM agent_policy_stocks ORDER BY block, log_index",
    router_tickets: "SELECT * FROM router_tickets ORDER BY block, log_index",
    norm_history: "SELECT * FROM norm_history ORDER BY block, log_index",
    vol_posts: "SELECT * FROM vol_posts ORDER BY block, log_index",
    queued_sells: "SELECT * FROM queued_sells ORDER BY ticket",
    withdrawals: "SELECT * FROM withdrawals ORDER BY owner, ticket",
    pool_events: "SELECT * FROM pool_events ORDER BY block, log_index",
    hedge_equity_posts: "SELECT * FROM hedge_equity_posts ORDER BY block, log_index",
    pause_log: "SELECT * FROM pause_log ORDER BY block, log_index",
    transfers: "SELECT * FROM transfers ORDER BY block, log_index",
    balances: "SELECT token, account, balance, updated_block FROM balances WHERE balance <> 0 ORDER BY token, account",
    account_metadata: "SELECT address, first_seen_block, last_seen_block FROM account_metadata ORDER BY address",
    pool_nav: "SELECT * FROM pool_nav ORDER BY ts",
    ticks: "SELECT * FROM ticks ORDER BY ts, stock_token",
    limits_state: "SELECT * FROM limits_state ORDER BY ts, name",
    corp_actions: "SELECT id, symbol, kind, status, old_mult, new_mult FROM corp_actions ORDER BY id",
  };
  const out: Record<string, unknown[]> = {};
  for (const [name, query] of Object.entries(queries)) out[name] = [...(await sql.unsafe(query))];
  return out;
}

import type { Sql } from "postgres";
import { confirmedAt, createIndexerState, runIndexerTick, type IndexerState } from "./ingest";

export async function makeIndexer(
  sql: Sql,
  chain: FakeChain,
  options: { reader?: FakeReader; settings?: IndexerSettings; deployment?: OptionDeployment; now?: () => number } = {},
): Promise<{ state: IndexerState; reader: FakeReader }> {
  const reader = options.reader ?? new FakeReader();
  const state = await createIndexerState({
    settings: options.settings ?? testSettings,
    source: chain,
    reader,
    sql,
    logger: silentLogger,
    deployment: options.deployment ?? testDeployment(),
    ...(options.now ? { now: options.now } : {}),
  });
  return { state, reader };
}

/** Runs ticks until the indexer has ingested everything up to the confirmed head and has no snapshot pending. */
export async function syncToHead(state: IndexerState, maxTicks = 200): Promise<void> {
  for (let i = 0; i < maxTicks; i += 1) {
    await runIndexerTick(state);
    const head = await state.source.getHead();
    if (state.cursor >= confirmedAt(state.settings, head) && !state.pendingSnapshot) return;
  }
  throw new Error("indexer did not catch up");
}
