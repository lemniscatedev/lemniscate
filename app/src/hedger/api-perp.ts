import { createPrivateKey, sign, type KeyObject } from "node:crypto";
import type { Address } from "viem";
import { abs, type HedgeFill, type IHedgeVenue } from "./types";

/** An off-chain order-book perp venue (Arcus, Lighter): an HTTP API client authenticated with an Ed25519 key.
 * The request paths and field names below are UNVERIFIED placeholders: Arcus and Lighter publish REST docs but we have
 * no account, so nothing here has run against a real exchange. It is disabled unless HEDGER_PERP_ENABLED=1 and the
 * key variables are set, and every test uses an injected fetch. Do not enable it before the endpoints are checked. */
export interface ApiPerpOptions {
  name?: string;
  baseUrl: string;
  apiKeyId: string;
  /** 32-byte Ed25519 seed, hex. Never logged. */
  seedHex: string;
  /** stock token address (lower case) -> market symbol, e.g. NVDA-USD. */
  markets: ReadonlyMap<string, string>;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

export class ApiPerpVenue implements IHedgeVenue {
  readonly name: string;
  readonly canShort = true;
  private readonly key: KeyObject;
  private readonly http: typeof fetch;
  constructor(private readonly options: ApiPerpOptions) {
    this.name = options.name ?? "arcus";
    if (!/^[0-9a-fA-F]{64}$/.test(options.seedHex)) throw new Error("perp venue seed must be 32 bytes of hex");
    this.key = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, Buffer.from(options.seedHex, "hex")]), format: "der", type: "pkcs8" });
    this.http = options.fetchImpl ?? fetch;
  }

  toString(): string { return `ApiPerpVenue(${this.name})`; }
  toJSON(): { name: string } { return { name: this.name }; }

  private async call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    const timestamp = String((this.options.now ?? Date.now)());
    const payload = body === undefined ? "" : JSON.stringify(body);
    const signature = sign(null, Buffer.from(`${timestamp}${method}${path}${payload}`), this.key).toString("base64");
    const response = await this.http(`${this.options.baseUrl}${path}`, {
      method,
      headers: { "content-type": "application/json", "x-api-key": this.options.apiKeyId, "x-timestamp": timestamp, "x-signature": signature },
      ...(body === undefined ? {} : { body: payload }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`${this.name} ${method} ${path} failed with HTTP ${response.status}`);
    return (await response.json()) as T;
  }

  private market(stock: Address): string {
    const symbol = this.options.markets.get(stock.toLowerCase());
    if (!symbol) throw new Error(`${this.name}: no market for ${stock}`);
    return symbol;
  }

  async netPosition(stock: Address): Promise<bigint> {
    const symbol = this.market(stock);
    const result = await this.call<{ positions: { market: string; size: string }[] }>("GET", "/v1/positions");
    const found = result.positions.find((p) => p.market === symbol);
    return found ? decimalToUnits(found.size, 18) : 0n;
  }

  async equityUsdg(): Promise<bigint> {
    const result = await this.call<{ equity: string }>("GET", "/v1/account");
    return decimalToUnits(result.equity, 6);
  }

  async healthy(): Promise<boolean> {
    try {
      const result = await this.call<{ markets: unknown[] }>("GET", "/v1/markets");
      return Array.isArray(result.markets) && result.markets.length > 0;
    } catch { return false; }
  }

  async trade(stock: Address, deltaUnits: bigint, maxSlippageBps: number): Promise<HedgeFill> {
    const result = await this.call<{ id: string; filled: string; avgPrice: string }>("POST", "/v1/orders", {
      market: this.market(stock), side: deltaUnits > 0n ? "buy" : "sell", size: unitsToDecimal(abs(deltaUnits), 18),
      type: "market_ioc", maxSlippageBps,
    });
    const filledAbs = decimalToUnits(result.filled, 18);
    return { ref: result.id, filled: deltaUnits > 0n ? filledAbs : -filledAbs, px: decimalToUnits(result.avgPrice, 6) };
  }
}

export function decimalToUnits(value: string, decimals: number): bigint {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!match) throw new Error(`not a decimal: ${value}`);
  const fraction = (match[3] ?? "").padEnd(decimals, "0").slice(0, decimals);
  const units = BigInt(match[2]! + fraction);
  return match[1] ? -units : units;
}

export function unitsToDecimal(value: bigint, decimals: number): string {
  const scale = 10n ** BigInt(decimals);
  return `${value / scale}.${(value % scale).toString().padStart(decimals, "0")}`;
}

