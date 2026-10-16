import type { Logger } from "pino";
import type { Address } from "viem";
import type { ServiceClients } from "../chain/clients";
import type { OptionDeployment } from "../chain/deployment";
import type { RuntimeConfig } from "../config";
import type { LemniscateDbClient } from "../db/client";
import type { createTransactionQueue } from "./tx";

/** What the indexer writes into keeper_status.meta for job 'indexer' (see indexer/ingest.ts buildStatusMeta), plus the
 * two fields readIndexerMetadata adds from the row itself. The keeper reads state from the chain and the series /
 * ticks / limits / pool tables; this is only the freshness signal. */
export interface IndexerMetadata {
  chainTimestamp?: string;
  chainTimeObservedAt?: string;
  lagBlocks?: number | string;
  pendingSnapshot?: boolean;
  lastSnapshotAt?: string | null;
  lastHeadBlock?: string;
  lastIndexedBlock?: string;
  indexerLastOk?: string;
  indexerLastError?: string | null;
}

export interface KeeperContext {
  sql: LemniscateDbClient["sql"];
  clients: ServiceClients;
  /** The option-system deployment. */
  deployment: OptionDeployment;
  config: RuntimeConfig;
  logger: Logger;
  tx: ReturnType<typeof createTransactionQueue>;
  metadata(): Promise<IndexerMetadata>;
  now(meta: IndexerMetadata): Date;
}

export async function readIndexerMetadata(sql: LemniscateDbClient["sql"]): Promise<IndexerMetadata> {
  const rows = await sql<{ meta: IndexerMetadata; last_ok: Date | string | null; last_error: string | null }[]>`
    select meta, last_ok, last_error from keeper_status where job = 'indexer'`;
  const row = rows[0];
  if (!row) return {};
  return { ...row.meta,
    indexerLastOk: row.last_ok instanceof Date ? row.last_ok.toISOString() : row.last_ok ?? "",
    indexerLastError: row.last_error,
  };
}

export function chainClock(config: RuntimeConfig, meta: IndexerMetadata): Date {
  if (config.NETWORK !== "fork") return new Date();
  const chain = Number(meta.chainTimestamp);
  const observed = Date.parse(meta.chainTimeObservedAt ?? "");
  if (!Number.isFinite(chain) || !Number.isFinite(observed)) {
    throw new Error("Waiting for indexer chain-time snapshot before running fork keeper jobs");
  }
  return new Date(chain * 1000 + Math.max(0, Date.now() - observed));
}

export async function saveJobMeta(context: KeeperContext, job: string, meta: Record<string, unknown>): Promise<void> {
  await context.sql`insert into keeper_status (job, meta) values (${job}, ${JSON.stringify(meta)}::jsonb)
    on conflict (job) do update set meta = keeper_status.meta || excluded.meta`;
}
