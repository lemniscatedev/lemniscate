import { encodeFunctionData } from "viem";
import { LemniscateEngineAbi as engineAbi } from "../../abi/LemniscateEngine";
import type { IndexerMetadata, KeeperContext } from "../context";

function hasNoPositions(context: KeeperContext, metadata: IndexerMetadata): boolean {
  // Only a complete, caught-up observation can justify suppressing a write.
  // Missing/failed/stale indexer data retains the previous accrual behavior.
  const age = Date.now() - Date.parse(metadata.indexerLastOk ?? "");
  const lag = Number(metadata.lagBlocks);
  if (!(age >= 0 && age <= 120_000) || metadata.indexerLastError !== null
    || !Number.isFinite(lag) || lag < 0 || lag > 60
    || metadata.pendingSnapshot !== false || metadata.registrySyncPending !== false) return false;
  const markets = metadata.marketsById ?? {};
  if (!Object.keys(markets).every((id, index) => id === String(index))) return false;
  if (!context.deployment.markets.length || !context.deployment.markets.every(({ id, token }) =>
    markets[String(id)]?.token?.toLowerCase() === token.toLowerCase())) return false;
  return Object.values(markets).every((market) =>
    typeof market.state?.vaultShort === "string" && /^0+$/.test(market.state.vaultShort));
}

async function confirmBoundaryIdle(context: KeeperContext, metadata: IndexerMetadata): Promise<boolean> {
  // A buy just before a boundary may not be confirmed/indexed yet. Verify at
  // the current head before suppressing a forced poke, without adding another
  // periodic RPC poller. An unknown result retains the existing boundary write.
  const ids = Object.keys(metadata.marketsById ?? {}).map(Number);
  if (!ids.every((id, index) => id === index)) return false;
  try {
    const contracts = [
      { address: context.deployment.contracts.engine, abi: engineAbi, functionName: "marketCount" as const },
      ...ids.map((id) => ({ address: context.deployment.contracts.engine, abi: engineAbi,
        functionName: "getState" as const, args: [id] as const })),
    ];
    const [count, ...states] = await context.clients.stateClient.multicall({
      allowFailure: false,
      contracts,
    });
    return Number(count) === ids.length && states.length === ids.length
      && states.every((state) => typeof state === "object" && state !== null
        && "vaultShort" in state && state.vaultShort === 0n);
  } catch {
    return false;
  }
}

export async function accrueStale(context: KeeperContext, force = false): Promise<Record<string, unknown>> {
  const metadata = await context.metadata();
  const states = Object.values(metadata.marketsById ?? {});
  if (!states.length) throw new Error("Waiting for indexed market state");
  if (states.some((market) => !/^\d+$/.test(market.state?.lastAccrual ?? ""))) {
    throw new Error("Waiting for complete indexed accrual state");
  }
  const now = context.now(metadata).getTime() / 1000;
  const maxAge = context.config.KEEPER_ACCRUE_MAX_AGE_SECONDS;
  const stale = states.some((market) => now - Number(market.state.lastAccrual) >= maxAge);
  // Trades accrue in the engine before minting/burning. Keep hedging enabled
  // independently: the last seller may leave a hedge that needs unwinding.
  if (hasNoPositions(context, metadata)
    && (!force || await confirmBoundaryIdle(context, metadata))) return { stale, idle: true };
  if (!force && !stale) return { stale: false, idle: false };
  const result = await context.tx.submit({
    label: "accrue", to: context.deployment.contracts.engine,
    data: encodeFunctionData({ abi: engineAbi, functionName: "accrueAll" }),
  });
  return { stale, idle: false, dryRun: result.simulated, lastAccruedAt: context.now(metadata).toISOString() };
}
