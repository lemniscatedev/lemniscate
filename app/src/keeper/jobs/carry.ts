import { encodeFunctionData, parseUnits } from "viem";
import { LemniscateEngineAbi } from "../../abi/LemniscateEngine";
import type { KeeperContext } from "../context";

export async function updateCarry(context: KeeperContext): Promise<Record<string, unknown>> {
  const meta = await context.metadata();
  const now = context.now(meta);
  const day = now.toISOString().slice(0, 10);
  if (now.getUTCHours() === 0 && now.getUTCMinutes() < 30) return {};
  const rows = await context.sql<{ meta: Record<string, unknown> }[]>`select meta from keeper_status where job = 'carry'`;
  if (rows[0]?.meta.lastEvaluationDate === day) return {};
  if (!meta.marketsById) throw new Error("Waiting for indexed carry state");
  const updated: number[] = [];
  const samples: Record<string, number> = {};
  for (const [id, market] of Object.entries(meta.marketsById)) {
    const closes = await context.sql<{ spot: string }[]>`
      select last(spot, ts) as spot from ticks
      where market_id = ${Number(id)} and regime = 0 and ts >= ${new Date(now.getTime() - 30 * 86400000).toISOString()}
        and ts <= ${now.toISOString()} group by time_bucket(interval '1 hour', ts) order by time_bucket(interval '1 hour', ts)`;
    samples[id] = closes.length;
    if (closes.length < 7 * 24) continue;
    const returns = closes.slice(1).map((point, i) => Math.log(Number(point.spot) / Number(closes[i]!.spot)));
    if (returns.some((value) => !Number.isFinite(value))) continue;
    const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
    const variance = returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (returns.length - 1);
    const sigma = Math.sqrt(variance * 24 * 252);
    const current = BigInt(market.state.baseCarryWad);
    if (now.getTime() / 1000 - Number(market.state.baseCarryUpdatedAt) < 86400) continue;
    const lower = parseUnits(String(market.config.baseCarryMinWad), 18);
    const upper = parseUnits(String(market.config.baseCarryMaxWad), 18);
    let target = BigInt(Math.floor(1.2 * sigma * sigma / 365 * 1e18));
    target = target < lower ? lower : target > upper ? upper : target;
    const step = current * 2500n / 10000n;
    target = target < current - step ? current - step : target > current + step ? current + step : target;
    const difference = target > current ? target - current : current - target;
    context.logger.info({ market: Number(id), sigma, target: target.toString(), samples: closes.length }, "Estimated realized carry");
    if (difference * 100n <= current * 2n) continue;
    await context.tx.submit({
      label: `carry:${id}`, to: context.deployment.contracts.engine,
      data: encodeFunctionData({ abi: LemniscateEngineAbi, functionName: "setBaseCarry", args: [Number(id), target] }),
    });
    updated.push(Number(id));
  }
  return { lastEvaluationDate: day, samples, updated };
}
