import { encodeFunctionData, formatUnits, type Address } from "viem";
import { OptionEngineAbi } from "../abi/OptionEngine";
import { PoolAbi } from "../abi/Pool";
import { createClients } from "../chain/clients";
import { loadOptionDeployment } from "../chain/deployment";
import { createRpcPool } from "../chain/rpc-pool";
import { loadConfig, optionalEnv, stripKeeperSecrets } from "../config";
import { createDbClient } from "../db/client";
import {
  acquireHedgerLock, ApiPerpVenue, assertHedgerKeyDistinct, createChainPoolPort, hedgerSettings, lastEquityPostAsOf, loadBook, loadHedgerSigningKey,
  newHedgerState, PoolSpotVenue, postHedgeEquityOnce, resolveRoutes, runHedgeCycle, type IHedgeVenue,
} from "../hedger";
import { createScheduler } from "../keeper/scheduler";
import { createTransactionQueue } from "../keeper/tx";
import { createLogger, safeErrorSummary } from "../log";

// R6: refuse to start when the hedger key is the keeper key, then drop the keeper secret from this process.
assertHedgerKeyDistinct();
const hedgerKey = loadHedgerSigningKey();
stripKeeperSecrets();
if (!hedgerKey) throw new Error("HEDGER_PRIVATE_KEY is required (a wallet that is not the keeper wallet)");

const config = loadConfig();
const settings = hedgerSettings(config);
const logger = createLogger(config.LOG_LEVEL, "hedger");
const deployment = await loadOptionDeployment(config.DEPLOYMENT_FILE);
const clients = createClients(config, createRpcPool(config), hedgerKey);
const hedger = clients.walletClient!.account!.address;
const { sql } = createDbClient(config);

const release = await acquireHedgerLock(config.DATABASE_URL);
if (!release) { logger.fatal("Another hedger instance holds the lock; exiting"); process.exit(1); }

const tx = createTransactionQueue(clients, {
  dryRun: false, logger,
  onHash: async (transaction, hash) => {
    await sql`insert into keeper_status (job,last_tx) values ('hedger',${hash}) on conflict (job) do update set last_tx=excluded.last_tx`;
    logger.info({ label: transaction.label, hash }, "Hedger transaction submitted");
  },
});

const pool = deployment.contracts.pool as Address;
const engine = deployment.contracts.engine as Address;
const stocks = deployment.stocks.map((s) => ({ name: s.name, stock: s.stock as Address }));
const routes = await resolveRoutes(clients, deployment.contracts.usdg as Address, stocks);
logger.info({ hedger, dryRun: settings.dryRun, routed: [...routes.keys()].length, perp: config.HEDGER_PERP_ENABLED }, "Hedger starting");
// Decision 19: the Writer Pool holds the spot hedge; this service only computes a target and calls pool.rebalance. The
// hedger wallet holds gas only, so the venue never reads or moves its balance.
const hedgerRole = await clients.stateClient.readContract({ address: pool, abi: PoolAbi, functionName: "HEDGER_ROLE" });
const hasRole = await clients.stateClient.readContract({ address: pool, abi: PoolAbi, functionName: "hasRole", args: [hedgerRole, hedger] });
if (!hasRole) {
  if (!settings.dryRun) throw new Error(`Hedger wallet ${hedger} lacks the pool's HEDGER_ROLE`);
  logger.warn({ hedger }, "Hedger wallet lacks the pool's HEDGER_ROLE (dry run continues)");
}
const spot = new PoolSpotVenue(
  createChainPoolPort({ clients, submit: (t) => tx.submit(t), pool, usdg: deployment.contracts.usdg as Address, routes, twapSeconds: settings.twapSeconds }),
  { maxLiquidityBps: settings.maxLiquidityBps },
);
const perpVenues: IHedgeVenue[] = [];
const venues: IHedgeVenue[] = [];
if (config.HEDGER_PERP_ENABLED) {
  const seed = optionalEnv("ARCUS_ED25519_SEED");
  if (!seed || !config.ARCUS_API_KEY_ID) throw new Error("HEDGER_PERP_ENABLED needs ARCUS_API_KEY_ID and ARCUS_ED25519_SEED");
  const markets = new Map(stocks.map((s) => [s.stock.toLowerCase(), `${s.name}-USD`] as const));
  const perp = new ApiPerpVenue({ baseUrl: config.ARCUS_API_URL, apiKeyId: config.ARCUS_API_KEY_ID, seedHex: seed, markets });
  perpVenues.push(perp);
  venues.push(perp);
}
venues.push(spot); // perp is primary, spot takes the small residuals

