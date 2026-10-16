import { writeFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { keccak256, parseAbi, stringToHex } from "viem";
import { createClients } from "../chain/clients";
import { assertDeploymentNetwork, loadDeployment, type Deployment } from "../chain/deployment";
import { loadConfig, loadKeeperSigningKey, safeConfigSummary } from "../config";
import { createRpcPool } from "../chain/rpc-pool";
import { createDbClient } from "../db/client";
import { createLogger, safeErrorSummary } from "../log";
import { MarketHoursAbi } from "../abi/MarketHours";
import { chainClock, readIndexerMetadata, saveJobMeta, type KeeperContext } from "./context";
import { createScheduler } from "./scheduler";
import { createTransactionQueue } from "./tx";
import { acquireKeeperLock } from "./lock";
import { updateSessions, sessionHash } from "./jobs/sessions";
import { accrueStale } from "./jobs/accrue";
import { createHedgeJob } from "./jobs/hedge";
import { updateCarry } from "./jobs/carry";
import { createRiskJob } from "./jobs/risk";
import { updateCorporateActions } from "./jobs/corp-actions";
import { updateReferencePrices } from "./jobs/reference";
import { updateEarnings } from "./jobs/earnings";

const config = loadConfig();
const logger = createLogger(config.LOG_LEVEL, "keeper");
const clients = createClients(config, createRpcPool(config), loadKeeperSigningKey());
const { sql } = createDbClient(config);
const abort = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => abort.abort());
const scheduler = createScheduler(sql, logger);
const tx = createTransactionQueue(clients, {
  dryRun: config.KEEPER_DRY_RUN, logger,
  onHash: async (transaction, hash) => {
    const job = transaction.label.split(":")[0]!;
    await sql`insert into keeper_status (job,last_tx) values (${job},${hash})
      on conflict (job) do update set last_tx=excluded.last_tx`;
  },
});
logger.info({ config: safeConfigSummary(config), signer: clients.walletClient?.account?.address, dryRun: config.KEEPER_DRY_RUN }, "Keeper starting");
const enabled = new Set(config.KEEPER_ENABLED_JOBS.split(",").map((job) => job.trim()).filter(Boolean));
const validJobs = new Set(["sessions", "accrue", "hedge", "carry", "risk", "corp-actions", "reference", "earnings"]);
for (const job of enabled) if (!validJobs.has(job)) throw new Error(`Unknown keeper job: ${job}`);

async function startup(): Promise<Deployment> {
  const deployment = await loadDeployment(config.DEPLOYMENT_FILE);
  assertDeploymentNetwork(deployment, config);
  if (await clients.txClient.getChainId() !== config.CHAIN_ID) throw new Error("Keeper RPC chain ID mismatch");
  if (config.NETWORK === "fork") {
    if (!config.RPC_URL_OVERRIDE) throw new Error("Fork keeper requires an explicit local RPC override");
    const version = await clients.pool.request("state", { method: "web3_clientVersion" });
    if (typeof version !== "string" || !/anvil/i.test(version)) throw new Error("Fork keeper RPC is not Anvil");
    if (!deployment.forkProof) throw new Error("Fork deployment is missing its identity proof");
    const block = await clients.stateClient.getBlock({ blockNumber: BigInt(deployment.forkProof.blockNumber) });
    if (block.hash?.toLowerCase() !== deployment.forkProof.blockHash.toLowerCase()) throw new Error("Fork proof does not match the node");
  }
  if ([...enabled].some((job) => job !== "corp-actions" && job !== "reference" && job !== "earnings")) {
    const account = clients.walletClient?.account;
    if (!account || account.address.toLowerCase() !== deployment.keeper) throw new Error("Signer does not match deployment keeper");
    const abi = parseAbi(["function hasRole(bytes32 role,address account) view returns(bool)"]);
    const keeper = keccak256(stringToHex("KEEPER_ROLE"));
    const guardian = keccak256(stringToHex("GUARDIAN_ROLE"));
    const roles = await clients.stateClient.multicall({ allowFailure: false, contracts: [
      { address: deployment.contracts.engine, abi, functionName: "hasRole", args: [keeper, account.address] },
      { address: deployment.contracts.vault, abi, functionName: "hasRole", args: [keeper, account.address] },
      { address: deployment.contracts.marketHours, abi, functionName: "hasRole", args: [keeper, account.address] },
      { address: deployment.contracts.engine, abi, functionName: "hasRole", args: [guardian, account.address] },
    ] });
    if (roles.some((role) => !role)) throw new Error("Keeper lacks a required keeper/guardian role");
  }
  const sessions = await clients.stateClient.readContract({ address: deployment.contracts.marketHours, abi: MarketHoursAbi, functionName: "sessions" });
  const meta = { sessions: sessions.map((s) => ({ open: s.open.toString(), close: s.close.toString() })),
    sessionsHash: sessionHash([...sessions]), horizon: sessions.at(-1)?.close.toString() ?? "0" };
  await sql`insert into keeper_status (job,meta) values ('sessions',${JSON.stringify(meta)}::jsonb)
    on conflict (job) do update set meta=keeper_status.meta || excluded.meta`;
  return deployment;
}

