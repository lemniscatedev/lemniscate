import type { Address } from "viem";
import { createPayingFetch } from "../x402/pay";
import { createAgentRuntime, envPolicyReader, viemExecutor, type AgentRuntime, type Executor, type PolicyReader } from "./agent";
import { createApiClient, type ApiClient } from "./api-client";
import type { McpSettings } from "./config";
import { createKeyedLimiter } from "./rate-limit";
import { createMcpServer } from "./server";

export { loadMcpSettings } from "./config";
export { createMcpServer, toolListing } from "./server";
export { createMcpHttpApp } from "./http";
export { runStdio, stdinLines } from "./stdio";
export { TOOLS, TOOL_NAMES } from "./tools";

export interface McpOverrides {
  readonly fetch?: typeof fetch;
  readonly api?: ApiClient;
  readonly executor?: Executor;
  readonly policy?: PolicyReader;
  readonly now?: () => number;
}

/** Wire settings into a running server. The agent key is held only inside the AgentRuntime's account. */
export function buildMcp(settings: McpSettings, overrides: McpOverrides = {}) {
  let agent: AgentRuntime | undefined;
  let baseFetch = overrides.fetch ?? fetch;
  if (settings.agentKey) {
    agent = createAgentRuntime({
      key: settings.agentKey, owner: settings.owner, router: settings.router,
      policy: overrides.policy ?? envPolicyReader(settings.policy),
      executor: (account) => overrides.executor ?? viemExecutor({ rpcUrl: settings.rpcUrl, chainId: settings.chainId, account }),
      ...(overrides.now ? { now: overrides.now } : {}),
    });
    // Paid data endpoints (x402): the agent pays up to the per-call limit from its own address.
    baseFetch = createPayingFetch(baseFetch, agent.account, { chainId: settings.chainId, maxAmount: settings.x402MaxPerCall });
  }
  const api = overrides.api ?? createApiClient(settings.apiUrl, baseFetch);
  const limiter = createKeyedLimiter({ limit: settings.rateLimitPerMinute, windowMs: 60_000, ...(overrides.now ? { now: overrides.now } : {}) });
  const server = createMcpServer({ context: { api, agent, defaultOwner: settings.owner as Address | undefined, router: settings.router }, limiter });
  return { server, agent };
}
