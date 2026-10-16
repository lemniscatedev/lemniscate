import { setTimeout as sleep } from "node:timers/promises";
import { createClients } from "../chain/clients";
import { assertDeploymentNetwork, loadDeployment } from "../chain/deployment";
import { loadConfig, safeConfigSummary, stripKeeperSecrets } from "../config";
import { createDbClient } from "../db/client";
import { createLogger, safeErrorSummary } from "../log";
import {
  createIndexerState,
  persistMissingDeploymentStatus,
  recordIndexerFailure,
  runIndexerTick,
  type IndexerState,
} from "../indexer/ingest";

// Never keep the keeper signing key in a non-keeper process, even if it shares an env file.
stripKeeperSecrets();
const config = loadConfig();
const logger = createLogger(config.LOG_LEVEL, "indexer");
const clients = createClients(config);
const { sql } = createDbClient(config);
const abort = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => abort.abort());
}

logger.info(
  {
    config: safeConfigSummary(config),
    rpcEndpoints: clients.pool.stats().endpoints.map(({ id, kind }) => ({ id, kind })),
  },
  "Indexer starting",
);

try {
  while (!abort.signal.aborted) {
    let state: IndexerState;
    try {
      const deployment = await loadDeployment(config.DEPLOYMENT_FILE);
      assertDeploymentNetwork(deployment, config);
      const chainId = await clients.logsClient.getChainId();
      if (chainId !== config.CHAIN_ID) {
        throw new Error(`Indexer RPC chain ID ${chainId} does not match configured ${config.CHAIN_ID}`);
      }
      state = await createIndexerState({ config, clients, sql, logger, deployment });
    } catch (error) {
      const summary = safeErrorSummary(error);
      logger.warn({ err: summary }, "Indexer waiting for a valid deployment and database");
      await persistMissingDeploymentStatus(sql, error).catch((statusError) => {
        logger.warn({ err: safeErrorSummary(statusError) }, "Could not persist missing deployment status");
      });
      await sleep(60_000, undefined, { signal: abort.signal }).catch(() => undefined);
      continue;
    }

    logger.info(
      {
        network: state.deployment.network,
        deployBlock: state.deployment.deployBlock,
        markets: state.deployment.markets.length,
      },
      "Indexer connected to deployment",
    );

    while (!abort.signal.aborted) {
      let delayMs = config.INDEXER_POLL_BASE_MS;
      try {
        const result = await runIndexerTick(state);
        state.failureBackoffMs = 5_000;
        delayMs = result.delayMs ?? config.INDEXER_POLL_BASE_MS;
      } catch (error) {
        delayMs = await recordIndexerFailure(state, error);
      }
      await sleep(delayMs, undefined, { signal: abort.signal }).catch(() => undefined);
    }
    break;
  }
} finally {
  await sql.end({ timeout: 5 }).catch((error) => {
    logger.warn({ err: safeErrorSummary(error) }, "Indexer database connection did not close cleanly");
  });
  logger.info("Indexer stopped");
}
