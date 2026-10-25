import { decodeFunctionData, encodeAbiParameters, keccak256, type Address, type Hex } from "viem";
import { OptionEngineAbi, PriceGuardAbi, SeriesRegistryAbi } from "../abi";
import { createLogger } from "../log";
import { LmnsBuyBurnKeeperAbi, LmnsStakingKeeperAbi } from "./jobs/lmns";

/** SeriesRegistry.idOfEpoch, written out here on purpose (not imported from the code under test). */
const seriesId = (stock: Address, isCall: boolean, strike: bigint, tau: number, epoch: number): Hex => keccak256(encodeAbiParameters(
  [{ type: "address" }, { type: "bool" }, { type: "uint128" }, { type: "uint32" }, { type: "uint32" }], [stock, isCall, strike, tau, epoch]));
import type { KeeperContext } from "./context";

export const WAD = 10n ** 18n;
export const A = {
  engine: "0x00000000000000000000000000000000000000e1" as Address,
  registry: "0x00000000000000000000000000000000000000e2" as Address,
  priceGuard: "0x00000000000000000000000000000000000000e3" as Address,
  marketHours: "0x00000000000000000000000000000000000000e4" as Address,
  nvda: "0x0000000000000000000000000000000000000a01" as Address,
  spy: "0x0000000000000000000000000000000000000a02" as Address,
};

export interface FakeSeries {
  id: Hex; stock: Address; isCall: boolean; speed: number; tauSeconds: number; strike: bigint; token: Address;
  norm: bigint; lastAccrual: bigint; listedAt: bigint; buyable: boolean; archived: boolean; supply: bigint;
  /** On the engine's live list (engine.liveSeries). Defaults to supply > 0. */
  live?: boolean;
  /** engine.seriesRisk(id).value: last-touch outstanding value (WAD USDG). Defaults to 10 USDG. */
  riskValue?: bigint;
}
export interface FakePrice { s: bigint; session: number; fresh: boolean; buysPaused: boolean; updatedAt: bigint }
export interface SentTx { label: string; to: Address; data: Hex; name: string; args: readonly unknown[] }

const ABIS = [SeriesRegistryAbi, OptionEngineAbi, PriceGuardAbi, LmnsStakingKeeperAbi, LmnsBuyBurnKeeperAbi];

/** A mocked chain: registry, price guard, option tokens and a transaction queue that applies the calls it understands. */
export class FakeChain {
  nowSeconds = 1_800_000_000n;
  series = new Map<Hex, FakeSeries>();
  order: Hex[] = [];
  prices = new Map<Address, FakePrice>();
  /** PriceGuard.lastGoodPrice per stock, written by poke(). */
  lastGood = new Map<Address, { s: bigint; at: bigint }>();
  sent: SentTx[] = [];
  dryRun = false;
  /** Make a named call (or `${name}:${id}`) revert. */
  failing = new Set<string>();
  listDefaultBuyable = true;
  /** Model the RPC pool's short eth_call cache at "latest": the first seriesCount read is served again afterwards. Reads
   * pinned to a block number are always fresh. */
  staleLatest = false;
  private cachedCount: bigint | undefined;
  multicalls = 0;
  /** engine.guards(): minimum trade in 6-decimal USDG ($1), hold, settle delay. */
  guards = { minTradeUsdg: 1_000_000n, holdSeconds: 1800, haltSettleDelay: 7 * 86_400 };
  /** PriceGuard.haltedSince per stock (unix seconds) and engine.settlePrice per stock (ORC-4). */
  haltedSince = new Map<Address, bigint>();
  /** MarketHours.kindAt(now): 0 REGULAR, 1 EXTENDED, 2 CLOSED, 3 UNKNOWN (R05: the halt latch only writes in session). */
  kind = 0;
  /** ERC-20 balanceOf answers by `${token}:${holder}`. */
  erc20Balances = new Map<string, bigint>();
  settlePrices = new Map<Address, bigint>();
  /** retireDust re-accrues before it decides: a value here replaces riskValue at that moment (models a refreshed mark). */
  refreshedRisk = new Map<Hex, bigint>();

  /** Epochs per (stock, isCall, strike, tau), as SeriesRegistry keeps them (todo 07b): ids carry the epoch. */
  epochs = new Map<string, number>();