// Only one keeper instance may sign: a standby instance waits here until the
// active one exits and releases the lock.
const lock = await acquireKeeperLock(config.DATABASE_URL, logger, abort.signal);

let context: KeeperContext | undefined;
let priorStartupError = "";
while (!abort.signal.aborted && lock && !context) {
  try {
    const deployment = await startup();
    context = { sql, clients, deployment, config, logger, tx,
      metadata: () => readIndexerMetadata(sql), now: (meta) => chainClock(config, meta) };
  } catch (error) {
    const summary = safeErrorSummary(error);
    if (summary.message !== priorStartupError) logger.warn({ err: summary }, "Keeper waiting for deployment and signer");
    priorStartupError = summary.message;
    try {
      await sql`insert into keeper_status (job,last_run,last_error,meta)
        values ('keeper',now(),${summary.message},'{"ready":false}'::jsonb)
        on conflict (job) do update set last_run=now(),last_error=excluded.last_error,meta=keeper_status.meta || excluded.meta`;
      await writeFile("/tmp/heartbeat", new Date().toISOString());
    } catch (statusError) { logger.warn({ err: safeErrorSummary(statusError) }, "Keeper startup status unavailable"); }
    await sleep(15000, undefined, { signal: abort.signal }).catch(() => undefined);
  }
}

