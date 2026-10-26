import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { getAddress, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { loadX402Settings } from "./config";
import { createGate, PAID_REQUEST_IDLE_SECONDS, SETTLE_RECEIPT_TIMEOUT_MS, type Settler } from "./gate";
import { createPayingFetch, PaymentRefused, signPayment } from "./pay";
import {
  PERMIT2_ADDRESS, WITNESS_TYPE_STRING, decodePayment, encodePayment, networkId, permitTypedData, resourceHash, resourceKey, witnessHash,
  type PaymentPayload,
} from "./permit2";
import { registerX402 } from "./index";

const CHAIN_ID = 4663;
const USDG = getAddress("0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168");
const PAY_TO = getAddress("0x00000000000000000000000000000000000000b1");
const NOW_MS = 1_792_200_000_000;
const payer = privateKeyToAccount(generatePrivateKey());
const settlerAccount = privateKeyToAccount(generatePrivateKey());

interface Harness {
  app: Hono;
  gate: ReturnType<typeof createGate>;
  settled: Array<Parameters<Settler["settle"]>[0]>;
  state: { now: number; failSettle: boolean; handlerStatus: number; handlerCalls: number };
}

function harness(extra: { internalToken?: string; settleNonceUsed?: boolean } = {}): Harness {
  const state = { now: NOW_MS, failSettle: false, handlerStatus: 200, handlerCalls: 0 };
  const settled: Harness["settled"] = [];
  const settler: Settler = {
    address: settlerAccount.address,
    async settle(args) {
      if (state.failSettle) throw new Error("revert");
      settled.push(args);
      return { txHash: `0x${"cd".repeat(32)}` as Hex };
    },
    ...(extra.settleNonceUsed ? { nonceUsed: async () => true } : {}),
  };
  const settings = loadX402Settings({ X402_ENABLED: "0" });
  const gate = createGate({
    chainId: CHAIN_ID, usdg: USDG, payTo: PAY_TO, settler, routes: settings.routes, challengeTtlSeconds: 300,
    ...(extra.internalToken ? { internalToken: extra.internalToken } : {}), now: () => state.now,
  });
  const app = new Hono();
  registerX402(app, { ...gate, routes: settings.routes });
  app.get("/v1/pool", (c) => { state.handlerCalls++; return c.json({ nav: "1" }, state.handlerStatus as 200); });
  app.get("/v1/chains/:name", (c) => c.json({ name: c.req.param("name") }));
  app.get("/v1/chains", (c) => c.json({ names: [] }));
  app.get("/v1/health", (c) => c.json({ ok: true }));
  return { app, gate, settled, state };
}

const get = (h: Harness, path: string, headers: Record<string, string> = {}) => h.app.request(path, { headers });
async function challengeFor(h: Harness, path: string) {
  const res = await get(h, path);
  expect(res.status).toBe(402);
  return (await res.json() as any);
}
interface Over { amount?: bigint; token?: Address; payTo?: Address; resource?: Hex; deadline?: bigint; nonce?: bigint; spender?: Address; signer?: typeof payer; network?: string; spenderInSig?: Address }
/** A payment for the 402 body, optionally tampered with. */
async function pay(body: any, over: Over = {}): Promise<string> {
  const req = body.accepts[0];
  const fields = {
    token: over.token ?? (req.asset as Address), amount: over.amount ?? BigInt(req.maxAmountRequired), nonce: over.nonce ?? BigInt(req.extra.nonce),
    deadline: over.deadline ?? BigInt(req.extra.deadline), spender: over.spenderInSig ?? (req.extra.spender as Address),
    payTo: over.payTo ?? (req.payTo as Address), resource: over.resource ?? (req.extra.witness.resource as Hex),
  };
  const signature = await (over.signer ?? payer).signTypedData(permitTypedData(CHAIN_ID, fields));
  const payment: PaymentPayload = {
    x402Version: 1, scheme: "exact", network: over.network ?? req.network,
    payload: {
      signature, owner: payer.address,
      permit: { permitted: { token: fields.token, amount: fields.amount.toString() }, nonce: fields.nonce.toString(), deadline: fields.deadline.toString() },
      witness: { payTo: fields.payTo, resource: fields.resource },
    },
  };
  return encodePayment(payment);
}
const withPayment = (h: Harness, path: string, header: string) => get(h, path, { "x-payment": header });
const errorOf = async (res: Response) => (await res.json() as any).error as string;

describe("R5 pricingOfData", () => {
  test("free: health, config style routes and the chain list; paid: pool, vol and one chain with defaults in the cent band", async () => {
    const h = harness();
    expect((await get(h, "/v1/health")).status).toBe(200);
    expect((await get(h, "/v1/chains")).status).toBe(200);
    for (const path of ["/v1/pool", "/v1/chains/NVDA"]) expect((await get(h, path)).status).toBe(402);
    const settings = loadX402Settings({});
    for (const route of settings.routes) {
      expect(route.amount).toBeGreaterThanOrEqual(1_000n); // $0.001
      expect(route.amount).toBeLessThanOrEqual(10_000n);   // $0.01
    }
    expect(settings.routes.map((r) => r.pattern)).toEqual(["/v1/vol/:name", "/v1/chains/:name", "/v1/pool"]);
  });

  test("prices come from config and bad values are rejected", () => {
    const s = loadX402Settings({ X402_PRICE_POOL: "0.0075", X402_PRICE_VOL: "0.001", X402_PRICE_CHAINS: "0.01" });
    expect(s.routes.map((r) => r.amount)).toEqual([1_000n, 10_000n, 7_500n]);
    expect(() => loadX402Settings({ X402_PRICE_POOL: "abc" })).toThrow();
    expect(() => loadX402Settings({ X402_PRICE_POOL: "0" })).toThrow();
    expect(() => loadX402Settings({ X402_ENABLED: "1" })).toThrow(/X402_PAY_TO/);
  });
});

describe("R4 x402Flow", () => {
  test("402 carries the payment requirements: USDG amount, payTo, Permit2 witness fields, nonce, deadline", async () => {
    const h = harness();
    const body = await challengeFor(h, "/v1/pool");
    const req = body.accepts[0];
    expect(body.x402Version).toBe(1);
    expect(req).toMatchObject({ scheme: "exact", network: networkId(CHAIN_ID), asset: USDG, payTo: PAY_TO, maxAmountRequired: "3000", resource: "/v1/pool" });
    expect(req.extra).toMatchObject({
      assetTransferMethod: "permit2", permit2: PERMIT2_ADDRESS, spender: settlerAccount.address, witnessTypeString: WITNESS_TYPE_STRING,
      domain: { name: "Permit2", chainId: CHAIN_ID, verifyingContract: PERMIT2_ADDRESS },
    });
    expect(req.extra.witness).toEqual({ payTo: PAY_TO, resource: resourceHash(resourceKey("GET", "/v1/pool")) });
    expect(BigInt(req.extra.deadline)).toBe(BigInt(NOW_MS / 1000) + 300n);
    expect(BigInt(req.extra.nonce)).toBeGreaterThan(0n);
    // A fresh nonce on every challenge.
    expect((await challengeFor(h, "/v1/pool")).accepts[0].extra.nonce).not.toBe(req.extra.nonce);
    expect(h.state.handlerCalls).toBe(0);
  });

  test("a valid signed payment is verified, the data is served and the funds are settled through Permit2", async () => {
    const h = harness();
    const body = await challengeFor(h, "/v1/pool");
    const res = await withPayment(h, "/v1/pool", await pay(body));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ nav: "1" });
    expect(h.settled).toHaveLength(1);
    expect(h.settled[0]).toMatchObject({ token: USDG, amount: 3_000n, owner: payer.address, payTo: PAY_TO });
    expect(h.settled[0]!.resource).toBe(resourceHash(resourceKey("GET", "/v1/pool")));
    const receipt = JSON.parse(Buffer.from(res.headers.get("x-payment-response")!, "base64").toString());
    expect(receipt).toMatchObject({ success: true, payer: payer.address, network: networkId(CHAIN_ID) });
  });

  test("the same payment again returns the original answer (idempotent by payment id) and settles nothing more", async () => {
    // Fork run 2026-10-25: a settlement slower than Bun.serve's idle timeout dropped the connection; the client's retry
    // got `replay` although the USDG had moved. A retry of the same signed payment now gets the paid answer again.
    const h = harness();
    const header = await pay(await challengeFor(h, "/v1/pool"));
    const first = await withPayment(h, "/v1/pool", header);
    expect(first.status).toBe(200);
    const again = await withPayment(h, "/v1/pool", header);
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ nav: "1" });
    expect(again.headers.get("x-payment-response")).toBe(first.headers.get("x-payment-response"));
    expect(again.headers.get("cache-control")).toContain("no-store");
    expect(h.settled).toHaveLength(1);
    expect(h.state.handlerCalls).toBe(1);
  });

  test("a retry that arrives while the first request is still settling waits for it and gets the same answer", async () => {
    const h = harness();
    let release!: () => void;
    const gateOpen = new Promise<void>((resolve) => { release = resolve; });
    const settle = h.gate.settlerAddress; // unchanged settler identity
    expect(settle).toBe(settlerAccount.address);
    const slow = createGate({
      chainId: CHAIN_ID, usdg: USDG, payTo: PAY_TO, routes: loadX402Settings({}).routes, challengeTtlSeconds: 300, now: () => h.state.now,
      settler: { address: settlerAccount.address, settle: async (args) => { await gateOpen; h.settled.push(args); return { txHash: `0x${"ab".repeat(32)}` as Hex }; } },
    });
    const app = new Hono();
    registerX402(app, { ...slow, routes: loadX402Settings({}).routes });
    let calls = 0;
    app.get("/v1/pool", (c) => { calls++; return c.json({ nav: "2" }); });
    const header = await pay(await (await app.request("/v1/pool")).json());
    const first = app.request("/v1/pool", { headers: { "x-payment": header } });
    await Bun.sleep(20);
    const retry = app.request("/v1/pool", { headers: { "x-payment": header } });
    await Bun.sleep(20);
    release();
    const [a, b] = await Promise.all([first, retry]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(await b.json()).toEqual({ nav: "2" });
    expect(h.settled).toHaveLength(1);
    expect(calls).toBe(1);
  });

  test("concurrent use of one payment settles once and every copy gets the one answer", async () => {
    const h = harness();
    const header = await pay(await challengeFor(h, "/v1/pool"));
    const results = await Promise.all([withPayment(h, "/v1/pool", header), withPayment(h, "/v1/pool", header), withPayment(h, "/v1/pool", header)]);
    expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(h.settled).toHaveLength(1);
    expect(h.state.handlerCalls).toBe(1);
  });

  test("a retry never reaches another resource, and a failed settlement answers the same failure, not replay", async () => {
    const h = harness();
    const header = await pay(await challengeFor(h, "/v1/pool"));
    expect((await withPayment(h, "/v1/pool", header)).status).toBe(200);
    const elsewhere = await withPayment(h, "/v1/chains/NVDA", header);
    expect(elsewhere.status).toBe(402);
    expect(["wrong_witness", "wrong_amount"]).toContain(await errorOf(elsewhere)); // bound to /v1/pool and its price
    expect(h.settled).toHaveLength(1);

    const h2 = harness();
    h2.state.failSettle = true;
    const header2 = await pay(await challengeFor(h2, "/v1/pool"));
    expect(await errorOf(await withPayment(h2, "/v1/pool", header2))).toBe("settlement_failed");
    const retry = await withPayment(h2, "/v1/pool", header2);
    expect(await errorOf(retry)).toBe("settlement_failed");
    expect(h2.state.handlerCalls).toBe(1);
  });

  test("a paid request asks the server for a longer idle timeout than Bun.serve's 10 s default; an unpaid one does not", async () => {
    const h = harness();
    const calls: number[] = [];
    const server = { timeout: (_request: Request, seconds: number) => { calls.push(seconds); } };
    const challengeRes = await h.app.fetch(new Request("http://x/v1/pool"), server);
    expect(challengeRes.status).toBe(402);
    expect(calls).toEqual([]);
    const header = await pay(await challengeRes.json());
    const paid = await h.app.fetch(new Request("http://x/v1/pool", { headers: { "x-payment": header } }), server);
    expect(paid.status).toBe(200);
    expect(calls).toEqual([PAID_REQUEST_IDLE_SECONDS]);
    expect(PAID_REQUEST_IDLE_SECONDS).toBeGreaterThan(SETTLE_RECEIPT_TIMEOUT_MS / 1000);
    expect(PAID_REQUEST_IDLE_SECONDS).toBeLessThanOrEqual(255); // Bun's per-request maximum
  });

  test("an on-chain nonce check (Permit2 bitmap) also counts as replay", async () => {
    const h = harness({ settleNonceUsed: true });
    const res = await withPayment(h, "/v1/pool", await pay(await challengeFor(h, "/v1/pool")));
    expect(await errorOf(res)).toBe("replay");
  });

  test("expired payment is rejected", async () => {
    const h = harness();
    const header = await pay(await challengeFor(h, "/v1/pool"));
    h.state.now += 301_000;
    const res = await withPayment(h, "/v1/pool", header);
    expect(res.status).toBe(402);
    expect(await errorOf(res)).toBe("expired");
    expect(h.settled).toHaveLength(0);
  });

  test("wrong amount is rejected, higher or lower", async () => {
    const h = harness();
    const body = await challengeFor(h, "/v1/pool");
    expect(await errorOf(await withPayment(h, "/v1/pool", await pay(body, { amount: 2_999n })))).toBe("wrong_amount");
    expect(await errorOf(await withPayment(h, "/v1/pool", await pay(body, { amount: 3_001n })))).toBe("wrong_amount");
    expect(h.settled).toHaveLength(0);
  });

  test("wrong witness is rejected: another resource, another recipient, another token, another network", async () => {
    const h = harness();
    const body = await challengeFor(h, "/v1/pool");
    const other = resourceHash(resourceKey("GET", "/v1/chains/NVDA"));
    expect(await errorOf(await withPayment(h, "/v1/pool", await pay(body, { resource: other })))).toBe("wrong_witness");
    expect(await errorOf(await withPayment(h, "/v1/pool", await pay(body, { payTo: payer.address })))).toBe("wrong_witness");
    expect(await errorOf(await withPayment(h, "/v1/pool", await pay(body, { token: PAY_TO })))).toBe("wrong_token");
    expect(await errorOf(await withPayment(h, "/v1/pool", await pay(body, { network: "eip155:1" })))).toBe("wrong_network");
    // A payment issued for one URL cannot buy another (query string is part of the binding).
    const q = await challengeFor(h, "/v1/chains/NVDA");
    expect(await errorOf(await withPayment(h, "/v1/chains/TSLA", await pay(q)))).toBe("wrong_witness");
    expect(h.settled).toHaveLength(0);
  });

  test("a payment signed for a different witness than it claims fails the signature check", async () => {
    const h = harness();
    const body = await challengeFor(h, "/v1/pool");
    const req = body.accepts[0];
    // Signature over another recipient, payload claiming the right one.
    const signature = await payer.signTypedData(permitTypedData(CHAIN_ID, {
      token: USDG, amount: 3_000n, nonce: BigInt(req.extra.nonce), deadline: BigInt(req.extra.deadline), spender: settlerAccount.address,
      payTo: payer.address, resource: req.extra.witness.resource,
    }));
    const header = encodePayment({
      x402Version: 1, scheme: "exact", network: req.network, payload: {
        signature, owner: payer.address,
        permit: { permitted: { token: USDG, amount: "3000" }, nonce: req.extra.nonce, deadline: req.extra.deadline },
        witness: { payTo: PAY_TO, resource: req.extra.witness.resource },
      },
    });
    expect(await errorOf(await withPayment(h, "/v1/pool", header))).toBe("bad_signature");
  });

  test("bad signatures: other signer, other spender, garbage, malformed header", async () => {
    const h = harness();
    const body = await challengeFor(h, "/v1/pool");
    const stranger = privateKeyToAccount(generatePrivateKey());
    expect(await errorOf(await withPayment(h, "/v1/pool", await pay(body, { signer: stranger })))).toBe("bad_signature");
    expect(await errorOf(await withPayment(h, "/v1/pool", await pay(body, { spenderInSig: stranger.address })))).toBe("bad_signature");
    expect(await errorOf(await withPayment(h, "/v1/pool", "not base64 json"))).toBe("invalid_payment");
    expect(await errorOf(await withPayment(h, "/v1/pool", Buffer.from("{}").toString("base64")))).toBe("invalid_payment");
    expect(h.settled).toHaveLength(0);
  });

  test("nonce must have been issued for this exact request and deadline", async () => {
    const h = harness();
    const body = await challengeFor(h, "/v1/pool");
    expect(await errorOf(await withPayment(h, "/v1/pool", await pay(body, { nonce: 12345n })))).toBe("invalid_nonce");
    expect(await errorOf(await withPayment(h, "/v1/pool", await pay(body, { deadline: BigInt(body.accepts[0].extra.deadline) - 1n })))).toBe("invalid_nonce");
    expect(await errorOf(await withPayment(h, "/v1/pool", await pay(body, { deadline: BigInt(body.accepts[0].extra.deadline) + 10_000n })))).toBe("invalid_deadline");
    // A nonce issued for /v1/pool does not work on /v1/chains/NVDA even with a matching witness.
    const stolen = BigInt(body.accepts[0].extra.nonce);
    const chain = await challengeFor(h, "/v1/chains/NVDA");
    expect(await errorOf(await withPayment(h, "/v1/chains/NVDA", await pay(chain, { nonce: stolen })))).toBe("invalid_nonce");
  });

  test("a failed read frees the payment; a failed settlement withholds the data", async () => {
    const h = harness();
    const header = await pay(await challengeFor(h, "/v1/pool"));
    h.state.handlerStatus = 503;
    expect((await withPayment(h, "/v1/pool", header)).status).toBe(503);
    expect(h.settled).toHaveLength(0);
    h.state.handlerStatus = 200;
    expect((await withPayment(h, "/v1/pool", header)).status).toBe(200);
    expect(h.settled).toHaveLength(1);

    const h2 = harness();
    h2.state.failSettle = true;
    const res = await withPayment(h2, "/v1/pool", await pay(await challengeFor(h2, "/v1/pool")));
    expect(res.status).toBe(402);
    const body = await res.json() as any;
    expect(body.error).toBe("settlement_failed");
    expect(JSON.stringify(body)).not.toContain("nav");
  });

  test("a different secret per instance means one instance's nonces fail on another", async () => {
    const a = harness();
    const b = harness();
    const header = await pay(await challengeFor(a, "/v1/pool"));
    expect(await errorOf(await withPayment(b, "/v1/pool", header))).toBe("invalid_nonce");
  });

  test("F41: an Origin header never waives payment, whatever its value", async () => {
    const h = harness({ internalToken: "a-long-internal-secret-0123456789" });
    for (const origin of ["https://app.example", "https://other.example", "null", "https://lemniscate.example"]) {
      expect((await get(h, "/v1/pool", { origin })).status).toBe(402);
    }
    expect(h.state.handlerCalls).toBe(0);
  });

  test("F41: the website's own server reads free with the internal token; a wrong or missing token pays", async () => {
    const h = harness({ internalToken: "a-long-internal-secret-0123456789" });
    expect((await get(h, "/v1/pool", { "x-lmns-internal": "a-long-internal-secret-0123456789" })).status).toBe(200);
    expect((await get(h, "/v1/pool", { "x-lmns-internal": "a-long-internal-secret-0123456780" })).status).toBe(402);
    expect((await get(h, "/v1/pool", { "x-lmns-internal": "" })).status).toBe(402);
    const open = harness();
    expect((await get(open, "/v1/pool", { "x-lmns-internal": "anything" })).status).toBe(402); // no token configured: nobody is exempt
  });

  test("F41: paid responses are never cacheable by a shared cache", async () => {
    const h = harness({ internalToken: "a-long-internal-secret-0123456789" });
    const internal = await get(h, "/v1/pool", { "x-lmns-internal": "a-long-internal-secret-0123456789" });
    expect(internal.headers.get("cache-control")).toBe("private, no-store");
    const paid = await withPayment(h, "/v1/pool", await pay(await challengeFor(h, "/v1/pool")));
    expect(paid.status).toBe(200);
    expect(paid.headers.get("cache-control")).toBe("private, no-store");
  });

  test("F41: X402_FREE_ORIGINS is gone and says why instead of being silently ignored", () => {
    expect(() => loadX402Settings({ X402_FREE_ORIGINS: "https://app.example" })).toThrow("can be forged");
    expect(loadX402Settings({ X402_INTERNAL_TOKEN: "a-long-internal-secret-0123456789" }).internalToken).toBeDefined();
    expect(() => loadX402Settings({ X402_INTERNAL_TOKEN: "short" })).toThrow();
  });

  test("tracked nonce memory is bounded", async () => {
    const h = harness();
    const settings = loadX402Settings({});
    const small = createGate({
      chainId: CHAIN_ID, usdg: USDG, payTo: PAY_TO, settler: { address: settlerAccount.address, settle: async () => ({ txHash: `0x${"11".repeat(32)}` as Hex }) },
      routes: settings.routes, challengeTtlSeconds: 300, now: () => h.state.now, maxTrackedNonces: 3,
    });
    const app = new Hono();
    registerX402(app, { ...small, routes: settings.routes });
    app.get("/v1/pool", (c) => c.json({}));
    for (let i = 0; i < 8; i++) {
      const body = await (await app.request("/v1/pool")).json() as any;
      expect((await app.request("/v1/pool", { headers: { "x-payment": await pay(body) } })).status).toBe(200);
    }
    expect(small.consumedCount()).toBeLessThanOrEqual(3);
  });
});

