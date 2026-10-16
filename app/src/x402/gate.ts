import { createHmac, randomBytes } from "node:crypto";
import type { Context, MiddlewareHandler } from "hono";
import {
  createPublicClient, createWalletClient, http, verifyTypedData, type Address, type Hex, type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { PaidRoute } from "./config";
import {
  PERMIT2_ADDRESS, WITNESS_TYPE_NAME, WITNESS_TYPE_STRING, decodePayment, networkId, permit2Abi, permitTypedData,
  resourceHash, resourceKey, witnessHash,
} from "./permit2";

export type PaymentError =
  | "payment_required" | "invalid_payment" | "wrong_network" | "wrong_token" | "wrong_amount" | "wrong_witness"
  | "expired" | "invalid_deadline" | "invalid_nonce" | "bad_signature" | "replay" | "settlement_failed";

export interface Settlement {
  readonly txHash: Hex;
}

/** Pulls the funds. The settler wallet is Permit2's `msg.sender`, so it is the `spender` the payer signs for. */
export interface Settler {
  readonly address: Address;
  settle(args: {
    token: Address; amount: bigint; nonce: bigint; deadline: bigint; owner: Address; payTo: Address; resource: Hex; signature: Hex;
  }): Promise<Settlement>;
  /** Optional on-chain replay check (Permit2 unordered nonce bitmap). */
  nonceUsed?(owner: Address, nonce: bigint): Promise<boolean>;
}

export interface GateOptions {
  readonly chainId: number;
  readonly usdg: Address;
  readonly payTo: Address;
  readonly settler: Settler;
  readonly routes: readonly PaidRoute[];
  readonly challengeTtlSeconds: number;
  readonly freeOrigins?: readonly string[];
  readonly nonceSecret?: Hex;
  readonly now?: () => number;
  /** Defaults to local ECDSA recovery (EOA payers); swap in an ERC-1271-aware check if needed. */
  readonly verifySignature?: (args: { owner: Address; typedData: ReturnType<typeof permitTypedData>; signature: Hex }) => Promise<boolean>;
  readonly maxTrackedNonces?: number;
}

const SALT_BYTES = 16;

export function createGate(options: GateOptions) {
  const now = options.now ?? Date.now;
  const secret = options.nonceSecret ? Buffer.from(options.nonceSecret.slice(2), "hex") : randomBytes(32);
  const maxTracked = options.maxTrackedNonces ?? 100_000;
  const free = new Set(options.freeOrigins ?? []);
  /** nonce -> deadline (s). A nonce is consumed when a payment is accepted for settlement and never freed after success. */
  const consumed = new Map<bigint, bigint>();
  const nowSeconds = () => BigInt(Math.floor(now() / 1000));

  function sweep(at: bigint) {
    for (const [nonce, deadline] of consumed) if (deadline < at) consumed.delete(nonce);
    while (consumed.size >= maxTracked) { const oldest = consumed.keys().next().value; if (oldest === undefined) break; consumed.delete(oldest); }
  }

  /** nonce = salt(128 bits) || HMAC128(salt, binding). The server stores nothing when it issues a challenge. */
  function mac(salt: Buffer, route: { amount: bigint }, resource: Hex, deadline: bigint): Buffer {
    const binding = [options.chainId, options.usdg, options.payTo, options.settler.address, route.amount, resource, deadline].join("|");
    return createHmac("sha256", secret).update(salt).update(binding).digest().subarray(0, SALT_BYTES);
  }
  const issueNonce = (route: { amount: bigint }, resource: Hex, deadline: bigint): bigint => {
    const salt = randomBytes(SALT_BYTES);
    return BigInt(`0x${Buffer.concat([salt, mac(salt, route, resource, deadline)]).toString("hex")}`);
  };
  const nonceValid = (nonce: bigint, route: { amount: bigint }, resource: Hex, deadline: bigint): boolean => {
    const buf = Buffer.from(nonce.toString(16).padStart(SALT_BYTES * 4, "0"), "hex");
    if (buf.length !== SALT_BYTES * 2) return false;
    const expected = mac(buf.subarray(0, SALT_BYTES), route, resource, deadline);
    return expected.equals(buf.subarray(SALT_BYTES));
  };

  function requirements(route: PaidRoute, key: string, pathAndQuery: string) {
    const resource = resourceHash(key);
    const deadline = nowSeconds() + BigInt(options.challengeTtlSeconds);
    const nonce = issueNonce(route, resource, deadline);
    return {
      scheme: "exact", network: networkId(options.chainId), maxAmountRequired: route.amount.toString(), asset: options.usdg,
      payTo: options.payTo, resource: pathAndQuery, description: route.description, mimeType: "application/json",
      maxTimeoutSeconds: options.challengeTtlSeconds,
      extra: {
        assetTransferMethod: "permit2", permit2: PERMIT2_ADDRESS, spender: options.settler.address,
        domain: { name: "Permit2", chainId: options.chainId, verifyingContract: PERMIT2_ADDRESS },
        nonce: nonce.toString(), deadline: deadline.toString(),
        witnessTypeName: WITNESS_TYPE_NAME, witnessTypeString: WITNESS_TYPE_STRING,
        witness: { payTo: options.payTo, resource },
      },
    };
  }

  const challenge = (context: Context, route: PaidRoute, error: PaymentError, message: string) => {
    const url = new URL(context.req.url);
    const pathAndQuery = `${url.pathname}${url.search}`;
    context.header("Cache-Control", "no-store");
    return context.json({
      x402Version: 1, error, message,
      accepts: [requirements(route, resourceKey(context.req.method, pathAndQuery), pathAndQuery)],
    }, 402);
  };

  const verifySignature = options.verifySignature
    ?? (async ({ owner, typedData, signature }) => verifyTypedData({ address: owner, ...typedData, signature }));

  type Verified = { ok: true; owner: Address; nonce: bigint; deadline: bigint; signature: Hex; resource: Hex }
    | { ok: false; error: PaymentError; message: string };

  async function verify(header: string, route: PaidRoute, key: string): Promise<Verified> {
    const fail = (error: PaymentError, message: string): Verified => ({ ok: false, error, message });
    const payment = decodePayment(header);
    if (!payment) return fail("invalid_payment", "Malformed X-PAYMENT header.");
    if (payment.network !== networkId(options.chainId)) return fail("wrong_network", "Payment is for another network.");
    if (payment.token.toLowerCase() !== options.usdg.toLowerCase()) return fail("wrong_token", "Payment must be in USDG.");
    if (payment.amount !== route.amount) return fail("wrong_amount", "Payment amount does not match the price.");
    const resource = resourceHash(key);
    if (payment.payTo.toLowerCase() !== options.payTo.toLowerCase() || payment.resource !== resource) {
      return fail("wrong_witness", "Payment is not bound to this resource and recipient.");
    }
    const at = nowSeconds();
    if (payment.deadline < at) return fail("expired", "Payment deadline has passed.");
    if (payment.deadline > at + BigInt(options.challengeTtlSeconds)) return fail("invalid_deadline", "Payment deadline is too far in the future.");
    if (!nonceValid(payment.nonce, route, resource, payment.deadline)) return fail("invalid_nonce", "Nonce was not issued for this request.");
    if (consumed.has(payment.nonce)) return fail("replay", "Payment nonce was already used.");
    const typedData = permitTypedData(options.chainId, {
      token: options.usdg, amount: payment.amount, nonce: payment.nonce, deadline: payment.deadline,
      spender: options.settler.address, payTo: options.payTo, resource,
    });
    let signed = false;
    try { signed = await verifySignature({ owner: payment.owner, typedData, signature: payment.signature }); } catch { signed = false; }
    if (!signed) return fail("bad_signature", "Signature does not match the payer and the payment terms.");
    if (options.settler.nonceUsed && await options.settler.nonceUsed(payment.owner, payment.nonce).catch(() => false)) {
      return fail("replay", "Payment nonce was already used.");
    }
    return { ok: true, owner: payment.owner, nonce: payment.nonce, deadline: payment.deadline, signature: payment.signature, resource };
  }

  function middleware(route: PaidRoute): MiddlewareHandler {
    return async (context, next) => {
      if (context.req.method !== "GET") return next();
      const origin = context.req.header("origin");
      if (origin && free.has(origin)) return next();
      const url = new URL(context.req.url);
      const key = resourceKey(context.req.method, `${url.pathname}${url.search}`);
      const header = context.req.header("x-payment");
      if (!header) return challenge(context, route, "payment_required", "Payment required.");
      const verified = await verify(header, route, key);
      if (!verified.ok) return challenge(context, route, verified.error, verified.message);

      // Reserve the nonce before running anything so two concurrent requests cannot share one payment.
      sweep(nowSeconds());
      if (consumed.has(verified.nonce)) return challenge(context, route, "replay", "Payment nonce was already used.");
      consumed.set(verified.nonce, verified.deadline);

      await next();
      // A failed read costs nothing: free the nonce so the same signed payment can be retried until its deadline.
      if (context.res.status >= 400) { consumed.delete(verified.nonce); return; }
      try {
        const settlement = await options.settler.settle({
          token: options.usdg, amount: route.amount, nonce: verified.nonce, deadline: verified.deadline, owner: verified.owner,
          payTo: options.payTo, resource: verified.resource, signature: verified.signature,
        });
        context.res.headers.set("X-PAYMENT-RESPONSE", Buffer.from(JSON.stringify({
          success: true, transaction: settlement.txHash, network: networkId(options.chainId), payer: verified.owner,
        })).toString("base64"));
      } catch {
        // Not settled: nothing was paid, so the data is withheld. The nonce stays burned (the failure may be post-broadcast).
        context.res = challenge(context, route, "settlement_failed", "Payment could not be settled.");
      }
    };
  }

  return { middleware, verify, requirements, settlerAddress: options.settler.address, consumedCount: () => consumed.size };
}

export type X402Gate = ReturnType<typeof createGate> & { readonly routes: readonly PaidRoute[] };

/** Real settler: a viem wallet signs `permitWitnessTransferFrom` and waits for the receipt. */
export function viemSettler(args: { rpcUrl: string; chainId: number; key: Hex; confirmations?: number }): Settler & { publicClient: PublicClient } {
  const account = privateKeyToAccount(args.key);
  const chain = { id: args.chainId, name: `chain-${args.chainId}`, nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [args.rpcUrl] } } } as const;
  const publicClient = createPublicClient({ chain, transport: http(args.rpcUrl) }) as PublicClient;
  const wallet = createWalletClient({ account, chain, transport: http(args.rpcUrl) });
  return {
    address: account.address,
    publicClient,
    async nonceUsed(owner, nonce) {
      const word = await publicClient.readContract({ address: PERMIT2_ADDRESS, abi: permit2Abi, functionName: "nonceBitmap", args: [owner, nonce >> 8n] });
      return (word & (1n << (nonce & 0xffn))) !== 0n;
    },
    async settle(p) {
      const txHash = await wallet.writeContract({
        address: PERMIT2_ADDRESS, abi: permit2Abi, functionName: "permitWitnessTransferFrom",
        args: [
          { permitted: { token: p.token, amount: p.amount }, nonce: p.nonce, deadline: p.deadline },
          { to: p.payTo, requestedAmount: p.amount }, p.owner, witnessHash(p.payTo, p.resource), WITNESS_TYPE_STRING, p.signature,
        ],
      });
      const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, confirmations: args.confirmations ?? 1 });
      if (receipt.status !== "success") throw new Error("settlement reverted");
      return { txHash };
    },
  };
}
