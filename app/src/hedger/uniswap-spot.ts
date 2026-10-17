import { encodeFunctionData, parseAbi, parseEventLogs, type Address } from "viem";
import { Erc20Abi } from "../abi/Erc20";
import { PoolAbi } from "../abi/Pool";
import type { ServiceClients } from "../chain/clients";
import type { KeeperTransaction, TransactionResult } from "../keeper/tx";
import { abs, STOCK_DECIMALS, USDG_DECIMALS, WAD, type HedgeFill, type IHedgeVenue } from "./types";

const poolAbi = parseAbi([
  "function token0() view returns (address)",
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
  "function liquidity() view returns (uint128)",
  "function observe(uint32[] secondsAgos) view returns (int56[] tickCumulatives, uint160[] secondsPerLiquidityCumulativeX128s)",
]);

const DECIMAL_GAP = 10 ** (STOCK_DECIMALS - USDG_DECIMALS);

export interface PoolPrices {
  /** TWAP and spot, USDG raw per whole stock. */
  twapPx: bigint;
  spotPx: bigint;
  /** USDG raw needed to move the pool price about 1% from here (in-range liquidity only). */
  depthUsdg: bigint;
}

/** USDG per whole stock from a Uniswap v3 tick (price of token0 in token1 = 1.0001^tick, raw units). */
export function pxFromTick(tick: number, stockIsToken0: boolean): bigint {
  const raw = Math.pow(1.0001, tick);
  const usdgPerStock = stockIsToken0 ? raw * DECIMAL_GAP : DECIMAL_GAP / raw;
  return BigInt(Math.round(usdgPerStock * 10 ** USDG_DECIMALS));
}

/** USDG raw to move the price ~1% (sqrt price 0.5%) through the in-range liquidity L. */
export function depthUsdgFor(liquidity: bigint, sqrtPriceX96: bigint, stockIsToken0: boolean): bigint {
  const sqrt = Number(sqrtPriceX96) / 2 ** 96;
  const L = Number(liquidity);
  const raw = stockIsToken0 ? L * sqrt * 0.005 : (L / sqrt) * 0.005; // USDG is token1 / token0 respectively
  return BigInt(Math.max(0, Math.floor(raw)));
}

/** Mean tick over the window, rounded toward negative infinity as Uniswap's oracle does. */
export function meanTick(cumulativeBefore: bigint, cumulativeNow: bigint, seconds: number): number {
  const delta = cumulativeNow - cumulativeBefore;
  const s = BigInt(seconds);
  let tick = delta / s;
  if (delta < 0n && delta % s !== 0n) tick -= 1n;
  return Number(tick);
}

export interface SpotRoute { pool: Address; fee: number }

/** The slippage limit handed to `pool.rebalance` (decision 19). `rebalance(stock, targetUnits, minOutOrMaxIn)` reads the
 * last argument as a CEILING on the USDG spent when buying and a FLOOR on the USDG received when selling. Both are
 * priced at the TWAP and widened by the allowed slippage; the pool applies its own, stricter, TWAP floor on top. */
export function limitFor(buy: boolean, stockUnits: bigint, twapPx: bigint, slippageBps: number): bigint {
  const value = (stockUnits * twapPx) / WAD;
  return buy ? (((value * BigInt(10_000 + slippageBps)) / 10_000n) + 1n) : (value * BigInt(10_000 - slippageBps)) / 10_000n;
}

/** What `pool.rebalance` did, read back from the chain. */
export interface RebalanceOutcome {
  hash: string;
  /** Stock units the pool holds after the call (`hedgeUnits`). */
  unitsAfter: bigint;
  /** USDG raw moved by the swap (spent when buying, received when selling), from the Rebalanced event; 0 if absent. */
  usdgMoved: bigint;
}

/** Everything the venue needs from the chain; the real one is {@link createChainPoolPort}, tests use a fake.
 * The hedger wallet holds gas only: no balance or allowance of the hedger wallet is ever read or used. */
export interface PoolHedgePort {
  prices(stock: Address): Promise<PoolPrices>;
  /** Stock units the Writer Pool holds as hedge (`pool.hedgeUnits`). */
  hedgeUnits(stock: Address): Promise<bigint>;
  /** USDG raw the pool holds (an upper bound on what a buy can spend). */
  poolCash(): Promise<bigint>;
  rebalance(params: { stock: Address; targetUnits: bigint; limit: bigint }): Promise<RebalanceOutcome>;
  healthy(): Promise<boolean>;
}

export interface PoolVenueOptions {
  maxLiquidityBps: number;
}

/** Decision 19 + R3. Spot hedging held BY THE WRITER POOL: this venue only computes a target and calls
 * `pool.rebalance`. It never holds, approves or moves funds, and reports no equity (the pool values spot on chain
 * inside NAV). Per-trade cap as a share of in-range liquidity; spot cannot be short, so targets never go below zero. */
export class PoolSpotVenue implements IHedgeVenue {
  readonly name = "pool-spot";
  readonly canShort = false;
  /** Spot is valued on chain inside NAV: never part of the posted (perp) hedge equity. */
  readonly postsEquity = false;
  constructor(private readonly port: PoolHedgePort, private readonly options: PoolVenueOptions) {}

  netPosition(stock: Address): Promise<bigint> {
    return this.port.hedgeUnits(stock);
  }

  /** Zero by design: pool-held spot is part of NAV on chain, so it is never posted as equity. */
  async equityUsdg(): Promise<bigint> {
    return 0n;
  }

  healthy(): Promise<boolean> {
    return this.port.healthy().catch(() => false);
  }

