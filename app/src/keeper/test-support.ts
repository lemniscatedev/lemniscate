import { decodeFunctionData, encodeAbiParameters, keccak256, type Address, type Hex } from "viem";
import { OptionEngineAbi, PriceGuardAbi, SeriesRegistryAbi } from "../abi";
import { createLogger } from "../log";

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
}
export interface FakePrice { s: bigint; session: number; fresh: boolean; buysPaused: boolean; updatedAt: bigint }
export interface SentTx { label: string; to: Address; data: Hex; name: string; args: readonly unknown[] }

const ABIS = [SeriesRegistryAbi, OptionEngineAbi, PriceGuardAbi];

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
    if (functionName === "lastGoodPrice") {
      const g = this.lastGood.get(args[0] as Address);
      return [g?.s ?? 0n, g?.at ?? 0n];
    }
    if (functionName === "read") {
      const price = this.prices.get(args[0] as Address);
      if (!price) throw new Error("unknown stock");
      return price;
    }
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
        else if (name === "accrueMany") for (const id of args[0] as Hex[]) this.series.get(id)!.lastAccrual = this.nowSeconds;
        else if (name === "poke") {
          const price = this.prices.get(args[0] as Address);
          if (price && price.fresh && price.session <= 1) this.lastGood.set(args[0] as Address, { s: price.s, at: price.updatedAt });
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
