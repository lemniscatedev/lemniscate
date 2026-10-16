import { createClients } from "../chain/clients";
import { assertDeploymentNetwork, loadDeployment } from "../chain/deployment";
import { confirmationBlocks, loadConfig, stripKeeperSecrets } from "../config";
import { createDbClient } from "../db/client";
import { createLogger, safeErrorSummary } from "../log";
import { reconcileListedMarkets } from "../indexer/reconcile";

stripKeeperSecrets();
const config = loadConfig();
const logger = createLogger(config.LOG_LEVEL, "reconcile-markets");
const { sql } = createDbClient(config);
try {
  const deployment = await loadDeployment(config.DEPLOYMENT_FILE);
  assertDeploymentNetwork(deployment, config);
  await reconcileListedMarkets(sql, createClients(config), deployment, logger, confirmationBlocks(config));
} catch (error) {
  logger.error({ err: safeErrorSummary(error) }, "Market reconciliation failed; application activation must stop");
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 5 });
}
