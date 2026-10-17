import type { OpenAPIHono } from "@hono/zod-openapi";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { isAddress, type Address, type Hex } from "viem";
import type { ApiDependencies } from "../types";
import { clientIp, rateLimit, rateLimitKey, walletsFromBody } from "../rate-limit";
import { createSponsorshipGate, type SponsorshipGate } from "../sponsorship";
import { createAaServices } from "../../aa/service";
import { AaConfigError } from "../../aa/config";
import { BundlerError, toRpcUserOp, type Op } from "../../aa/bundler";
import { AaError, buildUserOp, callsForIntent, hashOf, type AaServices, type IntentLike } from "../../aa/userop";
import { PAYMASTER_DATA_LENGTH } from "../../aa/paymaster";
import { KERNEL_V33_IMPLEMENTATION } from "../../aa/counterfactual";
import { optionalEnv } from "../../config";

/**
 * One-tap flows (todo 16): `POST /v1/intent/{buy,sell,shield}?format=userop` returns the same intent as an unsigned
 * ERC-4337 v0.7 UserOperation for a Kernel v3 smart account, batched as [approve USDG, engine call], with the hash to
 * sign. The plain transaction (`format` omitted) is untouched and stays the fallback for every flow.
 *
 * Also: `POST /v1/userop/send` relays a signed operation to the configured bundler, `GET /v1/userop/:hash` reports
 * its receipt, and `GET /v1/userop/config` describes the setup. The server never holds a user key: the owner signs
 * the returned hash and posts it back.
 */

const address = z.string().refine((value) => isAddress(value, { strict: false }), "Invalid EVM address")
  .transform((value) => value.toLowerCase() as Address);
const hexQuantity = z.string().regex(/^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/);
const hexData = z.string().regex(/^0x(?:[0-9a-fA-F]{2})*$/);

const extraSchema = z.object({
  account: address,
  owner: address.optional(),
  sponsor: z.boolean().default(true),
  nonceLane: z.number().int().min(0).max(65_535).default(0),
  accountIndex: z.number().int().min(0).max(1_000_000).default(0),
});

const intentSchema = z.object({
  kind: z.enum(["buy", "sell", "shield"]),
  to: address,
  data: hexData,
  approvals: z.array(z.object({ token: address, spender: address, amount: z.string().regex(/^\d+$/) })).max(3),
});

const rpcOpSchema = z.object({
  sender: address,
  nonce: hexQuantity,
  factory: address.optional(),
  factoryData: hexData.optional(),
  callData: hexData,
  callGasLimit: hexQuantity,
  verificationGasLimit: hexQuantity,
  preVerificationGas: hexQuantity,
  maxFeePerGas: hexQuantity,
  maxPriorityFeePerGas: hexQuantity,
  paymaster: address.optional(),
  paymasterVerificationGasLimit: hexQuantity.optional(),
  paymasterPostOpGasLimit: hexQuantity.optional(),
  paymasterData: hexData.optional(),
  signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/, "signature must be a 65-byte ECDSA signature"),
});

function fromRpc(value: z.infer<typeof rpcOpSchema>): Op {
  const op: Op = {
    sender: value.sender, nonce: BigInt(value.nonce), callData: value.callData as Hex,
    callGasLimit: BigInt(value.callGasLimit), verificationGasLimit: BigInt(value.verificationGasLimit),
    preVerificationGas: BigInt(value.preVerificationGas), maxFeePerGas: BigInt(value.maxFeePerGas),
    maxPriorityFeePerGas: BigInt(value.maxPriorityFeePerGas), signature: value.signature as Hex,
    ...(value.factory ? { factory: value.factory, factoryData: (value.factoryData ?? "0x") as Hex } : {}),
    ...(value.paymaster ? {
      paymaster: value.paymaster,
      paymasterVerificationGasLimit: BigInt(value.paymasterVerificationGasLimit ?? "0x0"),
      paymasterPostOpGasLimit: BigInt(value.paymasterPostOpGasLimit ?? "0x0"),
      paymasterData: (value.paymasterData ?? "0x") as Hex,
    } : {}),
  };
  return op;
}

const fail = (error: AaError) => ({ body: { error: error.apiError, message: error.message }, status: error.status });

