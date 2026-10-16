import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createLogger, safeErrorSummary } from "../log";
import { loadConfig, safeConfigSummary, stripKeeperSecrets } from "../config";
import { createDbClient } from "../db/client";

stripKeeperSecrets();
const config = loadConfig();
const logger = createLogger(config.LOG_LEVEL, "migrate");
const { db, sql } = createDbClient(config);

try {
  logger.info({ config: safeConfigSummary(config) }, "Applying database migrations");
  await migrate(db, { migrationsFolder: "./drizzle" });
  logger.info("Database migrations complete");
} catch (error) {
  logger.error({ err: safeErrorSummary(error) }, "Database migration failed");
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 5 });
}
