import { encodeFunctionData, formatEther } from "viem";
import { LemniscateEngineAbi } from "../../abi/LemniscateEngine";
import type { KeeperContext } from "../context";

export function createRiskJob(context: KeeperContext) {
  let nextBalanceCheck = 0;
  let balance = 0n;
  let haltSent = false;
  return async (): Promise<Record<string, unknown>> => {
    const metadata = await context.metadata();
    if (!metadata.globalConfig) throw new Error("Waiting for indexed risk configuration");
    const now = context.now(metadata);
    const warnings: string[] = [];
    if (Date.now() >= nextBalanceCheck) {
      balance = await context.clients.txClient.getBalance({ address: context.deployment.keeper });
      nextBalanceCheck = Date.now() + 30 * 60_000;
    }
    if (balance < 2_000_000_000_000_000n) warnings.push("Keeper ETH balance is below 0.002");
    const navs = await context.sql<{ current: string | null; peak: string | null; nav: string | null }[]>`
      select (select nav_per_share from vault_ticks order by ts desc limit 1) as current,
        (select nav from vault_ticks order by ts desc limit 1) as nav,
        max(nav_per_share) as peak from vault_ticks where ts >= ${new Date(now.getTime() - 30 * 86400000).toISOString()}`;
    const current = Number(navs[0]?.current ?? 0);
    const peak = Number(navs[0]?.peak ?? 0);
    const drawdownPct = peak > 0 ? (peak - current) / peak * 100 : 0;
    if (metadata.globalConfig.globalBuysPaused) haltSent = false;
    if (drawdownPct > 10) {
      warnings.push("RISK_HALT: vault NAV per share drawdown exceeds 10%");
      if (!metadata.globalConfig.globalBuysPaused && !haltSent) {
        context.logger.fatal({ drawdownPct }, "RISK_HALT: pausing new buys");
        const result = await context.tx.submit({
          label: "risk", to: context.deployment.contracts.engine,
          data: encodeFunctionData({ abi: LemniscateEngineAbi, functionName: "setGlobalBuysPaused", args: [true] }),
        });
        haltSent = !result.simulated;
      }
    } else haltSent = false;
    const ticks = await context.sql<{ market_id: number; regime: number; oracle_updated_at: Date | string; liability: string }[]>`
      select distinct on (market_id) market_id, regime, oracle_updated_at, liability from ticks order by market_id, ts desc`;
    for (const tick of ticks) {
      const market = metadata.marketsById?.[String(tick.market_id)];
      if (!market) continue;
      const age = (now.getTime() - new Date(tick.oracle_updated_at).getTime()) / 1000;
      if (tick.regime === 0 && age > Number(market.config.maxAgeOpen) * 0.8) warnings.push(`${market.symbol} oracle is approaching its maximum age`);
      const capacity = Number(navs[0]?.nav ?? 0) * Number(market.config.maxMarketExposureBps) / 10000;
      const liability = Number(tick.liability);
      if (liability > 0 && (capacity <= 0 || liability / capacity > 0.9)) warnings.push(`${market.symbol} utilization exceeds 90%`);
    }
    const sessions = await context.sql<{ meta: Record<string, unknown> }[]>`select meta from keeper_status where job = 'sessions'`;
    if (Number(sessions[0]?.meta.horizon ?? 0) - now.getTime() / 1000 < 3 * 86400) warnings.push("Market sessions expire within three days");
    if (Number(metadata.lagBlocks ?? 0) > 60) warnings.push("Indexer is more than 60 blocks behind");
    for (const warning of warnings) context.logger.warn({ warning }, "Keeper risk warning");
    return { warnings, drawdownPct, keeperEth: formatEther(balance) };
  };
}