const state = newHedgerState();
const scheduler = createScheduler(sql, logger);
let lastEquityAsOf = 0;

scheduler.add({
  name: "hedger", everyMs: config.HEDGER_CYCLE_SECONDS * 1000, jitterMs: 1000,
  run: async () => {
    const result = await runHedgeCycle({
      loadBook: () => loadBook(sql),
      navUsdg: async () => Number((await sql<{ nav: string }[]>`select nav::text as nav from pool_nav order by ts desc limit 1`)[0]?.nav ?? 0),
      venues,
      // Decision 21: engine.netGreeks is the holders' long side; the short pool holds +delta of it as stock.
      chainDelta: async (stock) => {
        const [delta] = await clients.stateClient.readContract({ address: engine, abi: OptionEngineAbi, functionName: "netGreeks", args: [stock] });
        return Number(formatUnits(delta, 18));
      },
      // The risk monitor reads these two fields of keeper_status job 'hedger'.
      onHealth: async (health) => {
        await sql`insert into keeper_status (job, meta) values ('hedger', ${JSON.stringify(health)}::jsonb)
          on conflict (job) do update set meta = keeper_status.meta || excluded.meta`;
      },
      record: async (row) => {
        await sql`insert into hedges (venue, name, side, qty, px, ts, venue_ref)
          values (${row.venue}, ${row.name}, ${row.side}, ${row.qty}, ${row.px}, ${row.ts.toISOString()}, ${row.venueRef})`;
      },
      settings, state, now: () => Date.now(), logger,
    });
    return result as unknown as Record<string, unknown>;
  },
});

// Equity posts cover off-chain perp venues only; pool-held spot is valued on chain inside NAV. With no perp account
// there is nothing to post, so the job is not scheduled at all.
if (perpVenues.length > 0) scheduler.add({
  name: "hedger-equity", everyMs: 300_000, jitterMs: 2000,
  run: async () => {
    const lastPostedAsOf = Math.max(lastEquityAsOf, await lastEquityPostAsOf(sql));
    const outcome = await postHedgeEquityOnce({
      venues: perpVenues, stocks: [...routes.keys()], nowSeconds: Math.floor(Date.now() / 1000), lastPostedAsOf,
      intervalSeconds: settings.equityIntervalSeconds, dryRun: settings.dryRun,
      post: async (equity, asOf, ref) => {
        const result = await tx.submit({
          label: "hedger:equity", to: deployment.contracts.pool as Address,
          data: encodeFunctionData({ abi: PoolAbi, functionName: "postHedgeEquity", args: [equity, asOf, ref] }),
        });
        lastEquityAsOf = Number(asOf);
        return { hash: result.hash };
      },
    });
    if (!outcome.posted && outcome.reason === "venue_unhealthy") logger.warn({ unhealthy: outcome.unhealthy }, "Hedge equity not posted: venue unhealthy (failing closed)");
    return { equity: { ...outcome, equityUsdg: outcome.equityUsdg?.toString() } };
  },
});

const stop = async () => { await scheduler.stop(); await release(); process.exit(0); };
for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { void stop().catch((e) => logger.error({ err: safeErrorSummary(e) }, "Hedger shutdown failed")); });
