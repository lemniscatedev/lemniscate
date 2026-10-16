import { createApiApp } from "../api/app";
import { loadConfig, safeConfigSummary, stripKeeperSecrets } from "../config";
import { assertDeploymentNetwork, loadOptionDeployment } from "../chain/deployment";
import { createDbClient } from "../db/client";
import { TtlCache } from "../api/cache";
import { createLogger, safeErrorSummary } from "../log";
import { createX402FromEnv } from "../x402";

// Never keep the keeper signing key in a non-keeper process, even if it shares an env file.
stripKeeperSecrets();
const config = loadConfig();
const logger = createLogger(config.LOG_LEVEL, "api");
const deployment = await loadOptionDeployment(config.DEPLOYMENT_FILE);
assertDeploymentNetwork(deployment, config);
// Signed API actions write subscriptions and replay nonces through the shared DB client.
const { sql } = createDbClient(config);
// Pay-per-call data (todo 17). Off unless X402_ENABLED=1; the settler key is read here and nowhere else.
const x402 = createX402FromEnv(deployment, config.RPC_URL_OVERRIDE.trim() || config.PUBLIC_RPC_URL);
const app = createApiApp({ sql, config, deployment, logger, cache: new TtlCache(), ...(x402 ? { x402 } : {}) });

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
