import { writeFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { createClients } from "../chain/clients";
import { assertDeploymentNetwork, loadOptionDeployment } from "../chain/deployment";
import { loadConfig, loadKeeperSigningKey, safeConfigSummary } from "../config";
import { createRpcPool } from "../chain/rpc-pool";
import { createDbClient } from "../db/client";
import { createLogger, safeErrorSummary } from "../log";
import { MarketHoursAbi } from "../abi/MarketHours";
import { chainClock, readIndexerMetadata, saveJobMeta, type KeeperContext } from "./context";
import { createScheduler } from "./scheduler";
import { createTransactionQueue } from "./tx";
import { acquireKeeperLock } from "./lock";
import { updateSessions, sessionsMeta } from "./jobs/sessions";
import { createAccrueJob } from "./jobs/accrue";
import { createListerJob } from "./jobs/lister";
import { createHedgeJob } from "./jobs/hedge";
import { createRiskJob } from "./jobs/risk";
import { updateCorporateActions } from "./jobs/corp-actions";
import { createQueuedSellsJob } from "./jobs/queued-sells";
import { createSettleHaltedJob } from "./jobs/settle-halted";
import { createBuyBurnJob, createStakingSyncJob } from "./jobs/lmns";
import { createFeeDistributeJob } from "./jobs/fee-distribute";
import { writeReceipts } from "./jobs/receipts";
import { updateReferencePrices } from "./jobs/reference";
import { syncCompanyIrEarnings, updateEarnings } from "./jobs/earnings";
import { checkRoles, requiredRoles } from "./startup";
import { SESSION_EXTENDED, SESSION_REGULAR } from "./sessions";

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
// hedge is the legacy job until the hedger (todo 14) replaces it.
const validJobs = new Set(["sessions", "lister", "accrue", "hedge", "risk", "corp-actions", "receipts", "reference", "earnings", "queued-sells", "fee-distribute", "settle-halted", "staking-sync", "buy-burn"]);
for (const job of enabled) if (!validJobs.has(job)) throw new Error(`Unknown keeper job: ${job}`);

async function startup(): Promise<KeeperContext["deployment"]> {
  const deployment = await loadOptionDeployment(config.DEPLOYMENT_FILE);
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
  if (enabled.has("sessions") && !deployment.contracts.marketHours) throw new Error("The sessions job needs contracts.marketHours in the deployment");
  const sendsTransactions = ["sessions", "lister", "risk", "corp-actions", "accrue", "queued-sells", "fee-distribute", "settle-halted", "staking-sync", "buy-burn"].some((job) => enabled.has(job));
  if (sendsTransactions) {
    const account = clients.walletClient?.account;
    if (!account) throw new Error("No keeper signer configured (KEEPER_PRIVATE_KEY)");
    if (deployment.keeper && account.address.toLowerCase() !== deployment.keeper) throw new Error("Signer does not match deployment keeper");
    const roles = await checkRoles(clients, requiredRoles(enabled, deployment), account.address);
    for (const need of roles.unverified) logger.warn({ job: need.job, contract: need.contract, role: need.role }, "Could not verify keeper role");
    if (roles.missing.length && !config.KEEPER_DRY_RUN) {
      throw new Error(`Keeper lacks required roles: ${roles.missing.map((need) => `${need.job}:${need.contract}.${need.role}`).join(", ")}`);
    }
    for (const need of roles.missing) logger.warn({ job: need.job, contract: need.contract, role: need.role }, "Keeper lacks a role (dry run continues)");
  }
  if (deployment.contracts.marketHours) {
    const marketHours = deployment.contracts.marketHours as `0x${string}`;
    const [sessions, kinds] = await Promise.all([
      clients.stateClient.readContract({ address: marketHours, abi: MarketHoursAbi, functionName: "sessions" }),
      clients.stateClient.readContract({ address: marketHours, abi: MarketHoursAbi, functionName: "sessionKinds" }),
    ]);
    const stored = sessions.map((s, i) => ({ open: s.open, close: s.close, kind: (Number(kinds[i]) === 1 ? SESSION_EXTENDED : SESSION_REGULAR) as 0 | 1 }));
    const meta = sessionsMeta(stored);
    await sql`insert into keeper_status (job,meta) values ('sessions',${JSON.stringify(meta)}::jsonb)
      on conflict (job) do update set meta=keeper_status.meta || excluded.meta`;
  }
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
  const accrue = createAccrueJob(ctx);
  const lister = createListerJob(ctx);
  const definitions = [
    { name: "sessions", everyMs: 3600000, run: () => updateSessions(ctx) },
    { name: "lister", everyMs: 3600000, run: () => lister() },
    { name: "accrue", everyMs: 300000, run: async () => {
      const force = forceAccrue;
      forceAccrue = false;
      try { return await accrue(force); }
      catch (error) {
        // Preserve a failed boundary request across the scheduler's retry.
        forceAccrue ||= force;
        throw error;
      }
    } },
    { name: "queued-sells", everyMs: 120000, run: createQueuedSellsJob(ctx) },
    { name: "fee-distribute", everyMs: 3600000, run: createFeeDistributeJob(ctx) },
    // ORC-4 (decision 31): settle stocks HALTED past the engine's settle delay; permissionless, no role needed.
    { name: "settle-halted", everyMs: 600000, run: createSettleHaltedJob(ctx) },
    // Decision 42: hourly LmnsStaking.syncLoss (idle without staking). Decision 43: keeper-only buyAndBurn, off unless
    // "buy-burn" is in KEEPER_ENABLED_JOBS and the deployment names the contract.
    { name: "staking-sync", everyMs: 3600000, run: createStakingSyncJob(ctx) },
    { name: "buy-burn", everyMs: 3600000, run: createBuyBurnJob(ctx) },
    { name: "hedge", everyMs: 900000, run: createHedgeJob(ctx) },
    { name: "risk", everyMs: 60000, run: createRiskJob(ctx) },
    { name: "corp-actions", everyMs: 600000, run: () => updateCorporateActions(ctx) },
    { name: "receipts", everyMs: 300000, run: () => writeReceipts(ctx) },
    { name: "reference", everyMs: 60000, run: () => updateReferencePrices(ctx) },
    { name: "earnings", everyMs: 3600000, run: async () => {
      // Second source for the vol-engine's two-source check; a failure here must not stop the Alpha Vantage import.
      await syncCompanyIrEarnings(ctx).catch((error) => logger.warn(`Company IR earnings sync failed: ${error instanceof Error ? error.message : "error"}`));
      return updateEarnings(ctx);
    } },
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
