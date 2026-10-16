import { custom, http, type Transport } from "viem";
import type { RuntimeConfig } from "../config";
import { logger } from "../log";
import { utcDateKey } from "../lib/time";
import { robinhoodChain } from "./chain";

export type RpcCallClass = "logs" | "state" | "tx";
export type RpcEndpointKind = "alchemy" | "public" | "override";

export interface RpcEndpointInfo {
  readonly id: string;
  readonly kind: RpcEndpointKind;
  readonly url: string;
}

export interface RpcRequest {
  readonly method: string;
  readonly params?: readonly unknown[];
}

export type RpcEndpointRequest = (request: RpcRequest) => Promise<unknown>;
export type RpcRequestFactory = (endpoint: RpcEndpointInfo) => RpcEndpointRequest;

interface Endpoint extends RpcEndpointInfo {
  readonly request: RpcEndpointRequest;
  coolUntil: number;
  failures: number;
}

interface Counters {
  requests: number;
  estimatedCu: number;
  cacheHits: number;
  errors: number;
}

interface CacheEntry {
  readonly value: unknown;
  readonly expiresAt: number | null;
}

const CACHE_LIMIT = 10_000;
const MAX_COOLDOWN_MS = 15 * 60_000;
const NO_DEDUPE_METHODS = new Set([
  "eth_sendRawTransaction",
  "eth_estimateGas",
  "eth_getTransactionCount",
]);
const CU_BY_METHOD: Readonly<Record<string, number>> = {
  eth_blockNumber: 10,
  eth_getLogs: 75,
  eth_call: 26,
  eth_estimateGas: 87,
  eth_sendRawTransaction: 250,
  eth_getTransactionReceipt: 15,
};

function defaultRequestFactory(
  endpoint: RpcEndpointInfo,
  fetchFn?: typeof fetch,
): RpcEndpointRequest {
  const transport = http(endpoint.url, {
    timeout: 8_000,
    retryCount: 0,
    batch: { batchSize: 20, wait: 20 },
    ...(fetchFn ? { fetchFn } : {}),
  })({ chain: robinhoodChain });

  return (request) => transport.request(request as never) as Promise<unknown>;
}

function safeSerialize(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    typeof item === "bigint" ? item.toString() : item,
  );
}

function cacheKey(request: RpcRequest): string {
  return `${request.method}:${safeSerialize(request.params ?? [])}`;
}

function blockTag(params: readonly unknown[] | undefined): string | undefined {
  const tag = params?.[1];
  if (typeof tag === "string") return tag.toLowerCase();
  if (tag && typeof tag === "object") {
    const object = tag as { blockNumber?: unknown; blockTag?: unknown };
    if (typeof object.blockNumber === "bigint") return `0x${object.blockNumber.toString(16)}`;
    if (typeof object.blockNumber === "string") return object.blockNumber.toLowerCase();
    if (typeof object.blockTag === "string") return object.blockTag.toLowerCase();
  }
  return undefined;
}

const FEE_METHODS = new Set(["eth_gasPrice", "eth_maxPriorityFeePerGas", "eth_feeHistory"]);

function cacheLifetime(callClass: RpcCallClass, request: RpcRequest): number | null | undefined {
  const { method, params } = request;
  if (NO_DEDUPE_METHODS.has(method)) return undefined;
  // Transactions must be priced from a fresh fee read: a stale cached price
  // gets broadcasts rejected after a base-fee rise.
  if (FEE_METHODS.has(method)) return callClass === "tx" ? undefined : 5_000;

  if (method === "eth_chainId" || method === "eth_getBlockByHash") return null;
  if (method === "eth_getCode") {
    const tag = blockTag(params);
    if (tag && /^0x[0-9a-f]+$/.test(tag)) return null;
    return tag === "latest" ? 1_000 : undefined;
  }
  if (method === "eth_getBlockByNumber") {
    const tag = typeof params?.[0] === "string" ? params[0].toLowerCase() : "";
    return tag && !["latest", "pending", "safe", "finalized", "earliest"].includes(tag)
      ? null
      : tag === "latest"
        ? 1_000
        : undefined;
  }
  if (method === "eth_getTransactionReceipt") return null;
  if (method === "eth_call") {
    const tag = blockTag(params);
    if (tag && /^0x[0-9a-f]+$/.test(tag)) return null;
    if (tag === "latest") return 2_000;
    return undefined;
  }
  if (method === "eth_blockNumber") return 1_000;
  return undefined;
}

