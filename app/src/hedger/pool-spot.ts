import { decodeEventLog, encodeFunctionData, parseAbi, type Address, type Hex } from "viem";
import { PoolAbi } from "../abi/Pool";
import type { ServiceClients } from "../chain/clients";
import type { KeeperTransaction, TransactionResult } from "../keeper/tx";
import { abs, WAD, type HedgeFill, type IHedgeVenue } from "./types";
import type { PoolPrices, SpotChainPort } from "./uniswap-spot";

/** Everything the pool-backed venue needs from the chain; {@link createPoolSpotPort} is the real one, tests use a fake. */
export interface PoolSpotPort {
  prices(stock: Address): Promise<PoolPrices>;
  /** The pool's tracked spot hedge, raw Stock Token units (pool.hedgeUnits). */
  hedgeUnits(stock: Address): Promise<bigint>;
  /** The pool's USDG cash (6 dp). The pool keeps its own cash buffer on top; this only caps the request. */
  poolCash(): Promise<bigint>;
  /** pool.rebalance(stock, targetUnits, minOutOrMaxIn) from the HEDGER wallet (gas only). */
  rebalance(stock: Address, targetUnits: bigint, minOutOrMaxIn: bigint): Promise<{ hash: string; buy: boolean; amountIn: bigint; amountOut: bigint; unitsAfter: bigint }>;
  healthy(): Promise<boolean>;
}

export interface PoolSpotVenueOptions {
  stocks: Address[];
  maxLiquidityBps: number;
}

/** Decision 19 / todo 14b: the spot hedge is held BY THE WRITER POOL. The hedger computes a target per name and calls
 * `pool.rebalance(stock, targetUnits, limit)` with the HEDGER role; its wallet holds gas only and never touches pool
 * funds. Spot holdings are valued on chain inside NAV, so this venue reports zero equity (nothing to post). Caps: each
 * trade at most `maxLiquidityBps` of the USDG that moves the Uniswap pool about 1%; buys at most the pool's cash; sells
 * at most the pool's held units (spot cannot short). The pool applies its own oracle/TWAP floor as well. */
export class PoolSpotVenue implements IHedgeVenue {
  readonly name = "pool-spot";
  readonly canShort = false;
  /** Spot is valued on chain inside NAV: never part of the posted (perp) hedge equity. */
  readonly postsEquity = false;
  constructor(private readonly port: PoolSpotPort, private readonly options: PoolSpotVenueOptions) {}

  netPosition(stock: Address): Promise<bigint> {
    return this.port.hedgeUnits(stock);
  }

  async equityUsdg(): Promise<bigint> {
    return 0n;
  }

  healthy(): Promise<boolean> {
    return this.port.healthy().catch(() => false);
  }

  async maxTrade(stock: Address, buy: boolean): Promise<bigint> {
    const prices = await this.port.prices(stock);
    const capStock = (((prices.depthUsdg * BigInt(this.options.maxLiquidityBps)) / 10_000n) * WAD) / prices.twapPx;
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
    const gap = prices.spotPx > prices.twapPx ? prices.spotPx - prices.twapPx : prices.twapPx - prices.spotPx;
    const deviationBps = Number((gap * 10_000n) / prices.twapPx);
    if (deviationBps > maxSlippageBps) throw new Error(`pool price is ${deviationBps} bps from its TWAP; not hedging into it`);
    const room = await this.maxTrade(stock, buy);
    const wanted = abs(deltaUnits);
    const units = wanted < room ? wanted : room;
    if (units === 0n) return { ref: "", filled: 0n, px: 0n };
    const held = await this.port.hedgeUnits(stock);
    const target = buy ? held + units : held - units;
    const valueAtTwap = (units * prices.twapPx) / WAD;
    // Buy: the most USDG the pool may spend. Sell: the least USDG it must receive.
    const limit = buy
      ? (valueAtTwap * BigInt(10_000 + maxSlippageBps) + 9_999n) / 10_000n
      : (valueAtTwap * BigInt(10_000 - maxSlippageBps)) / 10_000n;
    if (limit === 0n) return { ref: "", filled: 0n, px: 0n };
    const r = await this.port.rebalance(stock, target, limit);
    const stockMoved = r.buy ? r.amountOut : r.amountIn;
    const usdgMoved = r.buy ? r.amountIn : r.amountOut;
    if (stockMoved === 0n) throw new Error(`rebalance ${r.hash} moved no stock`);
    return { ref: r.hash, filled: r.buy ? stockMoved : -stockMoved, px: (usdgMoved * WAD) / stockMoved };
  }
}

const erc20 = parseAbi(["function balanceOf(address) view returns (uint256)"]);

export interface PoolSpotConfig {
  clients: ServiceClients;
  submit: (tx: KeeperTransaction) => Promise<TransactionResult>;
  pool: Address;
  usdg: Address;
  /** Price, TWAP and depth reads (the Uniswap pool behind each route): createChainSpotPort's `prices`. */
  prices: SpotChainPort["prices"];
}

/** The viem implementation of {@link PoolSpotPort}: reads the pool, sends `rebalance` through the transaction queue and
 * reads the fill from the pool's `Rebalanced` event. */
export function createPoolSpotPort(config: PoolSpotConfig): PoolSpotPort {
  const { clients, submit, pool, usdg } = config;
  return {
    prices: config.prices,
    hedgeUnits: (stock) => clients.stateClient.readContract({ address: pool, abi: PoolAbi, functionName: "hedgeUnits", args: [stock] }) as Promise<bigint>,
    poolCash: () => clients.stateClient.readContract({ address: usdg, abi: erc20, functionName: "balanceOf", args: [pool] }) as Promise<bigint>,
    async rebalance(stock, targetUnits, limit) {
      const result = await submit({
        label: "hedger:rebalance", to: pool,
        data: encodeFunctionData({ abi: PoolAbi, functionName: "rebalance", args: [stock, targetUnits, limit] }),
      });
      if (result.simulated || !result.hash) throw new Error("rebalance was only simulated");
      const receipt = result.receipt ?? await clients.txClient.getTransactionReceipt({ hash: result.hash });
      if (receipt.status !== "success") throw new Error(`rebalance ${result.hash} reverted`);
      for (const log of receipt.logs) {
        if (log.address.toLowerCase() !== pool.toLowerCase()) continue;
        try {
          const ev = decodeEventLog({ abi: PoolAbi, data: log.data as Hex, topics: log.topics as [Hex, ...Hex[]] });
          if (ev.eventName === "Rebalanced") {
            const a = ev.args as { buy: boolean; amountIn: bigint; amountOut: bigint; unitsAfter: bigint };
            return { hash: result.hash, buy: a.buy, amountIn: a.amountIn, amountOut: a.amountOut, unitsAfter: a.unitsAfter };
          }
        } catch { /* another pool event */ }
      }
      throw new Error(`rebalance ${result.hash} emitted no Rebalanced event`);
    },
    async healthy() {
      await clients.stateClient.getBlockNumber();
      return true;
    },
  };
}