type WithAa = ApiDependencies & { aa?: AaServices; sponsorship?: SponsorshipGate };

export function registerIntentUserOp(app: OpenAPIHono, deps: ApiDependencies): void {
  const contracts = deps.deployment.contracts;
  let cached: AaServices | undefined;
  let cachedGate: SponsorshipGate | undefined;
  const services = (): AaServices => {
    const injected = (deps as WithAa).aa;
    if (injected) return injected;
    if (cached) return cached;
    try {
      cached = createAaServices({
        // F32: its own node when one is configured, so account-abstraction reads never compete with the keeper's.
        rpcUrl: deps.config.AA_RPC_URL || deps.config.RPC_URL_OVERRIDE || deps.config.PUBLIC_RPC_URL,
        ...(deps.config.AA_RPC_CALLS_PER_SECOND ? { rpcCallsPerSecond: deps.config.AA_RPC_CALLS_PER_SECOND } : {}),
        engine: contracts.engine as Address, usdg: contracts.usdg as Address, agentRouter: contracts.agentRouter as Address | undefined,
      });
      return cached;
    } catch (error) {
      if (error instanceof AaConfigError) throw new AaError(503, "AA_UNAVAILABLE", "One-tap flows are not configured on this server. Use the plain transaction.");
      throw error;
    }
  };
  const gateFor = (svc: AaServices): SponsorshipGate => {
    const injected = (deps as WithAa).sponsorship;
    if (injected) return injected;
    return cachedGate ??= createSponsorshipGate({
      deps, chain: svc.chain, kernelValidator: svc.config.kernelValidator, usdg: contracts.usdg as Address,
      paymaster: svc.config.paymaster?.address,
      kernelImplementation: (optionalEnv("AA_KERNEL_IMPLEMENTATION") || KERNEL_V33_IMPLEMENTATION) as Address,
    });
  };
  const respondError = (error: unknown) => {
    if (error instanceof AaError) return fail(error);
    if (error instanceof BundlerError) {
      return { body: { error: "BUNDLER_ERROR", message: error.message.slice(0, 200) }, status: 502 as const };
    }
    throw error;
  };

  // --- ?format=userop on the intent routes ------------------------------------------------------------------
  app.use("/v1/intent/*", async (context, next) => {
    if (context.req.method !== "POST" || context.req.query("format") !== "userop") return next();
    context.header("Cache-Control", "no-store");
    const raw = await context.req.json().catch(() => null);
    const extra = extraSchema.safeParse(raw);
    // Anything the intent route itself rejects (bad series, bad amount) is reported by the intent route.
    await next();
    if (context.res.status !== 200) return;
    if (!extra.success) {
      const { body, status } = fail(new AaError(400, "BAD_REQUEST", "A userop intent needs `account` (the Kernel smart account address)."));
      context.res = Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
      return;
    }
    const parsed = intentSchema.safeParse(await context.res.clone().json());
    if (!parsed.success) {
      context.res = Response.json({ error: "INTERNAL_ERROR", message: "Internal server error." }, { status: 500 });
      return;
    }
    const intent = parsed.data as IntentLike;
    let ticket: number | undefined;
    const gate = { gate: undefined as SponsorshipGate | undefined };
    try {
      const svc = services();
      const plain = await context.res.clone().json() as Record<string, unknown>;
      // F25/F31: sponsorship is decided by policy before anything is signed. A denial is not an error: the same operation
      // comes back unsponsored and the user pays gas (or uses the plain transaction).
      let sponsorship: { requested: boolean; granted: boolean; reason?: string; message?: string } = { requested: extra.data.sponsor && svc.sponsor !== null, granted: false };
      if (sponsorship.requested) {
        gate.gate = gateFor(svc);
        const decision = await gate.gate.evaluate({
          kind: intent.kind, account: extra.data.account, owner: extra.data.owner,
          ipKey: rateLimitKey(clientIp(context, deps.config.API_CLIENT_IP_HEADER ?? "")), plain,
        });
        if (decision.granted) { ticket = decision.ticket; sponsorship = { requested: true, granted: true }; }
        else sponsorship = { requested: true, granted: false, reason: decision.reason, message: decision.message };
      }
      const built = await buildUserOp(svc, {
        account: extra.data.account, owner: extra.data.owner, calls: callsForIntent(intent), sponsor: ticket !== undefined,
        nonceLane: extra.data.nonceLane, accountIndex: extra.data.accountIndex,
      });
      context.res = Response.json({
        format: "userop" as const,
        kind: intent.kind,
        entryPoint: built.entryPoint, chainId: built.chainId,
        userOp: toRpcUserOp(built.userOp),
        userOpHash: built.userOpHash,
        sponsored: built.sponsored,
        sponsorship,
        deploysAccount: built.deploysAccount,
        gasEstimated: built.estimated,
        maxCostWei: built.maxCostWei.toString(),
        validUntil: built.validUntil,
        calls: callsForIntent(intent).map((call) => ({ to: call.to, value: call.value.toString(), data: call.data })),
        signing: {
          scheme: "kernel-v3-ecdsa-root",
          method: "personal_sign",
          message: built.userOpHash,
          note: "Sign the 32-byte userOpHash (EIP-191 personal_sign over the raw bytes) with the account owner key, put the 65-byte result in userOp.signature, then POST {userOp} to /v1/userop/send.",
        },
        submit: { method: "POST", path: "/v1/userop/send" },
        // The plain transaction for the same action: always valid, no smart account needed.
        fallback: plain,
      }, { status: 200, headers: { "Cache-Control": "no-store" } });
    } catch (error) {
      if (ticket !== undefined && gate.gate) await gate.gate.release(ticket);
      const { body, status } = respondError(error);
      context.res = Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
    }
  });

  // --- relay, receipt, config -----------------------------------------------------------------------------------
  const limiter = rateLimit({
    limit: deps.config.API_RATE_LIMIT_PER_MINUTE === 0 ? 0 : 60,
    windowMs: 60_000, clientIpHeader: deps.config.API_CLIENT_IP_HEADER,
    walletKeys: walletsFromBody([]),
  });
  app.use("/v1/userop/*", async (context, next) => { context.header("Cache-Control", "no-store"); await next(); });
  app.use("/v1/userop/send", bodyLimit({ maxSize: 16 * 1024 }));
  app.on(["POST"], "/v1/userop/send", limiter);

  app.get("/v1/userop/config", (context) => {
    try {
      const { config, sponsor, policy } = services();
      return context.json({
        chainId: config.chainId, entryPoint: config.entryPoint, kernelFactory: config.kernelFactory,
        kernelValidator: config.kernelValidator, kernelVersion: "3.3",
        paymaster: sponsor ? sponsor.address : null, sponsoring: sponsor !== null,
        sponsoredTargets: [policy.engine, ...(policy.agentRouter ? [policy.agentRouter] : [])],
        paymasterDataLength: PAYMASTER_DATA_LENGTH,
      });
    } catch (error) {
      const { body, status } = respondError(error);
      return context.json(body, status);
    }
  });

  app.post("/v1/userop/send", async (context) => {
    const parsed = z.object({ userOp: rpcOpSchema }).safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) return context.json({ error: "BAD_REQUEST", message: "Body must be {userOp} with a 65-byte signature." }, 400);
    try {
      const svc = services();
      const op = fromRpc(parsed.data.userOp);
      const bundlerHash = await svc.bundler.sendUserOperation(op, svc.config.entryPoint);
      return context.json({ userOpHash: hashOf(op, svc), bundlerHash, status: "submitted" as const }, 200);
    } catch (error) {
      const { body, status } = respondError(error);
      return context.json(body, status);
    }
  });

  app.get("/v1/userop/:hash", async (context) => {
    const hash = context.req.param("hash");
    if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) return context.json({ error: "BAD_REQUEST", message: "Invalid user operation hash." }, 400);
    try {
      const receipt = await services().bundler.getUserOperationReceipt(hash as Hex) as
        { success?: boolean; receipt?: { transactionHash?: string; blockNumber?: string } } | null;
      if (!receipt) return context.json({ userOpHash: hash, status: "pending" as const }, 200);
      return context.json({
        userOpHash: hash, status: receipt.success === false ? "reverted" as const : "included" as const,
        transactionHash: receipt.receipt?.transactionHash ?? null, blockNumber: receipt.receipt?.blockNumber ?? null,
      }, 200);
    } catch (error) {
      const { body, status } = respondError(error);
      return context.json(body, status);
    }
  });
}