  addSeries(partial: Partial<FakeSeries> & { stock: Address; isCall: boolean; strike: bigint; tauSeconds: number }): FakeSeries {
    const key = `${partial.stock.toLowerCase()}:${partial.isCall}:${partial.strike}:${partial.tauSeconds}`;
    const epoch = this.epochs.get(key) ?? 0;
    this.epochs.set(key, epoch + 1);
    const id = seriesId(partial.stock, partial.isCall, partial.strike, partial.tauSeconds, epoch);
    const series: FakeSeries = {
      id, speed: partial.tauSeconds === 86_400 ? 0 : 1, token: `0x${(this.order.length + 1).toString(16).padStart(40, "c")}` as Address,
      norm: WAD, lastAccrual: this.nowSeconds, listedAt: this.nowSeconds - 10_000n, buyable: true, archived: false, supply: 0n, ...partial,
    };
    this.series.set(id, series);
    this.order.push(id);
    return series;
  }

  isLive(s: FakeSeries): boolean {
    return s.live ?? s.supply > 0n;
  }

  private call(target: Address, functionName: string, args: readonly unknown[] = [], pinned = false): unknown {
    if (functionName === "seriesCount") {
      if (!this.staleLatest || pinned) return BigInt(this.order.length);
      this.cachedCount ??= BigInt(this.order.length);
      return this.cachedCount;
    }
    if (functionName === "seriesIdAt") return this.order[Number(args[0])];
    if (functionName === "seriesOf") {
      const s = this.series.get(args[0] as Hex);
      if (!s) throw new Error("unknown series");
      return { ...s };
    }
    if (functionName === "allowedStock") return true;
    if (functionName === "liveSeries") {
      return this.order.filter((id) => { const s = this.series.get(id)!; return s.stock.toLowerCase() === String(args[0]).toLowerCase() && this.isLive(s); });
    }
    if (functionName === "seriesRisk") {
      const s = this.series.get(args[0] as Hex);
      return [s?.riskValue ?? 10n * WAD, 0n, 0n, 0n, 0n, 0n, 0n, 0n];
    }
    if (functionName === "guards") return [BigInt(this.guards.minTradeUsdg), this.guards.holdSeconds, this.guards.haltSettleDelay];
    if (functionName === "lastGoodPrice") {
      const g = this.lastGood.get(args[0] as Address);
      return [g?.s ?? 0n, g?.at ?? 0n];
    }
    if (functionName === "kindAt") return this.kind;
    if (functionName === "haltedSince") return this.haltedSince.get(args[0] as Address) ?? 0n;
    if (functionName === "settlePrice") return this.settlePrices.get(args[0] as Address) ?? 0n;
    if (functionName === "read" || functionName === "readLite") {
      const price = this.prices.get(args[0] as Address);
      if (!price) throw new Error("unknown stock");
      return price;
    }
    if (functionName === "balanceOf") return this.erc20Balances.get(`${target}:${String(args[0])}`) ?? 0n;
    if (functionName === "totalSupply") {
      const s = [...this.series.values()].find((x) => x.token === target);
      return s ? s.supply : 0n;
    }
    throw new Error(`FakeChain: unhandled ${functionName}`);
  }

  clients() {
    return {
      stateClient: {
        readContract: async (p: { address: Address; functionName: string; args?: readonly unknown[]; blockNumber?: bigint }) => this.call(p.address, p.functionName, p.args, p.blockNumber !== undefined),
        multicall: async (p: { contracts: { address: Address; functionName: string; args?: readonly unknown[] }[]; allowFailure?: boolean }) => {
          this.multicalls++;
          return p.contracts.map((c) => {
            try {
              const result = this.call(c.address, c.functionName, c.args);
              return p.allowFailure ? { status: "success", result } : result;
            } catch (error) {
              if (!p.allowFailure) throw error;
              return { status: "failure", error };
            }
          });
        },
      },
      walletClient: undefined,
    };
  }

