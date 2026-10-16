import type { Hono } from "hono";
import type { Address } from "viem";
import { loadX402Settings, type X402Settings } from "./config";
import { createGate, viemSettler, type X402Gate } from "./gate";

export { loadX402Settings, DEFAULT_PRICES_USDG } from "./config";
export { createGate, viemSettler } from "./gate";
export type { X402Gate, Settler } from "./gate";
export { signPayment, createPayingFetch } from "./pay";

/** Build the gate from env, or undefined when x402 is off (the default). */
export function createX402FromEnv(
  deployment: { chainId: number; contracts: { usdg: string } },
  rpcFallback: string,
  source: Record<string, string | undefined> = process.env,
): X402Gate | undefined {
  const settings: X402Settings = loadX402Settings(source);
  if (!settings.enabled) return undefined;
  const settler = viemSettler({
    rpcUrl: settings.rpcUrl ?? rpcFallback, chainId: deployment.chainId, key: settings.settlerKey!,
  });
  const gate = createGate({
    chainId: deployment.chainId, usdg: deployment.contracts.usdg as Address, payTo: settings.payTo!, settler,
    routes: settings.routes, challengeTtlSeconds: settings.challengeTtlSeconds, freeOrigins: settings.freeOrigins,
    ...(settings.nonceSecret ? { nonceSecret: settings.nonceSecret } : {}),
    verifySignature: async ({ owner, typedData, signature }) => settler.publicClient.verifyTypedData({ address: owner, ...typedData, signature }),
  });
  return { ...gate, routes: settings.routes };
}

/** Put the paywall in front of the paid GET routes. Call before the routes are registered. */
export function registerX402(app: Hono<any, any, any>, gate: X402Gate): void {
  for (const route of gate.routes) app.use(route.pattern, gate.middleware(route));
}