const HELD_NONCE_STUCK_MS = 10 * 60_000;
const boundaryTimers: ReturnType<typeof setTimeout>[] = [];
const firedBoundaries = new Set<string>();
let forceAccrue = false;
let unlisten: (() => Promise<void>) | undefined;
let heartbeat: ReturnType<typeof setInterval> | undefined;
let pulseBusy = false;
if (context && lock && !abort.signal.aborted) {
  const ctx = context;
  const definitions = [
    { name: "sessions", everyMs: 3600000, run: () => updateSessions(ctx) },
    { name: "accrue", everyMs: 60000, run: async () => {
      const force = forceAccrue;
      forceAccrue = false;
      try { return await accrueStale(ctx, force); }
      catch (error) {
        // Preserve a failed boundary request across the scheduler's retry. A
        // recent regular accrual must not suppress it for another six hours.
        forceAccrue ||= force;
        throw error;
      }
    } },
    { name: "hedge", everyMs: 900000, run: createHedgeJob(ctx) },
    { name: "carry", everyMs: 60000, run: () => updateCarry(ctx) },
    { name: "risk", everyMs: 60000, run: createRiskJob(ctx) },
    { name: "corp-actions", everyMs: 3600000, run: () => updateCorporateActions(ctx) },
    { name: "reference", everyMs: 60000, run: () => updateReferencePrices(ctx) },
    { name: "earnings", everyMs: 3600000, run: () => updateEarnings(ctx) },
  ];
  for (const job of definitions) if (enabled.has(job.name)) scheduler.add({ ...job, jitterMs: 2000 });
  const listener = await sql.listen("lemniscate_events", (payload) => {
    try {
      const event = JSON.parse(payload) as { kinds?: string[] };
      if (event.kinds?.some((kind) => ["trade", "oracle", "snapshot"].includes(kind))) void scheduler.trigger("hedge");
      if (event.kinds?.includes("config")) void scheduler.trigger("sessions");
    } catch { logger.warn("Ignored malformed lemniscate_events notification"); }
  });
  unlisten = listener.unlisten;
  const pulse = async () => {
    if (pulseBusy || abort.signal.aborted) return;
    pulseBusy = true;
    try {
      if (await lock.check() === "lost") {
        logger.fatal("Keeper lost its single-instance lock to another instance; stopping");
        process.exitCode = 1;
        abort.abort();
        return;
      }
      const txStatus = tx.status();
      const held = txStatus.heldNonce !== null;
      const heldMs = txStatus.heldSince ? Date.now() - Date.parse(txStatus.heldSince) : 0;
      // A nonce held past the stuck threshold stops the container heartbeat so
      // the orchestrator flags (and may restart) the keeper; a restart is safe
      // because a fresh queue refuses new nonces while one is pending on chain.
      if (heldMs < HELD_NONCE_STUCK_MS) await writeFile("/tmp/heartbeat", new Date().toISOString());
      const meta = { ready: !held, dryRun: config.KEEPER_DRY_RUN, rpc: clients.pool.stats(),
        signer: clients.walletClient?.account?.address, tx: txStatus };
      if (held) {
        const message = `Keeper nonce ${txStatus.heldNonce} is held awaiting resolution`;
        await sql`insert into keeper_status (job,last_run,last_error,meta) values ('keeper',now(),${message},${JSON.stringify(meta)}::jsonb)
          on conflict (job) do update set last_run=now(),last_error=excluded.last_error,meta=keeper_status.meta || excluded.meta`;
      } else {
        await sql`insert into keeper_status (job,last_run,last_ok,meta) values ('keeper',now(),now(),${JSON.stringify(meta)}::jsonb)
          on conflict (job) do update set last_run=now(),last_ok=now(),last_error=null,meta=keeper_status.meta || excluded.meta`;
      }
      if (!enabled.has("accrue")) return;
      const now = ctx.now(await ctx.metadata()).getTime();
      const rows = await sql<{ meta: { sessions?: { open: string; close: string }[] } }[]>`select meta from keeper_status where job='sessions'`;
      for (const timer of boundaryTimers.splice(0)) clearTimeout(timer);
      for (const session of rows[0]?.meta.sessions ?? []) for (const boundary of [session.open, session.close]) {
        for (const offset of [-30, 30]) {
          const key = `${boundary}:${offset}`;
          const delay = (Number(boundary) + offset) * 1000 - now;
          if (delay < -90000 || delay > 2147483647 || firedBoundaries.has(key)) continue;
          const dueWallTime = Date.now() + delay;
          boundaryTimers.push(setTimeout(() => {
            firedBoundaries.add(key); forceAccrue = true;
            const lateSeconds = (Date.now() - dueWallTime) / 1000;
            if (lateSeconds > 5) {
              logger.warn({ key, lateSeconds }, "Keeper boundary accrual is late");
              void saveJobMeta(ctx, "accrue", {
                lateBoundary: key, lateSeconds, lateBoundaryObservedAt: new Date().toISOString(),
              }).catch(() => undefined);
            }
            void scheduler.trigger("accrue");
          }, Math.max(0, delay)));
        }
      }
      for (const key of firedBoundaries) if (Number(key.split(":")[0]) * 1000 < now - 86400000) firedBoundaries.delete(key);
    } catch (error) { logger.warn({ err: safeErrorSummary(error) }, "Keeper status/boundary refresh failed"); }
    finally { pulseBusy = false; }
  };
  heartbeat = setInterval(() => { void pulse(); }, 30000);
  await pulse();
  logger.info({ jobs: [...enabled] }, "Keeper ready");
  if (!abort.signal.aborted) await new Promise<void>((resolve) => abort.signal.addEventListener("abort", () => resolve(), { once: true }));
}
if (heartbeat) clearInterval(heartbeat);
for (const timer of boundaryTimers) clearTimeout(timer);
await unlisten?.();
await scheduler.stop();
await tx.drain();
await sql.end({ timeout: 5 });
await lock?.release();
logger.info("Keeper stopped");