  private capUsdg(prices: PoolPrices): bigint {
    return (prices.depthUsdg * BigInt(this.options.maxLiquidityBps)) / 10_000n;
  }

  async maxTrade(stock: Address, buy: boolean): Promise<bigint> {
    const prices = await this.port.prices(stock);
    const capStock = (this.capUsdg(prices) * WAD) / prices.twapPx;
    if (buy) {
      const affordable = ((await this.port.poolCash()) * WAD) / prices.twapPx;
      return affordable < capStock ? affordable : capStock;
    }
    const held = await this.port.hedgeUnits(stock);
    return held < capStock ? held : capStock;
  }

  async trade(stock: Address, deltaUnits: bigint, maxSlippageBps: number): Promise<HedgeFill> {
    if (deltaUnits === 0n) return { ref: "", filled: 0n, px: 0n };
    const buy = deltaUnits > 0n;
    const prices = await this.port.prices(stock);
    const deviationBps = Number(((prices.spotPx > prices.twapPx ? prices.spotPx - prices.twapPx : prices.twapPx - prices.spotPx) * 10_000n) / prices.twapPx);
    if (deviationBps > maxSlippageBps) throw new Error(`pool price is ${deviationBps} bps from its TWAP; not hedging into it`);
    const room = await this.maxTrade(stock, buy);
    const wanted = abs(deltaUnits);
    const stockAmount = wanted < room ? wanted : room;
    if (stockAmount === 0n) return { ref: "", filled: 0n, px: 0n };
    const before = await this.port.hedgeUnits(stock);
    const targetUnits = buy ? before + stockAmount : before - stockAmount;
    const limit = limitFor(buy, stockAmount, prices.twapPx, maxSlippageBps);
    const outcome = await this.port.rebalance({ stock, targetUnits, limit });
    const moved = outcome.unitsAfter - before;
    if (moved === 0n) throw new Error(`rebalance ${outcome.hash} moved no units`);
    const stockMoved = abs(moved);
    const px = outcome.usdgMoved > 0n ? (outcome.usdgMoved * WAD) / stockMoved : prices.twapPx;
    return { ref: outcome.hash, filled: moved, px };
  }
}

export interface ChainPoolConfig {
  clients: ServiceClients;
  submit: (tx: KeeperTransaction) => Promise<TransactionResult>;
  pool: Address;
  usdg: Address;
  routes: ReadonlyMap<Address, SpotRoute>;
  twapSeconds: number;
}

/** The viem implementation of {@link PoolHedgePort}. The only transaction it ever sends is `pool.rebalance`. */
export function createChainPoolPort(config: ChainPoolConfig): PoolHedgePort {
  const { clients, submit, pool, usdg, routes, twapSeconds } = config;
  const stateClient = clients.stateClient;
  const route = (stock: Address): SpotRoute => {
    const found = routes.get(stock.toLowerCase() as Address);
    if (!found) throw new Error(`no Uniswap route configured for ${stock}`);
    return found;
  };
  const ordering = new Map<string, boolean>();
  const hedgeUnits = (stock: Address) =>
    stateClient.readContract({ address: pool, abi: PoolAbi, functionName: "hedgeUnits", args: [stock] }) as Promise<bigint>;
  return {
    hedgeUnits,
    poolCash: () => stateClient.readContract({ address: usdg, abi: Erc20Abi, functionName: "balanceOf", args: [pool] }) as Promise<bigint>,
    async prices(stock) {
      const { pool: uniPool } = route(stock);
      const key = uniPool.toLowerCase();
      if (!ordering.has(key)) {
        const token0 = await stateClient.readContract({ address: uniPool, abi: poolAbi, functionName: "token0" });
        ordering.set(key, token0.toLowerCase() === stock.toLowerCase());
      }
      const stockIsToken0 = ordering.get(key)!;
      const [slot, liquidity, observed] = await Promise.all([
        stateClient.readContract({ address: uniPool, abi: poolAbi, functionName: "slot0" }),
        stateClient.readContract({ address: uniPool, abi: poolAbi, functionName: "liquidity" }),
        stateClient.readContract({ address: uniPool, abi: poolAbi, functionName: "observe", args: [[twapSeconds, 0]] }),
      ]);
      const cumulatives = observed[0];
      const twapTick = meanTick(cumulatives[0]!, cumulatives[1]!, twapSeconds);
      return {
        twapPx: pxFromTick(twapTick, stockIsToken0),
        spotPx: pxFromTick(Number(slot[1]), stockIsToken0),
        depthUsdg: depthUsdgFor(liquidity, slot[0], stockIsToken0),
      };
    },
    async rebalance({ stock, targetUnits, limit }) {
      const result = await submit({
        label: "hedger:rebalance", to: pool,
        data: encodeFunctionData({ abi: PoolAbi, functionName: "rebalance", args: [stock, targetUnits, limit] }),
      });
      if (result.simulated || !result.hash) throw new Error("rebalance was only simulated");
      const events = parseEventLogs({ abi: PoolAbi, eventName: "Rebalanced", logs: result.receipt?.logs ?? [] });
      const mine = events.find((e) => e.address.toLowerCase() === pool.toLowerCase() && e.args.stock.toLowerCase() === stock.toLowerCase());
      // The pool's own Rebalanced event is authoritative; a state read right after the transaction can still answer
      // from before it (load-balanced RPC), which made a real trade look like "moved no units".
      const unitsAfter = mine ? mine.args.unitsAfter : await hedgeUnits(stock);
      return { hash: result.hash, unitsAfter, usdgMoved: mine ? (mine.args.buy ? mine.args.amountIn : mine.args.amountOut) : 0n };
    },
    async healthy() {
      await stateClient.getBlockNumber();
      return true;
    },
  };
}
