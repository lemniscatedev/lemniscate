import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { optionalEnv } from "../config";

export interface EphemeralPostgres {
  readonly url: string;
  readonly stop: () => void;
}

// macOS refuses to start a multithreaded postmaster without a valid locale.
const PG_ENV = { ...process.env, LC_ALL: "C", LANG: "C" };

function candidateBinDirs(): string[] {
  const dirs: string[] = [];
  const pgBin = optionalEnv("PG_BIN");
  if (pgBin) dirs.push(pgBin);
  for (const entry of (optionalEnv("PATH") ?? "").split(":")) if (entry) dirs.push(entry);
  for (const version of ["16", "17", "18", "15"]) {
    dirs.push(`/opt/homebrew/opt/postgresql@${version}/bin`, `/usr/local/opt/postgresql@${version}/bin`, `/usr/lib/postgresql/${version}/bin`);
  }
  try {
    for (const entry of readdirSync("/usr/lib/postgresql")) dirs.push(`/usr/lib/postgresql/${entry}/bin`);
  } catch {
    // not a Debian-style install
  }
  return dirs;
}

export function findPostgresBin(): string | undefined {
  return candidateBinDirs().find((dir) => existsSync(join(dir, "initdb")) && existsSync(join(dir, "pg_ctl")));
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

/** Starts a throwaway Postgres cluster in a temp dir (trust auth, fsync off, loopback only). Returns undefined when
 * no Postgres binaries are installed. Always call `stop()`; the preload also stops it on process exit. */
export async function startEphemeralPostgres(): Promise<EphemeralPostgres | undefined> {
  const bin = findPostgresBin();
  if (!bin) return undefined;
  const dir = mkdtempSync(join(tmpdir(), "lmns-pg-"));
  const data = join(dir, "data");
  const port = await freePort();
  const init = spawnSync(join(bin, "initdb"), ["-D", data, "-U", "postgres", "--auth=trust", "-E", "UTF8", "--locale=C"], { encoding: "utf8", env: PG_ENV });
  if (init.status !== 0) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error(`initdb failed: ${init.stderr}`);
  }
  const start = spawnSync(
    join(bin, "pg_ctl"),
    ["-D", data, "-w", "-l", join(dir, "log"), "-o", `-p ${port} -c unix_socket_directories= -c listen_addresses=127.0.0.1 -c fsync=off -c synchronous_commit=off -c full_page_writes=off`, "start"],
    { encoding: "utf8", env: PG_ENV },
  );
  if (start.status !== 0) {
    rmSync(dir, { recursive: true, force: true });
    throw new Error(`pg_ctl start failed: ${start.stderr}`);
  }
  let stopped = false;
  return {
    url: `postgres://postgres@127.0.0.1:${port}/postgres`,
    stop: () => {
      if (stopped) return;
      stopped = true;
      spawnSync(join(bin, "pg_ctl"), ["-D", data, "-m", "immediate", "stop"], { encoding: "utf8", env: PG_ENV });
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
