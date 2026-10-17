import { parseUnits, type Address, type Hex } from "viem";
import { z } from "zod";
import { KEY_ROLES, KeyConfigError, resolveKey } from "../keys";

/** Default per-call prices in USDG (6 decimals), inside the $0.001 to $0.01 band. Override with X402_PRICE_*. */
export const DEFAULT_PRICES_USDG = { vol: "0.002", chains: "0.005", pool: "0.003" } as const;

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const price = (fallback: string) => z.string().default(fallback).refine((v) => /^\d{1,6}(\.\d{1,6})?$/.test(v) && Number(v) > 0, "expected a positive USDG amount with at most 6 decimals");

const schema = z.object({
  X402_ENABLED: z.enum(["0", "1"]).default("0").transform((v) => v === "1"),
  X402_PAY_TO: address.optional(),
  X402_RPC_URL: z.string().url().optional(),
  X402_NONCE_SECRET: z.string().regex(/^0x[0-9a-fA-F]{32,}$/).optional(),
  X402_CHALLENGE_TTL_SECONDS: z.coerce.number().int().min(30).max(3_600).default(300),
  /** Removed (F41): an Origin header is client-controlled and proves nothing. Setting it is a startup error. */
  X402_FREE_ORIGINS: z.string().default(""),
  /** Secret the website's own server sends in `x-lmns-internal` to read the paid routes free. At least 24 characters. */
  X402_INTERNAL_TOKEN: z.string().min(24).optional(),
  X402_PRICE_VOL: price(DEFAULT_PRICES_USDG.vol),
  X402_PRICE_CHAINS: price(DEFAULT_PRICES_USDG.chains),
  X402_PRICE_POOL: price(DEFAULT_PRICES_USDG.pool),
});

export interface PaidRoute {
  /** Hono path pattern. */
  readonly pattern: string;
  readonly description: string;
  /** Raw USDG (6 dp). */
  readonly amount: bigint;
}

export interface X402Settings {
  readonly enabled: boolean;
  readonly payTo: Address | undefined;
  readonly settlerKey: Hex | undefined;
  readonly rpcUrl: string | undefined;
  readonly nonceSecret: Hex | undefined;
  readonly challengeTtlSeconds: number;
  readonly internalToken: string | undefined;
  readonly routes: readonly PaidRoute[];
}

/** Free: health, config, chain list. Paid: vol detail, full chains with Greeks, pool exposures. */
export function loadX402Settings(source: Record<string, string | undefined> = process.env): X402Settings {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    throw new Error(`Invalid x402 configuration: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }
  const v = parsed.data;
  if (v.X402_FREE_ORIGINS.trim()) {
    throw new Error("Invalid x402 configuration: X402_FREE_ORIGINS was removed because a request's Origin header can be forged. Serve the website through its own server and set X402_INTERNAL_TOKEN instead");
  }
  // X402_SETTLER_KEY (development) or X402_SETTLER_KEYSTORE + X402_SETTLER_KEYSTORE_PASSWORD_FILE (the only form production accepts).
  let settlerKey: Hex | undefined;
  try {
    settlerKey = resolveKey(KEY_ROLES.x402Settler, source);
  } catch (error) {
    if (error instanceof KeyConfigError) throw new Error(`Invalid x402 configuration: ${error.message}`);
    throw error;
  }
  if (v.X402_ENABLED && (!v.X402_PAY_TO || !settlerKey)) {
    throw new Error("Invalid x402 configuration: X402_ENABLED=1 needs X402_PAY_TO and the settler key (X402_SETTLER_KEY or X402_SETTLER_KEYSTORE)");
  }
  return {
    enabled: v.X402_ENABLED,
    payTo: v.X402_PAY_TO as Address | undefined,
    settlerKey,
    rpcUrl: v.X402_RPC_URL,
    nonceSecret: v.X402_NONCE_SECRET as Hex | undefined,
    challengeTtlSeconds: v.X402_CHALLENGE_TTL_SECONDS,
    internalToken: v.X402_INTERNAL_TOKEN,
    routes: [
      { pattern: "/v1/vol/:name", description: "Volatility inputs and posts for one name", amount: parseUnits(v.X402_PRICE_VOL, 6) },
      { pattern: "/v1/chains/:name", description: "Option chain with bid, ask and Greeks for one name", amount: parseUnits(v.X402_PRICE_CHAINS, 6) },
      { pattern: "/v1/pool", description: "Writer Pool NAV, exposures and caps usage", amount: parseUnits(v.X402_PRICE_POOL, 6) },
    ],
  };
}