describe("wire format and the paying client", () => {
  test("encode/decode round trip and strict rejection", async () => {
    const h = harness();
    const header = await pay(await challengeFor(h, "/v1/pool"));
    const parsed = decodePayment(header)!;
    expect(parsed.owner).toBe(payer.address);
    expect(parsed.amount).toBe(3_000n);
    expect(decodePayment("x".repeat(5000))).toBeNull();
    expect(witnessHash(PAY_TO, resourceHash("a"))).toMatch(/^0x[0-9a-f]{64}$/);
  });

  test("createPayingFetch answers a 402 once and gets the data", async () => {
    const h = harness();
    const base = ((input: any, init?: any) => h.app.request(String(input).replace("http://x", ""), init)) as unknown as typeof fetch;
    const paying = createPayingFetch(base, payer, { chainId: CHAIN_ID, maxAmount: 10_000n });
    const res = await paying("http://x/v1/pool");
    expect(res.status).toBe(200);
    expect(h.settled).toHaveLength(1);
    expect(h.settled[0]!.owner).toBe(payer.address);
  });

  test("the client refuses to sign over its per-call limit, a foreign Permit2, another network or a swapped witness", async () => {
    const h = harness();
    const body = await challengeFor(h, "/v1/pool");
    const limits = { chainId: CHAIN_ID, maxAmount: 10_000n };
    await expect(signPayment(body, payer, { ...limits, maxAmount: 2_999n })).rejects.toThrow(PaymentRefused);
    const clone = (mutate: (b: any) => void) => { const c = structuredClone(body); mutate(c); return c; };
    await expect(signPayment(clone((b) => { b.accepts[0].extra.permit2 = PAY_TO; }), payer, limits)).rejects.toThrow("canonical Permit2");
    await expect(signPayment(clone((b) => { b.accepts[0].network = "eip155:1"; }), payer, limits)).rejects.toThrow("another network");
    await expect(signPayment(clone((b) => { b.accepts[0].extra.witnessTypeString = "X witness)X(uint256 a)"; }), payer, limits)).rejects.toThrow("witness layout");
    await expect(signPayment(clone((b) => { b.accepts[0].extra.witness.resource = resourceHash("GET /v1/other"); }), payer, limits)).rejects.toThrow("resource");
    await expect(signPayment({ accepts: [] }, payer, limits)).rejects.toThrow(PaymentRefused);
  });
});

