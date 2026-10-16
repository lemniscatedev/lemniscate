import { encodeFunctionData, parseAbi, type Address } from "viem";
import { Erc20Abi } from "../abi/Erc20";
import { UniswapV3HedgeAdapterAbi } from "../abi/UniswapV3HedgeAdapter";
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

/** The slippage floor: expected output at the TWAP, less the allowed slippage. Buy: USDG in, stock out. Sell: stock in. */
export function minOutFor(buy: boolean, amountIn: bigint, twapPx: bigint, slippageBps: number): bigint {
  const expected = buy ? (amountIn * WAD) / twapPx : (amountIn * twapPx) / WAD;
  return (expected * BigInt(10_000 - slippageBps)) / 10_000n;
}

export interface SpotRoute { pool: Address; fee: number }

/** Everything the venue needs from the chain; the real one is {@link createChainSpotPort}, tests use a fake. */
export interface SpotChainPort {
  prices(stock: Address): Promise<PoolPrices>;
  balance(token: Address): Promise<bigint>;
  allowance(token: Address): Promise<bigint>;
  approve(token: Address, amount: bigint): Promise<void>;
  swap(params: { tokenIn: Address; tokenOut: Address; fee: number; amountIn: bigint; minOut: bigint }): Promise<{ hash: string }>;
  fee(stock: Address): number;
  healthy(): Promise<boolean>;
}

export interface SpotVenueOptions {
  usdg: Address;
  stocks: Address[];
  maxLiquidityBps: number;
}

/** R3 + R7. Spot hedging through the on-chain adapter: exact-amount approvals, TWAP-floored minOut, per-trade cap as a
 * share of in-range liquidity. Spot cannot be short: sells are clamped to the held balance. */
export class UniswapV3SpotVenue implements IHedgeVenue {
  readonly name = "uniswap-v3-spot";
  readonly canShort = false;
  constructor(private readonly port: SpotChainPort, private readonly options: SpotVenueOptions) {}

  netPosition(stock: Address): Promise<bigint> {
    return this.port.balance(stock);
  }

  async equityUsdg(): Promise<bigint> {
    let total = await this.port.balance(this.options.usdg);
    for (const stock of this.options.stocks) {
      const [balance, prices] = await Promise.all([this.port.balance(stock), this.port.prices(stock)]);
      total += (balance * prices.twapPx) / WAD;
    }
    return total;
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
      const cash = await this.port.balance(this.options.usdg);
      const affordable = (cash * WAD) / prices.twapPx;
      return affordable < capStock ? affordable : capStock;
    }
    const held = await this.port.balance(stock);
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
    const tokenIn = buy ? this.options.usdg : stock;
    const tokenOut = buy ? stock : this.options.usdg;
    const amountIn = buy ? (stockAmount * prices.twapPx + WAD - 1n) / WAD : stockAmount;
    if (amountIn === 0n) return { ref: "", filled: 0n, px: 0n };
    const minOut = minOutFor(buy, amountIn, prices.twapPx, maxSlippageBps);
    const beforeOut = await this.port.balance(tokenOut);
    // R7: exactly amountIn, no standing allowance. The adapter pulls amountIn and resets the router approval itself.
    await this.port.approve(tokenIn, amountIn);
    let hash: string;
    try {
      ({ hash } = await this.port.swap({ tokenIn, tokenOut, fee: this.port.fee(stock), amountIn, minOut }));
    } finally {
      if ((await this.port.allowance(tokenIn)) !== 0n) await this.port.approve(tokenIn, 0n);
    }
    const out = (await this.port.balance(tokenOut)) - beforeOut;
    if (out <= 0n) throw new Error(`swap ${hash} returned no output`);
    const stockMoved = buy ? out : amountIn;
    const usdgMoved = buy ? amountIn : out;
    return { ref: hash, filled: buy ? stockMoved : -stockMoved, px: (usdgMoved * WAD) / stockMoved };
  }
}

export interface ChainSpotConfig {
  clients: ServiceClients;
  submit: (tx: KeeperTransaction) => Promise<TransactionResult>;
  /** The hedger wallet (holds and swaps the tokens). */
  hedger: Address;
  adapter: Address;
  usdg: Address;
  routes: ReadonlyMap<Address, SpotRoute>;
  twapSeconds: number;
}

/** The viem implementation of {@link SpotChainPort}. Swaps and approvals go through the transaction queue. */
export function createChainSpotPort(config: ChainSpotConfig): SpotChainPort {
  const { clients, submit, hedger, adapter, usdg, routes, twapSeconds } = config;
  const stateClient = clients.stateClient;
  const route = (stock: Address): SpotRoute => {
    const found = routes.get(stock.toLowerCase() as Address);
    if (!found) throw new Error(`no Uniswap route configured for ${stock}`);
    return found;
  };
  const ordering = new Map<string, boolean>();
  return {
    fee: (stock) => route(stock).fee,
    async prices(stock) {
      const { pool } = route(stock);
      const key = pool.toLowerCase();
      if (!ordering.has(key)) {
        const token0 = await stateClient.readContract({ address: pool, abi: poolAbi, functionName: "token0" });
        ordering.set(key, token0.toLowerCase() === stock.toLowerCase());
      }
      const stockIsToken0 = ordering.get(key)!;
      const [slot, liquidity, observed] = await Promise.all([
        stateClient.readContract({ address: pool, abi: poolAbi, functionName: "slot0" }),
        stateClient.readContract({ address: pool, abi: poolAbi, functionName: "liquidity" }),
        stateClient.readContract({ address: pool, abi: poolAbi, functionName: "observe", args: [[twapSeconds, 0]] }),
      ]);
      const cumulatives = observed[0];
      const twapTick = meanTick(cumulatives[0]!, cumulatives[1]!, twapSeconds);
      return {
        twapPx: pxFromTick(twapTick, stockIsToken0),
        spotPx: pxFromTick(Number(slot[1]), stockIsToken0),
        depthUsdg: depthUsdgFor(liquidity, slot[0], stockIsToken0),
      };
    },
    balance: (token) => stateClient.readContract({ address: token, abi: Erc20Abi, functionName: "balanceOf", args: [hedger] }) as Promise<bigint>,
    allowance: (token) => stateClient.readContract({ address: token, abi: Erc20Abi, functionName: "allowance", args: [hedger, adapter] }) as Promise<bigint>,
    async approve(token, amount) {
      await submit({ label: "hedger:approve", to: token, data: encodeFunctionData({ abi: Erc20Abi, functionName: "approve", args: [adapter, amount] }) });
    },
    async swap({ tokenIn, tokenOut, fee, amountIn, minOut }) {
      const result = await submit({
        label: "hedger:swap", to: adapter,
        data: encodeFunctionData({ abi: UniswapV3HedgeAdapterAbi, functionName: "swapExactIn", args: [tokenIn, tokenOut, fee, amountIn, minOut, hedger] }),
      });
      if (result.simulated || !result.hash) throw new Error("swap was only simulated");
      return { hash: result.hash };
    },
    async healthy() {
      await clients.stateClient.getBlockNumber();
      return true;
    },
  };
}
