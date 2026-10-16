import { loadConfig } from "../src/config";
import { DeploymentFileError, loadDeployment } from "../src/chain/deployment";
import { createDbClient } from "../src/db/client";

const config = loadConfig();
if (config.NODE_ENV !== "development" || config.NETWORK !== "fork" || process.env.ALLOW_DEV_FIXTURES !== "1") {
  throw new Error("Fixtures require NODE_ENV=development, NETWORK=fork, and ALLOW_DEV_FIXTURES=1.");
}

const { sql } = createDbClient(config);
const account = "0x000000000000000000000000000000000000cafe";
const sender = "0x000000000000000000000000000000000000beef";
const fallbackSymbols = ["NVDA", "TSLA", "SPY", "PLTR", "AAPL"];
let deployment: Awaited<ReturnType<typeof loadDeployment>> | undefined;
try {
  deployment = await loadDeployment(config.DEPLOYMENT_FILE);
} catch (error) {
  if (!(error instanceof DeploymentFileError) || !error.message.includes("does not exist")) throw error;
}
const fixtureMarkets = deployment?.markets.map((market) => ({
  id: market.id,
  symbol: market.symbol,
  token: market.token,
  stock: market.stock,
  feed: market.feed,
  scale: Number(market.scale),
  poolFee: market.poolFee,
})) ?? fallbackSymbols.map((symbol, index) => ({
  id: index + 1,
  symbol,
  token: addressFor(0x1001 + index),
  stock: addressFor(0x2001 + index),
  feed: addressFor(0x3001 + index),
  scale: 1000 * (index + 1),
  poolFee: 500,
}));
const vaultToken = deployment?.contracts.vault ?? "0x0000000000000000000000000000000000000bad";
const now = new Date();
const nowIso = now.toISOString();

function addressFor(seed: number): string {
  return `0x${seed.toString(16).padStart(40, "0")}`;
}

function hashFor(seed: number): string {
  return `0x${seed.toString(16).padStart(64, "0")}`;
}

function usd(value: number): string {
  return value.toFixed(18);
}