function shouldCacheResponse(request: RpcRequest, value: unknown): boolean {
  if (
    request.method === "eth_getTransactionReceipt" ||
    request.method === "eth_getBlockByNumber" ||
    request.method === "eth_getBlockByHash"
  ) {
    return value !== null && value !== undefined;
  }
  return true;
}

function errorChain(error: unknown): unknown[] {
  const chain: unknown[] = [];
  let current = error;
  for (let i = 0; i < 8 && current !== undefined && current !== null; i += 1) {
    chain.push(current);
    current = typeof current === "object" ? (current as { cause?: unknown }).cause : undefined;
  }
  return chain;
}

function errorProperty(error: unknown, property: string): unknown {
  if (!error || typeof error !== "object") return undefined;
  return (error as Record<string, unknown>)[property];
}

function errorText(error: unknown): string {
  return errorChain(error)
    .map((item) => {
      if (item instanceof Error) return `${item.name} ${item.message}`;
      return String(item);
    })
    .join(" ")
    .toLowerCase();
}

function safeRpcError(error: unknown, secrets: readonly string[]): Error {
  const chain = errorChain(error);
  const message = chain
    .map((item) => {
      if (item instanceof Error) return item.message;
      if (typeof item === "object" && item !== null) {
        const record = item as Record<string, unknown>;
        if (typeof record.shortMessage === "string") return record.shortMessage;
        if (typeof record.message === "string") return record.message;
      }
      return "";
    })
    .find((candidate) => candidate.length > 0) ?? "RPC request failed";

  let sanitized = message.replace(/https?:\/\/[^\s)'"<>]+/gi, "[URL]");
  for (const secret of secrets) {
    if (secret) sanitized = sanitized.split(secret).join("[REDACTED]");
  }
  sanitized = sanitized.replace(
    /(api[_-]?key|token|secret)\s*[=:]\s*[^\s,;]+/gi,
    "$1=[REDACTED]",
  );
  const safeError = new Error(sanitized.slice(0, 1_000));
  safeError.name = "RpcError";

  const code = chain
    .map((item) => errorProperty(item, "code"))
    .find((candidate): candidate is number =>
      typeof candidate === "number" && Number.isSafeInteger(candidate),
    );
  const data = chain
    .map((item) => {
      const value = errorProperty(item, "data");
      if (typeof value === "string") return value;
      return errorProperty(value, "data");
    })
    .find(
      (candidate): candidate is string =>
        typeof candidate === "string" && /^0x(?:[0-9a-f]{2})*$/i.test(candidate),
    );

  if (code !== undefined) Object.assign(safeError, { code });
  if (data !== undefined) Object.assign(safeError, { data });
  return safeError;
}

function isExecutionError(error: unknown): boolean {
  return errorChain(error).some((item) => {
    const code = errorProperty(item, "code");
    const message = errorProperty(item, "shortMessage") ?? errorProperty(item, "message");
    return (
      (code === 3 || code === -32000) &&
      typeof message === "string" &&
      /execution reverted|revert|call exception/i.test(message)
    );
  });
}

function isTransientTransportError(error: unknown): boolean {
  if (isExecutionError(error)) return false;

  for (const item of errorChain(error)) {
    for (const key of ["status", "statusCode"]) {
      const status = errorProperty(item, key);
      if (typeof status === "number" && (status === 429 || status >= 500)) return true;
    }
  }

  const text = errorText(error);
  return (
    /\b429\b|\b5\d\d\b|timeout|timed out|network error|fetch failed|econn|socket hang up|connection reset/.test(
      text,
    )
  );
}

function emptyCounters(): Counters {
  return { requests: 0, estimatedCu: 0, cacheHits: 0, errors: 0 };
}

function methodCu(method: string): number {
  return CU_BY_METHOD[method] ?? 20;
}

function rpcError(message: string): Error {
  return new Error(message);
}

export interface RpcPoolOptions {
  readonly requestFactory?: RpcRequestFactory;
  readonly fetchFn?: typeof fetch;
  readonly now?: () => number;
}

export interface RpcEndpointStats {
  readonly id: string;
  readonly kind: RpcEndpointKind;
  readonly cooling: boolean;
  readonly coolDownMs: number;
  readonly classes: Readonly<Record<RpcCallClass, Counters>>;
}

export interface RpcPoolStats {
  readonly date: string;
  readonly endpoints: readonly RpcEndpointStats[];
  readonly classes: Readonly<Record<RpcCallClass, Counters>>;
}

export class RpcPool {
  private readonly endpoints: Endpoint[];
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, Promise<unknown>>();
  private readonly endpointCounters = new Map<string, Record<RpcCallClass, Counters>>();
  private readonly classCounters: Record<RpcCallClass, Counters> = {
    logs: emptyCounters(),
    state: emptyCounters(),
    tx: emptyCounters(),
  };
  private readonly now: () => number;
  private alchemyCursor = 0;
  private metricsDate = utcDateKey();
  private reportTimer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly config: RuntimeConfig, options: RpcPoolOptions = {}) {
    this.now = options.now ?? Date.now;
    const requestFactory =
      options.requestFactory ?? ((endpoint) => defaultRequestFactory(endpoint, options.fetchFn));
    if (config.RPC_URL_OVERRIDE.trim()) {
      this.endpoints = [
        this.makeEndpoint(
          { id: "override", kind: "override", url: config.RPC_URL_OVERRIDE.trim() },
          requestFactory,
        ),
      ];
    } else {
      const publicEndpoint = this.makeEndpoint(
        { id: "public", kind: "public", url: config.PUBLIC_RPC_URL },
        requestFactory,
      );
      const alchemyEndpoints = config.ALCHEMY_API_KEYS.map((key, index) =>
        this.makeEndpoint(
          {
            id: `alchemy#${index + 1}`,
            kind: "alchemy",
            url: config.ALCHEMY_URL_TEMPLATE.replace("{key}", key),
          },
          requestFactory,
        ),
      );
      this.endpoints = [publicEndpoint, ...alchemyEndpoints];
    }

    for (const endpoint of this.endpoints) {
      this.endpointCounters.set(endpoint.id, {
        logs: emptyCounters(),
        state: emptyCounters(),
        tx: emptyCounters(),
      });
    }
  }

  private makeEndpoint(info: RpcEndpointInfo, requestFactory: RpcRequestFactory): Endpoint {
    return {
      ...info,
      request: requestFactory(info),
      coolUntil: 0,
      failures: 0,
    };
  }

  transport(callClass: RpcCallClass): Transport {
    return custom({
      request: ({ method, params }: { method: string; params?: readonly unknown[] }) =>
        this.request(callClass, params === undefined ? { method } : { method, params }),
    }, { retryCount: 0 });
  }

  async request(callClass: RpcCallClass, request: RpcRequest): Promise<unknown> {
    this.resetDailyCountersIfNeeded();
    const lifetime = cacheLifetime(callClass, request);
    const key = cacheKey(request);
    if (lifetime !== undefined) {
      const cached = this.cache.get(key);
      if (cached && (cached.expiresAt === null || cached.expiresAt > this.now())) {
        this.cache.delete(key);
        this.cache.set(key, cached);
        this.recordCacheHit(callClass);
        return cached.value;
      }
      if (cached) this.cache.delete(key);
    }

    const dedupeKey = NO_DEDUPE_METHODS.has(request.method) ? undefined : `${callClass}:${key}`;
    if (dedupeKey) {
      const pending = this.inFlight.get(dedupeKey);
      if (pending) {
        this.recordCacheHit(callClass);
        return pending;
      }
    }

    const work = this.requestWithFailover(callClass, request).then((value) => {
      if (lifetime !== undefined && shouldCacheResponse(request, value)) {
        this.cacheSet(key, {
          value,
          expiresAt: lifetime === null ? null : this.now() + lifetime,
        });
      }
      return value;
    });

    if (!dedupeKey) return work;
    this.inFlight.set(dedupeKey, work);
    try {
      return await work;
    } finally {
      if (this.inFlight.get(dedupeKey) === work) this.inFlight.delete(dedupeKey);
    }
  }

  /**
   * Send a group of independent JSON-RPC calls together through the same
   * endpoint. The default HTTP transport batches concurrent requests, while
   * this wrapper keeps the group on one route endpoint and accounts for each
   * JSON-RPC method separately.
   */
  async requestBatch(callClass: RpcCallClass, requests: readonly RpcRequest[]): Promise<unknown[]> {
    if (requests.length === 0) return [];

    const route = this.route(callClass);
    const attempted = new Set<string>();
    const now = this.now();
    const healthy = route.filter((endpoint) => endpoint.coolUntil <= now);
    const candidates = healthy.length ? healthy : route;

    for (const endpoint of candidates) {
      if (attempted.has(endpoint.id)) continue;
      attempted.add(endpoint.id);
      if (endpoint.coolUntil > this.now()) continue;

      for (const request of requests) this.recordRequest(callClass, endpoint, request.method);
      try {
        // Calling the same endpoint transport concurrently lets viem's HTTP
        // batch scheduler emit one JSON-RPC array while preserving response
        // ordering for callers.
        const results = await Promise.all(requests.map((request) => endpoint.request(request)));
        endpoint.failures = 0;
        endpoint.coolUntil = 0;
        return results;
      } catch (error) {
        for (const _request of requests) this.recordError(callClass, endpoint);
        if (isExecutionError(error) || !isTransientTransportError(error)) {
          throw safeRpcError(error, this.config.ALCHEMY_API_KEYS);
        }
        this.cool(endpoint);
      }
    }

    const last = route.find((endpoint) => attempted.has(endpoint.id));
    throw rpcError(
      last
        ? `All RPC endpoints for ${callClass} are cooling after transient failures (last: ${last.id})`
        : `No RPC endpoints are configured for ${callClass}`,
    );
  }

  private async requestWithFailover(
    callClass: RpcCallClass,
    request: RpcRequest,
  ): Promise<unknown> {
    const route = this.route(callClass);
    const attempted = new Set<string>();
    const now = this.now();
    const healthy = route.filter((endpoint) => endpoint.coolUntil <= now);
    const candidates = healthy.length ? healthy : route;

    for (const endpoint of candidates) {
      if (attempted.has(endpoint.id)) continue;
      attempted.add(endpoint.id);
      if (endpoint.coolUntil > this.now()) continue;
      this.recordRequest(callClass, endpoint, request.method);
      try {
        const result = await endpoint.request(request);
        endpoint.failures = 0;
        endpoint.coolUntil = 0;
        return result;
      } catch (error) {
        this.recordError(callClass, endpoint);
        if (isExecutionError(error) || !isTransientTransportError(error)) {
          throw safeRpcError(error, this.config.ALCHEMY_API_KEYS);
        }
        this.cool(endpoint);
      }
    }

    const last = route.find((endpoint) => attempted.has(endpoint.id));
    throw rpcError(
      last
        ? `All RPC endpoints for ${callClass} are cooling after transient failures (last: ${last.id})`
        : `No RPC endpoints are configured for ${callClass}`,
    );
  }

  private route(callClass: RpcCallClass): Endpoint[] {
    if (this.endpoints[0]?.kind === "override") return this.endpoints;

    const routeKinds =
      callClass === "logs"
        ? this.config.RPC_ROUTE_LOGS
        : callClass === "state"
          ? this.config.RPC_ROUTE_STATE
          : this.config.RPC_ROUTE_TX;
    const ordered: Endpoint[] = [];
    const publicEndpoints = this.endpoints.filter((endpoint) => endpoint.kind === "public");
    const alchemyEndpoints = this.endpoints.filter((endpoint) => endpoint.kind === "alchemy");

    for (const kind of routeKinds) {
      if (kind === "public") ordered.push(...publicEndpoints);
      if (kind === "alchemy" && alchemyEndpoints.length > 0) {
        const start = this.alchemyCursor % alchemyEndpoints.length;
        ordered.push(
          ...alchemyEndpoints.slice(start),
          ...alchemyEndpoints.slice(0, start),
        );
      }
    }

    return ordered.length > 0 ? ordered : publicEndpoints;
  }

  private cool(endpoint: Endpoint): void {
    endpoint.failures += 1;
    const backoff = Math.min(60_000 * 2 ** Math.min(endpoint.failures - 1, 10), MAX_COOLDOWN_MS);
    endpoint.coolUntil = this.now() + backoff;
    if (endpoint.kind === "alchemy") {
      const alchemyEndpoints = this.endpoints.filter((item) => item.kind === "alchemy");
      const index = alchemyEndpoints.findIndex((item) => item.id === endpoint.id);
      if (index >= 0 && alchemyEndpoints.length > 0) {
        this.alchemyCursor = (index + 1) % alchemyEndpoints.length;
      }
    }
  }

  private cacheSet(key: string, entry: CacheEntry): void {
    this.cache.delete(key);
    this.cache.set(key, entry);
    if (this.cache.size > CACHE_LIMIT) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
  }

  private resetDailyCountersIfNeeded(): void {
    const date = utcDateKey(new Date(this.now()));
    if (date === this.metricsDate) return;
    this.metricsDate = date;
    for (const counters of Object.values(this.classCounters)) Object.assign(counters, emptyCounters());
    for (const byClass of this.endpointCounters.values()) {
      for (const counters of Object.values(byClass)) Object.assign(counters, emptyCounters());
    }
  }

  private recordCacheHit(callClass: RpcCallClass): void {
    this.classCounters[callClass].cacheHits += 1;
  }

  private recordRequest(callClass: RpcCallClass, endpoint: Endpoint, method: string): void {
    this.classCounters[callClass].requests += 1;
    this.classCounters[callClass].estimatedCu += methodCu(method);
    const counters = this.endpointCounters.get(endpoint.id)?.[callClass];
    if (counters) {
      counters.requests += 1;
      counters.estimatedCu += methodCu(method);
    }

    if (endpoint.kind === "alchemy") {
      const alchemyEndpoints = this.endpoints.filter((item) => item.kind === "alchemy");
      const index = alchemyEndpoints.findIndex((item) => item.id === endpoint.id);
      if (index >= 0 && alchemyEndpoints.length > 0) {
        this.alchemyCursor = (index + 1) % alchemyEndpoints.length;
      }
    }
  }

  private recordError(callClass: RpcCallClass, endpoint: Endpoint): void {
    this.classCounters[callClass].errors += 1;
    const counters = this.endpointCounters.get(endpoint.id)?.[callClass];
    if (counters) counters.errors += 1;
  }

  stats(): RpcPoolStats {
    this.resetDailyCountersIfNeeded();
    const now = this.now();
    const copyCounters = (counters: Counters): Counters => ({ ...counters });
    return {
      date: this.metricsDate,
      endpoints: this.endpoints.map((endpoint) => ({
        id: endpoint.id,
        kind: endpoint.kind,
        cooling: endpoint.coolUntil > now,
        coolDownMs: Math.max(0, endpoint.coolUntil - now),
        classes: {
          logs: copyCounters(this.endpointCounters.get(endpoint.id)?.logs ?? emptyCounters()),
          state: copyCounters(this.endpointCounters.get(endpoint.id)?.state ?? emptyCounters()),
          tx: copyCounters(this.endpointCounters.get(endpoint.id)?.tx ?? emptyCounters()),
        },
      })),
      classes: {
        logs: copyCounters(this.classCounters.logs),
        state: copyCounters(this.classCounters.state),
        tx: copyCounters(this.classCounters.tx),
      },
    };
  }

  startHourlyReporter(): void {
    if (this.reportTimer) return;
    let lastHour = new Date(this.now()).toISOString().slice(0, 13);
    this.reportTimer = setInterval(() => {
      const hour = new Date(this.now()).toISOString().slice(0, 13);
      if (hour === lastHour) return;
      lastHour = hour;
      logger.info({ rpcPool: this.stats() }, "Hourly RPC pool summary");
    }, 60_000);
    this.reportTimer.unref?.();
  }
}

export function createRpcPool(config: RuntimeConfig, options?: RpcPoolOptions): RpcPool {
  return new RpcPool(config, options);
}
