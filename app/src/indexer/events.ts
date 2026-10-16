import {
  decodeEventLog,
  parseAbi,
  toEventSelector,
  type Address,
  type Abi,
  type Hex,
} from "viem";
import { WriterPoolAbi, MarketHoursAbi, LemniscateEngineAbi, OptionTokenAbi } from "../abi";
import type { Deployment } from "../chain/deployment";
import type { ChainEvent, MarketInfo, RpcLog } from "./types";
import { asAddress, asBigInt, asNumber } from "./units";

const oracleEventAbi = parseAbi([
  "event AnswerUpdated(int256 indexed current, uint256 indexed roundId, uint256 updatedAt)",
]);
const stockEventAbi = parseAbi([
  "event UIMultiplierUpdated(uint256 oldMultiplier, uint256 newMultiplier, uint256 effectiveAtTimestamp)",
  "event OraclePaused()",
  "event OracleUnpaused()",
  "event Paused()",
  "event Unpaused()",
]);

export const watchedExternalTopics = [
  toEventSelector(oracleEventAbi[0]!),
  ...stockEventAbi.map((event) => toEventSelector(event)),
] as const;

export interface EventAddressMaps {
  readonly deployment: Deployment;
  readonly marketById: ReadonlyMap<number, MarketInfo>;
  readonly tokenToMarket: ReadonlyMap<string, number>;
  readonly stockToMarket: ReadonlyMap<string, number>;
  readonly aggregatorToMarket: ReadonlyMap<string, number>;
}

function eventSource(
  logAddress: string,
  maps: EventAddressMaps,
): { source: ChainEvent["source"]; abi: Abi } | undefined {
  const address = logAddress.toLowerCase();
  if (address === maps.deployment.contracts.engine) return { source: "engine", abi: LemniscateEngineAbi };
  if (address === maps.deployment.contracts.vault) return { source: "vault", abi: WriterPoolAbi };
  if (address === maps.deployment.contracts.marketHours) return { source: "hours", abi: MarketHoursAbi };
  if (maps.tokenToMarket.has(address)) return { source: "token", abi: OptionTokenAbi };
  if (maps.stockToMarket.has(address)) return { source: "external", abi: stockEventAbi };
  if (maps.aggregatorToMarket.has(address)) return { source: "external", abi: oracleEventAbi };
  return undefined;
}

function decodedEvent(
  log: RpcLog,
  abi: Abi,
): { eventName: string; args: Record<string, unknown> } | undefined {
  try {
    const decoded = decodeEventLog({
      abi,
      data: log.data,
      topics: log.topics as unknown as [Hex, ...Hex[]],
      strict: false,
    });
    return {
      eventName: String(decoded.eventName),
      // viem returns undefined for zero-argument stock pause events.
      args: (decoded.args ?? {}) as unknown as Record<string, unknown>,
    };
  } catch {
    return undefined;
  }
}

function marketIdFor(
  source: ChainEvent["source"],
  address: string,
  eventName: string,
  args: Record<string, unknown>,
  maps: EventAddressMaps,
): number | undefined {
  const explicitId = args.id;
  if (explicitId !== undefined) return asNumber(explicitId, -1) >= 0 ? asNumber(explicitId) : undefined;
  const normalizedAddress = address.toLowerCase();
  if (source === "token") return maps.tokenToMarket.get(normalizedAddress);
  if (eventName === "AnswerUpdated") return maps.aggregatorToMarket.get(normalizedAddress);
  return maps.stockToMarket.get(normalizedAddress);
}

export function decodeChainLog(log: RpcLog, maps: EventAddressMaps, ts: Date): ChainEvent | undefined {
  const address = asAddress(log.address);
  const located = eventSource(address, maps);
  if (!located) return undefined;
  const decoded = decodedEvent(log, located.abi);
  if (!decoded) return undefined;
  const blockNumber = asBigInt(log.blockNumber, -1n);
  const logIndex = asNumber(log.logIndex, -1);
  if (blockNumber < 0n || logIndex < 0 || !log.transactionHash) return undefined;

  const marketId = marketIdFor(located.source, address, decoded.eventName, decoded.args, maps);
  return {
    log,
    address,
    blockNumber,
    txHash: log.transactionHash.toLowerCase(),
    logIndex,
    ts,
    eventName: decoded.eventName,
    args: decoded.args,
    source: located.source,
    ...(marketId === undefined ? {} : { marketId }),
  };
}

export function marketListedAddresses(event: ChainEvent): readonly Address[] {
  if (event.source !== "engine" || event.eventName !== "MarketListed") return [];
  const token = event.args.token;
  const stock = event.args.stock;
  const feed = event.args.feed;
  const addresses: Address[] = [];
  if (typeof stock === "string") addresses.push(asAddress(stock));
  if (typeof feed === "string") addresses.push(asAddress(feed));
  if (typeof token === "string") addresses.push(asAddress(token));
  return addresses;
}

export function eventMarketId(event: ChainEvent): number | undefined {
  return event.marketId;
}
