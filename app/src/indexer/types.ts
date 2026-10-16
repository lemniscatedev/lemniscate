import type { TransactionSql } from "postgres";
import type { Logger } from "pino";
import type { Address, Hex } from "viem";
import type { OptionDeployment } from "../chain/deployment";

export interface RpcLog {
  readonly address: Address;
  readonly blockNumber: Hex | bigint | null;
  readonly transactionHash: Hex | null;
  readonly logIndex: Hex | number | null;
  readonly data: Hex;
  readonly topics: readonly Hex[];
  readonly blockTimestamp?: Hex | bigint | number | null;
}

export interface BlockHeader {
  readonly number: bigint;
  readonly hash: string;
  readonly parentHash: string;
  readonly timestamp: Date;
}

export type EventSource = "engine" | "pool" | "registry" | "volOracle" | "priceGuard" | "agentRouter" | "token" | "stock";

export interface ChainEvent {
  readonly address: string;
  readonly blockNumber: bigint;
  readonly txHash: string;
  readonly logIndex: number;
  readonly ts: Date;
  readonly eventName: string;
  readonly args: Record<string, unknown>;
  readonly source: EventSource;
}

export interface SeriesInfo {
  readonly id: string;
  readonly token: string;
  readonly stock: string;
}

export interface IndexerContext {
  readonly tx: TransactionSql;
  readonly deployment: OptionDeployment;
  readonly logger: Logger;
  /** option token address -> series */
  readonly seriesByToken: Map<string, SeriesInfo>;
  /** stock token address -> ticker */
  readonly stockNames: ReadonlyMap<string, string>;
  readonly stockFeeds: ReadonlyMap<string, string>;
  /** Reads the calldata of a transaction (to recover the signature of a vol post). May be unavailable. */
  readonly transactionInput: (hash: string) => Promise<Hex | undefined>;
  /** (token, account) pairs whose balance must be recomputed from the transfers table. */
  readonly touchedBalances: Map<string, { token: string; account: string }>;
  /** Series (re)listed in this batch: their tokens must be watched from now on. */
  readonly newSeries: SeriesInfo[];
  readonly kinds: Set<string>;
  /** A trade, accrual or pool change happened: pool_nav and limits must be re-snapshotted. */
  snapshotNeeded: boolean;
  /** Series structure changed: refresh their on-chain state at the next snapshot. */
  seriesRefreshNeeded: boolean;
}

export interface IndexerRuntimeLogger {
  readonly logger: Logger;
}
