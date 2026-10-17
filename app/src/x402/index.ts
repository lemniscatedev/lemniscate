import type { Hono } from "hono";
import type { Address } from "viem";
import { loadX402Settings, type X402Settings } from "./config";
import { createGate, viemSettler, type X402Gate } from "./gate";

export { loadX402Settings, DEFAULT_PRICES_USDG } from "./config";
export { createGate, viemSettler } from "./gate";
export type { X402Gate, Settler } from "./gate";
export { signPayment, createPayingFetch } from "./pay";

/** A clock anchored to the chain: wall time plus the last measured (block time - wall time) offset. On an anvil fork moved
 * with evm_increaseTime the chain is days ahead of the wall clock, and a Permit2 deadline issued from wall time is
 * already past for the chain, so every settlement reverted. Unknown offset (no read yet, RPC down) means wall time. */
export function chainAnchoredClock(readBlockSeconds: () => Promise<number>, wallNow: () => number = Date.now) {
  let offsetMs = 0;
  return {
    now: () => wallNow() + offsetMs,
    async refresh(): Promise<void> {
      try { offsetMs = (await readBlockSeconds()) * 1000 - wallNow(); } catch { /* keep the last offset */ }
    },
  };
}

/** Build the gate from env, or undefined when x402 is off (the default). `chainClock` (the fork) issues challenge
 * deadlines in chain time; real networks keep wall time. */
export function createX402FromEnv(
  deployment: { chainId: number; contracts: { usdg: string } },
  rpcFallback: string,
  source: Record<string, string | undefined> = process.env,
  options: { chainClock?: boolean } = {},
): X402Gate | undefined {
  const settings: X402Settings = loadX402Settings(source);
  if (!settings.enabled) return undefined;
  const settler = viemSettler({
    rpcUrl: settings.rpcUrl ?? rpcFallback, chainId: deployment.chainId, key: settings.settlerKey!,
  });
  let now: (() => number) | undefined;
  if (options.chainClock) {
    const clock = chainAnchoredClock(async () => Number((await settler.publicClient.getBlock()).timestamp));
    void clock.refresh();
    setInterval(() => void clock.refresh(), 5_000).unref?.();
    now = clock.now;
  }
  const gate = createGate({
    ...(now ? { now } : {}),
    chainId: deployment.chainId, usdg: deployment.contracts.usdg as Address, payTo: settings.payTo!, settler,
    routes: settings.routes, challengeTtlSeconds: settings.challengeTtlSeconds,
    ...(settings.internalToken ? { internalToken: settings.internalToken } : {}),
    ...(settings.nonceSecret ? { nonceSecret: settings.nonceSecret } : {}),
    verifySignature: async ({ owner, typedData, signature }) => settler.publicClient.verifyTypedData({ address: owner, ...typedData, signature }),
  });
  return { ...gate, routes: settings.routes };
}

/** Put the paywall in front of the paid GET routes. Call before the routes are registered. */
export function registerX402(app: Hono<any, any, any>, gate: X402Gate): void {
  for (const route of gate.routes) app.use(route.pattern, gate.middleware(route));
}
