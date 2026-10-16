import { createApiApp } from "../api/app";
import { loadConfig, safeConfigSummary, stripKeeperSecrets } from "../config";
import { assertDeploymentNetwork, loadDeployment } from "../chain/deployment";
import { createDbClient } from "../db/client";
import { TtlCache } from "../api/cache";
import { createLogger, safeErrorSummary } from "../log";

// Never keep the keeper signing key in a non-keeper process, even if it shares an env file.
stripKeeperSecrets();
const config = loadConfig();
const logger = createLogger(config.LOG_LEVEL, "api");
const deployment = await loadDeployment(config.DEPLOYMENT_FILE);
assertDeploymentNetwork(deployment, config);
// Signed API actions write subscriptions and replay nonces through the shared DB client.
const { sql } = createDbClient(config);
const app = createApiApp({ sql, config, deployment, logger, cache: new TtlCache() });

const server = Bun.serve({
  hostname: "0.0.0.0",
  port: config.API_PORT,
  fetch: app.fetch,
});

logger.info(
  { config: safeConfigSummary(config), port: config.API_PORT, network: deployment.network },
  "API listening",
);

const shutdown = async () => {
  server.stop(true);
  await sql.end({ timeout: 5 });
  logger.info("API stopped");
};
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());

process.once("uncaughtException", (error) => {
  logger.error({ err: safeErrorSummary(error) }, "Uncaught API exception");
  void shutdown().finally(() => { process.exitCode = 1; });
});
