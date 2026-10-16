import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { getAddress, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { loadX402Settings } from "./config";
import { createGate, type Settler } from "./gate";
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

function harness(extra: { freeOrigins?: string[]; settleNonceUsed?: boolean } = {}): Harness {
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
    freeOrigins: extra.freeOrigins ?? [], now: () => state.now,
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

  test("replay of the same payment is rejected and settles nothing", async () => {
    const h = harness();
    const header = await pay(await challengeFor(h, "/v1/pool"));
    expect((await withPayment(h, "/v1/pool", header)).status).toBe(200);
    const again = await withPayment(h, "/v1/pool", header);
    expect(again.status).toBe(402);
    expect(await errorOf(again)).toBe("replay");
    expect(h.settled).toHaveLength(1);
    expect(h.state.handlerCalls).toBe(1);
  });

  test("concurrent use of one payment settles once", async () => {
    const h = harness();
    const header = await pay(await challengeFor(h, "/v1/pool"));
    const results = await Promise.all([withPayment(h, "/v1/pool", header), withPayment(h, "/v1/pool", header), withPayment(h, "/v1/pool", header)]);
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(h.settled).toHaveLength(1);
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

  test("allowed web origins read free; others and non-GET are unaffected by origin spoof only for listed origins", async () => {
    const h = harness({ freeOrigins: ["https://app.example"] });
    expect((await get(h, "/v1/pool", { origin: "https://app.example" })).status).toBe(200);
    expect((await get(h, "/v1/pool", { origin: "https://other.example" })).status).toBe(402);
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
