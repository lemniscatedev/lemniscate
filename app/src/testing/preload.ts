import { afterAll } from "bun:test";
import { optionalEnv, setTestDatabaseEnv } from "../config";
import { startEphemeralPostgres } from "./pg";

// `bun test` preload: give the database tests a throwaway Postgres unless the caller supplied one.
if (!optionalEnv("TEST_DATABASE_URL")) {
  try {
    const pg = await startEphemeralPostgres();
    if (pg) {
      setTestDatabaseEnv(pg.url);
      // A preload hook runs once after every test file; the exit handler covers abnormal endings.
      afterAll(() => pg.stop());
      process.on("exit", () => pg.stop());
      for (const signal of ["SIGINT", "SIGTERM"] as const) {
        process.once(signal, () => {
          pg.stop();
          process.exit(130);
        });
      }
    }
  } catch (error) {
    console.warn(`[testing] could not start a throwaway Postgres: ${error instanceof Error ? error.message : String(error)}`);
  }
}
