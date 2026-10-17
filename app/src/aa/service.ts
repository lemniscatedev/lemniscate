import type { Address } from "viem";
import { createHttpBundler } from "./bundler";
import { createViemAaChain } from "./chain";
import { loadAaConfig, type AaConfig } from "./config";
import { createSponsor } from "./paymaster";
import type { AaServices } from "./userop";

export interface ServiceOptions {
  readonly rpcUrl: string;
  readonly engine: Address;
  readonly usdg: Address;
  readonly agentRouter?: Address | undefined;
  readonly env?: Record<string, string | undefined>;
  /** Cap on the chain reads this service may make per second in total (F32). */
  readonly rpcCallsPerSecond?: number;
}

/** Wires the production services: viem chain reads, an HTTP bundler (any v0.7 bundler) and the sponsor, if configured. */
export function createAaServices(options: ServiceOptions): AaServices {
  const config: AaConfig = loadAaConfig(options.env);
  return {
    config,
    chain: createViemAaChain(options.rpcUrl, options.rpcCallsPerSecond ? { callsPerSecond: options.rpcCallsPerSecond, burst: Math.max(10, options.rpcCallsPerSecond * 2) } : {}),
    bundler: createHttpBundler({ url: config.bundlerUrl, timeoutMs: config.bundlerTimeoutMs }),
    sponsor: config.paymaster
      ? createSponsor({ ...config.paymaster, signerKey: config.paymaster.signerKey, chainId: config.chainId })
      : null,
    policy: { engine: options.engine, usdg: options.usdg, agentRouter: options.agentRouter },
    now: Date.now,
  };
}
