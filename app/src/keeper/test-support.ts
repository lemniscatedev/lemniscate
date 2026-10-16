import { decodeFunctionData, type Address, type Hex } from "viem";
import { OptionEngineAbi, PriceGuardAbi, SeriesRegistryAbi } from "../abi";
import { createLogger } from "../log";
import { seriesId } from "../config/listing";
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
  sent: SentTx[] = [];
  dryRun = false;
  /** Make a named call (or `${name}:${id}`) revert. */
  failing = new Set<string>();
  listDefaultBuyable = true;
  multicalls = 0;

  addSeries(partial: Partial<FakeSeries> & { stock: Address; isCall: boolean; strike: bigint; tauSeconds: number }): FakeSeries {
    const id = seriesId(partial.stock, partial.isCall, partial.strike, partial.tauSeconds);
    const series: FakeSeries = {
      id, speed: partial.tauSeconds === 86_400 ? 0 : 1, token: `0x${(this.order.length + 1).toString(16).padStart(40, "c")}` as Address,
      norm: WAD, lastAccrual: this.nowSeconds, listedAt: this.nowSeconds - 10_000n, buyable: true, archived: false, supply: 0n, ...partial,
    };
    this.series.set(id, series);
    this.order.push(id);
    return series;
  }

  private call(target: Address, functionName: string, args: readonly unknown[] = []): unknown {
    if (functionName === "seriesCount") return BigInt(this.order.length);
    if (functionName === "seriesIdAt") return this.order[Number(args[0])];
    if (functionName === "seriesOf") {
      const s = this.series.get(args[0] as Hex);
      if (!s) throw new Error("unknown series");
      return { ...s };
    }
    if (functionName === "allowedStock") return true;
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
        readContract: async (p: { address: Address; functionName: string; args?: readonly unknown[] }) => this.call(p.address, p.functionName, p.args),
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
          this.addSeries({ stock, isCall, strike, tauSeconds: tau, listedAt: this.nowSeconds, buyable: this.listDefaultBuyable });
        } else if (name === "setBuyable") this.series.get(args[0] as Hex)!.buyable = args[1] as boolean;
        else if (name === "archive") { const s = this.series.get(args[0] as Hex)!; s.archived = true; s.buyable = false; }
        else if (name === "accrueMany") for (const id of args[0] as Hex[]) this.series.get(id)!.lastAccrual = this.nowSeconds;
        return { simulated: false };
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
