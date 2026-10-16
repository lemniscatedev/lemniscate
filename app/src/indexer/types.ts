import type { TransactionSql } from "postgres";
import type { Logger } from "pino";
import type { Address, Hex } from "viem";
import type { Deployment } from "../chain/deployment";
import type { RuntimeConfig } from "../config";
import type { ServiceClients } from "../chain/clients";
import type { Sql } from "postgres";

export interface RpcLog {
  readonly address: Address;
  readonly blockNumber: Hex | bigint | null;
  readonly transactionHash: Hex | null;
  readonly logIndex: Hex | number | null;
  readonly data: Hex;
  readonly topics: readonly Hex[];
  readonly blockTimestamp?: Hex | bigint | number | null;
}

export interface ChainEvent {
  readonly log: RpcLog;
  readonly address: string;
  readonly blockNumber: bigint;
  readonly txHash: string;
  readonly logIndex: number;
  readonly ts: Date;
  readonly eventName: string;
  readonly args: Record<string, unknown>;
  readonly source: "engine" | "vault" | "token" | "hours" | "external";
  readonly marketId?: number;
}

export interface MarketInfo {
  readonly id: number;
  readonly symbol: string;
  readonly token: Address;
  readonly stock: Address;
  readonly feed: Address;
  readonly scale: bigint;
  readonly poolFee: number;
  readonly listedBlock: bigint;
  readonly config: Record<string, unknown>;
  readonly state?: Record<string, unknown>;
}

export interface IndexerContext {
  readonly tx: TransactionSql;
  readonly deployment: Deployment;
  readonly logger: Logger;
  readonly tokenToMarket: Map<string, number>;
  readonly marketById: Map<number, MarketInfo>;
  readonly stockToMarket: Map<string, number>;
  readonly touchedAccounts: Set<string>;
  readonly insertedTradeTxs: Set<string>;
  readonly insertedVaultActionTxs: Set<string>;
  readonly marketIds: Set<number>;
  readonly kinds: Set<string>;
  readonly metaPatch: Record<string, unknown>;
  readonly globalConfig: Record<string, unknown>;
  readonly vaultConfig: Record<string, unknown>;
  readonly marketHours: Record<string, unknown>;
  readonly marketStatesById: Map<number, Record<string, unknown>>;
  snapshotNeeded: boolean;
  registryNeeded: boolean;
  hasLemniscateEvents: boolean;
}

export interface IndexerRuntime {
  readonly config: RuntimeConfig;
  readonly clients: ServiceClients;
  readonly sql: Sql;
  readonly logger: Logger;
  readonly deployment: Deployment;
}
