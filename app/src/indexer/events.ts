import { decodeEventLog, parseAbi, toEventSelector, type Abi, type Address, type Hex } from "viem";
import {
  AgentRouterAbi,
  OptionEngineAbi,
  OptionTokenAbi,
  PoolAbi,
  PriceGuardAbi,
  SeriesRegistryAbi,
  VolOracleAbi,
} from "../abi";
import type { OptionDeployment } from "../chain/deployment";
import type { ChainEvent, EventSource, RpcLog, SeriesInfo } from "./types";
import { asAddress, asBigInt, asNumber } from "./units";

const stockEventAbi = parseAbi([
  "event UIMultiplierUpdated(uint256 oldMultiplier, uint256 newMultiplier, uint256 effectiveAtTimestamp)",
  "event OraclePaused()",
  "event OracleUnpaused()",
  "event Paused()",
  "event Unpaused()",
]);

/** Topics fetched from the Stock Tokens themselves (the multiplier and pause events that drive corporate actions). */
export const watchedStockTopics = stockEventAbi.map((event) => toEventSelector(event)) as readonly Hex[];

export interface EventAddressMaps {
  readonly deployment: OptionDeployment;
  readonly seriesByToken: ReadonlyMap<string, SeriesInfo>;
  readonly stockNames: ReadonlyMap<string, string>;
}

function locate(address: string, maps: EventAddressMaps): { source: EventSource; abi: Abi } | undefined {
  const { contracts } = maps.deployment;
  if (address === contracts.engine) return { source: "engine", abi: OptionEngineAbi as Abi };
  if (address === contracts.pool) return { source: "pool", abi: PoolAbi as Abi };
  if (address === contracts.registry) return { source: "registry", abi: SeriesRegistryAbi as Abi };
  if (address === contracts.volOracle) return { source: "volOracle", abi: VolOracleAbi as Abi };
  if (address === contracts.priceGuard) return { source: "priceGuard", abi: PriceGuardAbi as Abi };
  if (contracts.agentRouter && address === contracts.agentRouter) return { source: "agentRouter", abi: AgentRouterAbi as Abi };
  if (maps.seriesByToken.has(address)) return { source: "token", abi: OptionTokenAbi as Abi };
  if (maps.stockNames.has(address)) return { source: "stock", abi: stockEventAbi as unknown as Abi };
  return undefined;
}

function decoded(log: RpcLog, abi: Abi): { eventName: string; args: Record<string, unknown> } | undefined {
  try {
    const result = decodeEventLog({
      abi,
      data: log.data,
      topics: log.topics as unknown as [Hex, ...Hex[]],
      strict: false,
    });
    return {
      eventName: String(result.eventName),
      // viem returns undefined for zero-argument events.
      args: (result.args ?? {}) as unknown as Record<string, unknown>,
    };
  } catch {
    return undefined;
  }
}

export function decodeChainLog(log: RpcLog, maps: EventAddressMaps, ts: Date): ChainEvent | undefined {
  const address = asAddress(log.address);
  const located = locate(address, maps);
  if (!located) return undefined;
  const event = decoded(log, located.abi);
  if (!event) return undefined;
  const blockNumber = asBigInt(log.blockNumber, -1n);
  const logIndex = asNumber(log.logIndex, -1);
  if (blockNumber < 0n || logIndex < 0 || !log.transactionHash) return undefined;
  return {
    address,
    blockNumber,
    txHash: log.transactionHash.toLowerCase(),
    logIndex,
    ts,
    eventName: event.eventName,
    args: event.args,
    source: located.source,
  };
}

/** Option-token contracts announced by SeriesListed events in a decoded batch. */
export function listedSeries(events: readonly ChainEvent[]): SeriesInfo[] {
  const found: SeriesInfo[] = [];
  for (const event of events) {
    if (event.source !== "registry" || event.eventName !== "SeriesListed") continue;
    const { id, token, stock } = event.args;
    if (typeof id !== "string" || typeof token !== "string" || typeof stock !== "string") continue;
    found.push({ id: id.toLowerCase(), token: asAddress(token), stock: asAddress(stock) });
  }
  return found;
}

export function logAddress(address: Address): string {
  return asAddress(address);
}