try {
  await sql.begin(async (tx) => {
    for (let index = 0; index < fixtureMarkets.length; index += 1) {
      const market = fixtureMarkets[index]!;
      const { id, symbol, token, stock, feed, scale, poolFee } = market;
      const configData = {
        feeBps: 10,
        openSpreadBps: 40,
        offHoursSpreadBps: 150,
        pausedSpreadBps: 300,
        openBandBps: 100,
        offHoursBandBps: 300,
        impactBps: 50,
        maxMarketExposureBps: 2500,
        maxTradeUsdg: "25",
        minTradeUsdg: "1",
      };
      await tx`
        insert into markets (id, symbol, token, stock, feed, scale, pool_fee, listed_block, config)
        values (${id}, ${symbol}, ${token}, ${stock}, ${feed}, ${scale}, ${poolFee}, ${1}, ${JSON.stringify(configData)}::jsonb)
        on conflict (id) do update set symbol = excluded.symbol, token = excluded.token, stock = excluded.stock,
          feed = excluded.feed, scale = excluded.scale, pool_fee = excluded.pool_fee, config = excluded.config, updated_at = now()
      `;

      const spot = 100 + id * 20;
      const indexPrice = (spot * spot) / scale;
      const fair = indexPrice * 0.99;
      const liability = fair;
      const hedgeUnits = (2 * liability) / spot;
      for (let tick = 0; tick <= 54; tick += 1) {
        const ts = new Date(now.getTime() - (54 - tick) * 30 * 60_000);
        const tsIso = ts.toISOString();
        const tickPrice = fair * (1 + ((tick % 9) - 4) / 10_000);
        await tx`
          insert into ticks (market_id, ts, block, spot, "index", norm_factor, price, bid, ask, carry_wad,
            regime, buys_paused, vault_short, liability, hedge_units, hedge_target, oracle_updated_at)
          values (${id}, ${tsIso}, ${String(100 + tick)}, ${usd(spot)}, ${usd(indexPrice)}, ${usd(0.99)},
            ${usd(tickPrice)}, ${usd(tickPrice * 0.996)}, ${usd(tickPrice * 1.004)}, ${usd(0.00082)},
            ${0}, ${false}, ${usd(1)}, ${usd(liability)}, ${usd(hedgeUnits)}, ${usd(hedgeUnits)}, ${tsIso})
          on conflict (market_id, ts) do update set spot = excluded.spot, "index" = excluded."index", norm_factor = excluded.norm_factor,
            price = excluded.price, bid = excluded.bid, ask = excluded.ask, carry_wad = excluded.carry_wad,
            regime = excluded.regime, buys_paused = excluded.buys_paused, liability = excluded.liability,
            hedge_units = excluded.hedge_units, hedge_target = excluded.hedge_target
        `;
      }
      const txHash = hashFor(0x5000 + id);
      await tx`
        insert into trades (tx_hash, log_index, block, ts, market_id, account, recipient, side, usdg, fee, tokens, price, "index", norm_factor)
        values (${txHash}, ${id}, ${String(100 + id)}, ${nowIso}, ${id}, ${account}, ${account}, 'buy', ${usd(12.5)}, ${usd(0.0125)}, ${usd(1)}, ${usd(fair)}, ${usd(indexPrice)}, ${usd(0.99)})
        on conflict (tx_hash, log_index) do update set ts = excluded.ts, usdg = excluded.usdg, tokens = excluded.tokens
      `;
      await tx`
        insert into balances (token, account, balance, updated_block)
        values (${token}, ${account}, ${usd(1)}, ${String(200 + id)})
        on conflict (token, account) do update set balance = excluded.balance, updated_block = excluded.updated_block
      `;
      await tx`
        insert into regime_log (tx_hash, log_index, market_id, ts, from_regime, to_regime, block)
        values (${hashFor(0x6000 + id)}, ${id}, ${id}, ${nowIso}, ${1}, ${0}, ${String(300 + id)})
        on conflict (tx_hash, log_index) do nothing
      `;
    }

    const nav = 100;
    for (let hour = 0; hour <= 8 * 24; hour += 1) {
      const ts = new Date(now.getTime() - (8 * 24 - hour) * 60 * 60_000);
      const tsIso = ts.toISOString();
      const navPerShare = 1 + hour * 0.0001;
      await tx`
        insert into vault_ticks (ts, block, nav, total_assets, total_supply, nav_per_share, usdg, total_liability,
          max_global_exposure_bps, public_deposits, deposit_cap_remaining)
        values (${tsIso}, ${String(500 + hour)}, ${usd(nav)}, ${usd(nav + 10)}, ${usd(100)}, ${usd(navPerShare)},
          ${usd(75)}, ${usd(25)}, ${5000}, ${false}, ${usd(900)})
        on conflict (ts) do update set nav = excluded.nav, total_assets = excluded.total_assets,
          nav_per_share = excluded.nav_per_share, total_liability = excluded.total_liability
      `;
    }
    await tx`
      insert into balances (token, account, balance, updated_block)
      values (${vaultToken}, ${account}, ${usd(2)}, ${String(999)})
      on conflict (token, account) do update set balance = excluded.balance, updated_block = excluded.updated_block
    `;
    await tx`
      insert into vault_account_state (account, is_depositor, unlock_time, updated_block)
      values (${account}, ${true}, ${new Date(now.getTime() + 60 * 60_000).toISOString()}, ${String(999)})
      on conflict (account) do update set is_depositor = excluded.is_depositor, unlock_time = excluded.unlock_time,
        updated_block = excluded.updated_block, updated_at = now()
    `;
    await tx`
      insert into vault_events (tx_hash, log_index, block, ts, kind, account, sender, receiver, assets, shares)
      values (${hashFor(0x7000)}, ${0}, ${String(999)}, ${nowIso}, 'deposit', ${account}, ${account}, ${vaultToken}, ${usd(2)}, ${usd(2)})
      on conflict (tx_hash, log_index) do nothing
    `;
    await tx`
      insert into transfers (tx_hash, log_index, block, ts, market_id, token, from_addr, to_addr, amount)
      values (${hashFor(0x7001)}, ${1}, ${String(1000)}, ${nowIso}, ${null}, ${vaultToken}, ${sender}, ${account}, ${usd(0.5)})
      on conflict (tx_hash, log_index) do nothing
    `;
    await tx`
      insert into corp_actions (id, symbol, kind, status, process_date, effective_at, details, source)
      values ('dev-fixture-split', 'NVDA', 'split', 'scheduled', current_date + 1, now() + interval '1 day', '{"fixture":true}'::jsonb, 'robinhood-api')
      on conflict (id) do update set status = excluded.status, process_date = excluded.process_date, effective_at = excluded.effective_at
    `;
    await tx`
      insert into cursors (name, block) values ('main', ${String(1000)})
      on conflict (name) do update set block = excluded.block, updated_at = now()
    `;
    await tx`
      insert into keeper_status (job, last_run, last_ok, meta)
      values ('indexer', now(), now(), '{"lastHeadBlock":1000,"lastIndexedBlock":1000,"lagBlocks":0}'::jsonb)
      on conflict (job) do update set last_run = now(), last_ok = now(), meta = keeper_status.meta || excluded.meta
    `;
  });

  for (const view of ["candles_1m", "candles_1h", "candles_1d", "vault_1h"]) {
    try {
      await sql.unsafe(`call refresh_continuous_aggregate('${view}', now() - interval '35 days', now() - interval '2 minutes')`);
    } catch {
      // Empty or unsupported aggregate refreshes do not block local fixture data.
    }
  }
  console.info("Development API fixtures inserted.\n");
} finally {
  await sql.end({ timeout: 5 });
}