describe("chain clock on the anvil fork (todo 23)", () => {
  test("challenge deadlines follow the chain's block time, so Permit2 does not see them as expired on a warped fork", async () => {
    const { chainAnchoredClock } = await import("./index");
    const wall = 1_790_000_000_000;
    const clock = chainAnchoredClock(async () => 1_800_000_000, () => wall);
    expect(clock.now()).toBe(wall); // before the first read: wall time
    await clock.refresh();
    expect(clock.now()).toBe(1_800_000_000_000);
    const failing = chainAnchoredClock(async () => { throw new Error("rpc down"); }, () => wall);
    await failing.refresh();
    expect(failing.now()).toBe(wall);
  });
});

describe("F42 the settler never reuses a nonce", () => {
  test("20 parallel settlements get 20 distinct transaction nonces and all succeed", async () => {
    const { custom, decodeFunctionData: decode, parseTransaction } = await import("viem");
    const { viemSettler: makeSettler } = await import("./gate");
    const nonces: number[] = [];
    let latestBlock = 1;
    // A node that, like a real one, answers the pending transaction count with what it has already been given.
    const request = async ({ method, params }: { method: string; params?: unknown[] }) => {
      switch (method) {
        case "eth_chainId": return "0x1237";
        case "eth_getTransactionCount": return `0x${nonces.length.toString(16)}`;
        case "eth_estimateGas": await new Promise((r) => setTimeout(r, 20)); return "0x30d40";
        case "eth_gasPrice": return "0x3b9aca00";
        case "eth_maxPriorityFeePerGas": return "0x3b9aca00";
        case "eth_getBlockByNumber": return { number: "0x1", baseFeePerGas: "0x3b9aca00", timestamp: "0x1", hash: `0x${"11".repeat(32)}`, transactions: [] };
        case "eth_sendRawTransaction": {
          const tx = parseTransaction((params as string[])[0] as `0x${string}`);
          if (nonces.includes(tx.nonce as number)) throw new Error(`nonce too low: ${tx.nonce}`);
          nonces.push(tx.nonce as number);
          return `0x${(nonces.length).toString(16).padStart(64, "0")}`;
        }
        case "eth_getTransactionReceipt": return { status: "0x1", blockNumber: "0x1", blockHash: `0x${"11".repeat(32)}`, transactionHash: (params as string[])[0], transactionIndex: "0x0", from: settlerAccount.address, to: PERMIT2_ADDRESS, cumulativeGasUsed: "0x1", gasUsed: "0x1", effectiveGasPrice: "0x1", logs: [], logsBloom: `0x${"00".repeat(256)}`, type: "0x2", contractAddress: null };
        case "eth_blockNumber": latestBlock += 1; return `0x${latestBlock.toString(16)}`;
        default: throw Object.assign(new Error(`method not found: ${method}`), { code: -32601 }); // not retried by viem
      }
    };
    void decode;
    const settler = makeSettler({ rpcUrl: "http://unused", chainId: 4663, key: bytesToKey(), transport: custom({ request } as never), pollingIntervalMs: 10 });
    const results = await Promise.allSettled(Array.from({ length: 20 }, (_, i) => settler.settle({
      token: USDG, amount: 5_000n, nonce: BigInt(i + 1), deadline: 4_102_444_800n, owner: payer.address, payTo: PAY_TO,
      resource: `0x${"ab".repeat(32)}` as Hex, signature: `0x${"cd".repeat(65)}` as Hex,
    })));
    expect(results.filter((r) => r.status === "rejected")).toEqual([]);
    expect([...nonces].sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, i) => i));
  });
});

function bytesToKey(): Hex {
  return ("0x" + "00".repeat(31) + "07") as Hex; // test-key
}
