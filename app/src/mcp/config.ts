import { parseUnits, type Address, type Hex } from "viem";
import { z } from "zod";
import { KEY_ROLES, KeyConfigError, resolveKey } from "../keys";

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);

const policySchema = z.object({
  owner: address,
  budgetUsdg: z.string().regex(/^\d+$/),
  spentUsdg: z.string().regex(/^\d+$/).default("0"),
  maxPerTradeUsdg: z.string().regex(/^\d+$/),
  expiresAt: z.number().int().nonnegative(),
  canSell: z.boolean().default(false),
  canShield: z.boolean().default(false),
  revoked: z.boolean().default(false),
  stocks: z.array(address).default([]),
});
export type PolicyMirror = z.infer<typeof policySchema>;

const schema = z.object({
  LMNS_API_URL: z.string().url().default("http://127.0.0.1:3101"),
  // The agent key (AGENT_KEY, or AGENT_KEYSTORE + AGENT_KEYSTORE_PASSWORD_FILE) is read by keys.ts. Never logged, never returned by a tool.
  AGENT_OWNER: address.optional(),
  AGENT_ROUTER: address.optional(),
  AGENT_RPC_URL: z.string().url().default("https://rpc.mainnet.chain.robinhood.com"),
  AGENT_CHAIN_ID: z.coerce.number().int().positive().default(4663),
  AGENT_POLICY: z.string().optional(),
  MCP_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(0).default(60),
  MCP_HTTP_HOST: z.string().default("127.0.0.1"),
  MCP_HTTP_PORT: z.coerce.number().int().min(1).max(65535).default(3102),
  MCP_HTTP_TOKEN: z.string().min(16).optional(),
  MCP_ALLOWED_ORIGINS: z.string().default(""),
  X402_MAX_PER_CALL_USDG: z.string().regex(/^\d{1,6}(\.\d{1,6})?$/).default("0.02"),
});

export interface McpSettings {
  readonly apiUrl: string;
  readonly agentKey: Hex | undefined;
  readonly owner: Address | undefined;
  readonly router: Address | undefined;
  readonly rpcUrl: string;
  readonly chainId: number;
  readonly policy: PolicyMirror | undefined;
  readonly rateLimitPerMinute: number;
  readonly httpHost: string;
  readonly httpPort: number;
  readonly httpToken: string | undefined;
  readonly allowedOrigins: readonly string[];
  readonly x402MaxPerCall: bigint;
}

export function loadMcpSettings(source: Record<string, string | undefined> = process.env): McpSettings {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    // Issue paths only: values (a key, a token) must not reach an error message.
    throw new Error(`Invalid MCP configuration: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }
  const v = parsed.data;
  let agentKey: Hex | undefined;
  try {
    agentKey = resolveKey(KEY_ROLES.agent, source);
  } catch (error) {
    if (error instanceof KeyConfigError) throw new Error(`Invalid MCP configuration: ${error.message}`);
    throw error;
  }
  let policy: PolicyMirror | undefined;
  if (v.AGENT_POLICY) {
    try { policy = policySchema.parse(JSON.parse(v.AGENT_POLICY)); }
    catch { throw new Error("Invalid MCP configuration: AGENT_POLICY must be JSON with owner, budgetUsdg, maxPerTradeUsdg, expiresAt (raw USDG, 6 dp)"); }
  }
  return {
    apiUrl: v.LMNS_API_URL.replace(/\/+$/, ""), agentKey,
    owner: (v.AGENT_OWNER ?? policy?.owner) as Address | undefined, router: v.AGENT_ROUTER as Address | undefined,
    rpcUrl: v.AGENT_RPC_URL, chainId: v.AGENT_CHAIN_ID, policy, rateLimitPerMinute: v.MCP_RATE_LIMIT_PER_MINUTE,
    httpHost: v.MCP_HTTP_HOST, httpPort: v.MCP_HTTP_PORT, httpToken: v.MCP_HTTP_TOKEN,
    allowedOrigins: v.MCP_ALLOWED_ORIGINS.split(",").map((o) => o.trim()).filter(Boolean),
    x402MaxPerCall: parseUnits(v.X402_MAX_PER_CALL_USDG, 6),
  };
}
