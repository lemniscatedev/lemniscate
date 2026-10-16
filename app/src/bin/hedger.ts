import { encodeFunctionData, type Address } from "viem";
import { PoolAbi } from "../abi/Pool";
import { createClients } from "../chain/clients";
import { loadOptionDeployment } from "../chain/deployment";
import { createRpcPool } from "../chain/rpc-pool";
import { loadConfig, optionalEnv, stripKeeperSecrets } from "../config";
import { createDbClient } from "../db/client";
import {
  acquireHedgerLock, ApiPerpVenue, assertHedgerKeyDistinct, createChainSpotPort, createPoolSpotPort, hedgerSettings, loadBook,
  loadHedgerSigningKey, newHedgerState, PoolSpotVenue, postHedgeEquityOnce, resolveRoutes, runHedgeCycle, type IHedgeVenue,
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
const poolAddress = deployment.contracts.pool as Address;
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

const stocks = deployment.stocks.map((s) => ({ name: s.name, stock: s.stock as Address }));
const routes = await resolveRoutes(clients, deployment.contracts.usdg as Address, stocks);
logger.info({ hedger, dryRun: settings.dryRun, routed: [...routes.keys()].length, perp: config.HEDGER_PERP_ENABLED }, "Hedger starting");
// Decision 19 (todo 14b): the spot hedge lives in the Writer Pool. The hedger reads Uniswap prices/TWAP/depth for its caps
// and calls pool.rebalance (HEDGER role); its wallet holds gas only. The price reader needs no adapter or approvals.
const uniswapPrices = createChainSpotPort({
  clients, submit: (t) => tx.submit(t), hedger, adapter: poolAddress, usdg: deployment.contracts.usdg as Address, routes, twapSeconds: settings.twapSeconds,
}).prices;
const spot = new PoolSpotVenue(
  createPoolSpotPort({ clients, submit: (t) => tx.submit(t), pool: poolAddress, usdg: deployment.contracts.usdg as Address, prices: uniswapPrices }),
  { stocks: [...routes.keys()], maxLiquidityBps: settings.maxLiquidityBps },
);
const venues: IHedgeVenue[] = [];
if (config.HEDGER_PERP_ENABLED) {
  const seed = optionalEnv("ARCUS_ED25519_SEED");
  if (!seed || !config.ARCUS_API_KEY_ID) throw new Error("HEDGER_PERP_ENABLED needs ARCUS_API_KEY_ID and ARCUS_ED25519_SEED");
  const markets = new Map(stocks.map((s) => [s.stock.toLowerCase(), `${s.name}-USD`] as const));
  venues.push(new ApiPerpVenue({ baseUrl: config.ARCUS_API_URL, apiKeyId: config.ARCUS_API_KEY_ID, seedHex: seed, markets }));
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
      record: async (row) => {
        await sql`insert into hedges (venue, name, side, qty, px, ts, venue_ref)
          values (${row.venue}, ${row.name}, ${row.side}, ${row.qty}, ${row.px}, ${row.ts.toISOString()}, ${row.venueRef})`;
      },
      settings, state, now: () => Date.now(), logger,
    });
    return result as unknown as Record<string, unknown>;
  },
});

scheduler.add({
  name: "hedger-equity", everyMs: 300_000, jitterMs: 2000,
  run: async () => {
    const [row] = await sql<{ as_of: Date | null }[]>`select max(as_of) as as_of from hedge_equity_posts`;
    const lastPostedAsOf = Math.max(lastEquityAsOf, row?.as_of ? Math.floor(row.as_of.getTime() / 1000) : 0);
    const outcome = await postHedgeEquityOnce({
      venues, stocks: [...routes.keys()], nowSeconds: Math.floor(Date.now() / 1000), lastPostedAsOf,
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