  tx() {
    return {
      submit: async (t: { label: string; to: Address; data: Hex }) => {
        let decoded: { functionName: string; args: readonly unknown[] } | undefined;
        for (const abi of ABIS) {
          try { decoded = decodeFunctionData({ abi: abi as never, data: t.data }) as never; break; } catch { /* next */ }
        }
        if (!decoded) throw new Error("FakeChain: undecodable calldata");
        const name = decoded.functionName;
        const args = decoded.args ?? [];
        const key = `${name}:${String(args[0])}`;
        if (this.failing.has(name) || this.failing.has(key)) throw new Error(`execution reverted: ${name}`);
        // accrueMany fails as a whole when any id in it is poisoned.
        if (name === "accrueMany" && (args[0] as Hex[]).some((id) => this.failing.has(`accrue:${id}`))) throw new Error("execution reverted: accrue");
        this.sent.push({ label: t.label, to: t.to, data: t.data, name, args });
        if (this.dryRun) return { simulated: true };
        if (name === "listSeries") {
          const [stock, isCall, strike, tau] = args as [Address, boolean, bigint, number];
          // SeriesRegistry.listSeries: the current epoch must be archived or nearly worthless (norm < 1e15) to list again.
          const count = this.epochs.get(`${stock.toLowerCase()}:${isCall}:${strike}:${tau}`) ?? 0;
          if (count > 0) {
            const previous = this.series.get(seriesId(stock, isCall, strike, tau, count - 1))!;
            if (!previous.archived && previous.norm >= 10n ** 15n) throw new Error(`execution reverted: SeriesExists(${previous.id})`);
            previous.archived = true;
            previous.buyable = false;
          }
          this.addSeries({ stock, isCall, strike, tauSeconds: tau, listedAt: this.nowSeconds, buyable: this.listDefaultBuyable });
        } else if (name === "setBuyable") this.series.get(args[0] as Hex)!.buyable = args[1] as boolean;
        else if (name === "archive") { const s = this.series.get(args[0] as Hex)!; s.archived = true; s.buyable = false; }
        else if (name === "accrueMany") {
          // EngineOpsLib.accrueMany skips a series that is not on the live list: lastAccrual does not move for it.
          for (const id of args[0] as Hex[]) { const s = this.series.get(id)!; if (this.isLive(s)) s.lastAccrual = this.nowSeconds; }
        }
        else if (name === "accrue") this.series.get(args[0] as Hex)!.lastAccrual = this.nowSeconds;
        else if (name === "settleHalted") {
          const stock = args[0] as Address;
          const since = this.haltedSince.get(stock) ?? 0n;
          const price = this.prices.get(stock);
          if (since === 0n || this.nowSeconds < since + BigInt(this.guards.haltSettleDelay) || price?.session !== 4) {
            this.sent.pop();
            throw new Error(`execution reverted: NotSettleable(${stock})`);
          }
          this.settlePrices.set(stock, this.lastGood.get(stock)?.s ?? price.s);
        }
        else if (name === "retireDust") {
          for (const id of args[0] as Hex[]) {
            const s = this.series.get(id);
            if (!s || !this.isLive(s)) continue;
            s.lastAccrual = this.nowSeconds;
            if (this.refreshedRisk.has(id)) s.riskValue = this.refreshedRisk.get(id)!;
            if ((s.riskValue ?? 10n * WAD) < this.guards.minTradeUsdg * 10n ** 12n) s.live = false;
          }
        }
        else if (name === "poke") {
          const price = this.prices.get(args[0] as Address);
          if (price && price.fresh && price.session <= 1) this.lastGood.set(args[0] as Address, { s: price.s, at: price.updatedAt });
          // PriceGuard.poke: a HALTED reading in a REGULAR or EXTENDED session latches haltedSince once; a live one clears it.
          else if (price && price.session === 4 && this.kind <= 1 && (this.haltedSince.get(args[0] as Address) ?? 0n) === 0n) this.haltedSince.set(args[0] as Address, this.nowSeconds);
          if (price && price.fresh && price.session <= 1) this.haltedSince.delete(args[0] as Address);
        }
        return { simulated: false, hash: keccak256(t.data), receipt: { status: "success", blockNumber: BigInt(this.sent.length) } };
      },
    };
  }

  /** A KeeperContext over this chain. `sql` is a stub unless given. */
  context(extra: Record<string, unknown> = {}, config: Record<string, unknown> = {}): KeeperContext {
    return {
      sql: Object.assign(async () => [], { begin: async () => undefined }),
      clients: this.clients(),
      deployment: {
        chainId: 4663, network: "fork", deployBlock: 1,
        contracts: { engine: A.engine, registry: A.registry, priceGuard: A.priceGuard, marketHours: A.marketHours, pool: A.engine, volOracle: A.engine, usdg: A.engine },
        stocks: [{ name: "NVDA", stock: A.nvda }, { name: "SPY", stock: A.spy }],
        poolShareDecimals: 12,
      },
      config: { KEEPER_ACCRUE_MAX_AGE_SECONDS: 3600, KEEPER_ACCRUE_BATCH: 40, KEEPER_LISTER_MAX_TX: 200, KEEPER_RISK_COOLDOWN_SECONDS: 3600, ...config },
      logger: createLogger("silent"),
      tx: this.tx(),
      metadata: async () => ({}),
      now: () => new Date(Number(this.nowSeconds) * 1000),
      ...extra,
    } as unknown as KeeperContext;
  }
}
