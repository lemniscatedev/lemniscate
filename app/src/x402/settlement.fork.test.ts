import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Hono } from "hono";
import { createPublicClient, createWalletClient, getAddress, http, parseAbi, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { loadX402Settings } from "./config";
import { createGate, viemSettler } from "./gate";
import { registerX402 } from "./index";
import { PERMIT2_ADDRESS, encodePayment, permitTypedData, resourceHash, resourceKey } from "./permit2";

// Real Permit2 on an anvil FORK of Robinhood Chain (read-only fork; nothing is broadcast to the real network).
// Needs FORK_RPC_URL and the forge artifact for the mock USDG (cd contracts && forge build).
const FORK_RPC_URL = process.env.FORK_RPC_URL;
const ARTIFACT = resolve(import.meta.dir, "../../../contracts/out/MockUSDG.sol/MockUSDG.json");
const suite = FORK_RPC_URL && existsSync(ARTIFACT) ? describe : describe.skip;

const erc20 = parseAbi([
  "function mint(address to, uint256 amount)", "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
]);
const PRICE = 3_000n;

suite("R4 x402 settlement through the real Permit2 (anvil fork, needs FORK_RPC_URL)", () => {
  let anvil: ReturnType<typeof Bun.spawn> | undefined;
  const port = 18_600 + Math.floor(Math.random() * 300);
  const rpc = `http://127.0.0.1:${port}`;
  const chain = { id: 4663, name: "fork", nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpc] } } } as const;
  const client = createPublicClient({ chain, transport: http(rpc) });
  const payer = privateKeyToAccount(generatePrivateKey());
  const broke = privateKeyToAccount(generatePrivateKey());
  const payTo = privateKeyToAccount(generatePrivateKey()).address;
  const settlerKey = generatePrivateKey();
  let usdg: Address;
  let app: Hono;
  let settler: ReturnType<typeof viemSettler>;

  const rpcCall = (method: string, params: unknown[]) =>
    fetch(rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }).then((r) => r.json());
  const balance = (who: Address) => client.readContract({ address: usdg, abi: erc20, functionName: "balanceOf", args: [who] });

  async function payment(body: any, signer = payer, over: { payTo?: Address } = {}): Promise<string> {
    const req = body.accepts[0];
    const fields = {
      token: usdg, amount: BigInt(req.maxAmountRequired), nonce: BigInt(req.extra.nonce), deadline: BigInt(req.extra.deadline),
      spender: req.extra.spender as Address, payTo: (over.payTo ?? req.payTo) as Address, resource: req.extra.witness.resource as Hex,
    };
    return encodePayment({
      x402Version: 1, scheme: "exact", network: req.network, payload: {
        signature: await signer.signTypedData(permitTypedData(4663, fields)), owner: signer.address,
        permit: { permitted: { token: usdg, amount: fields.amount.toString() }, nonce: fields.nonce.toString(), deadline: fields.deadline.toString() },
        witness: { payTo: req.payTo, resource: fields.resource },
      },
    });
  }

  beforeAll(async () => {
    anvil = Bun.spawn(["anvil", "--fork-url", FORK_RPC_URL!, "--port", String(port), "--silent", "--no-rate-limit", "--retries", "5"], { stdout: "ignore", stderr: "ignore" });
    for (let i = 0; i < 120; i++) {
      try { await client.getChainId(); break; } catch { await Bun.sleep(500); }
    }
    expect(await client.getChainId()).toBe(4663);
    expect(((await client.getCode({ address: PERMIT2_ADDRESS })) ?? "0x").length).toBeGreaterThan(100);
    const deployer = privateKeyToAccount(generatePrivateKey());
    const settlerAddr = privateKeyToAccount(settlerKey).address;
    for (const who of [deployer.address, payer.address, broke.address, settlerAddr]) await rpcCall("anvil_setBalance", [who, "0x56bc75e2d63100000"]);
    const artifact = JSON.parse(readFileSync(ARTIFACT, "utf8"));
    const wallet = createWalletClient({ account: deployer, chain, transport: http(rpc) });
    const hash = await wallet.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode.object as Hex });
    usdg = getAddress((await client.waitForTransactionReceipt({ hash })).contractAddress!);
    for (const who of [payer, broke]) {
      await client.waitForTransactionReceipt({ hash: await wallet.writeContract({ address: usdg, abi: erc20, functionName: "mint", args: [who.address, 1_000_000n] }) });
    }
    // Only `payer` approves Permit2 (the one-time setup an x402 payer does).
    const payerWallet = createWalletClient({ account: payer, chain, transport: http(rpc) });
    await client.waitForTransactionReceipt({ hash: await payerWallet.writeContract({ address: usdg, abi: erc20, functionName: "approve", args: [PERMIT2_ADDRESS, 2n ** 256n - 1n] }) });

    settler = viemSettler({ rpcUrl: rpc, chainId: 4663, key: settlerKey });
    const settings = loadX402Settings({});
    const gate = createGate({
      chainId: 4663, usdg, payTo, settler, routes: settings.routes, challengeTtlSeconds: 300,
      verifySignature: ({ owner, typedData, signature }) => settler.publicClient.verifyTypedData({ address: owner, ...typedData, signature }),
    });
    app = new Hono();
    registerX402(app, { ...gate, routes: settings.routes });
    app.get("/v1/pool", (c) => c.json({ nav: "1" }));
  }, 120_000);

  afterAll(() => { anvil?.kill(); });

  const challenge = async () => (await (await app.request("/v1/pool")).json()) as any;

  test("a signed payment moves exactly the price from payer to payTo, once", async () => {
    const before = { payer: await balance(payer.address), to: await balance(payTo) };
    const body = await challenge();
    const header = await payment(body);
    const res = await app.request("/v1/pool", { headers: { "x-payment": header } });
    expect(res.status).toBe(200);
    expect(await balance(payTo)).toBe(before.to + PRICE);
    expect(await balance(payer.address)).toBe(before.payer - PRICE);
    const receipt = JSON.parse(Buffer.from(res.headers.get("x-payment-response")!, "base64").toString());
    expect(receipt.transaction).toMatch(/^0x[0-9a-f]{64}$/);
    // Replay: the gate refuses before anything is sent...
    const again = await app.request("/v1/pool", { headers: { "x-payment": header } });
    expect(again.status).toBe(402);
    expect(((await again.json()) as any).error).toBe("replay");
    expect(await balance(payTo)).toBe(before.to + PRICE);
  }, 60_000);

  test("Permit2 itself refuses a replayed nonce and a swapped recipient", async () => {
    const body = await challenge();
    const header = await payment(body);
    expect((await app.request("/v1/pool", { headers: { "x-payment": header } })).status).toBe(200);
    const req = body.accepts[0];
    const args = {
      token: usdg, amount: PRICE, nonce: BigInt(req.extra.nonce), deadline: BigInt(req.extra.deadline), owner: payer.address,
      payTo: payTo as Address, resource: req.extra.witness.resource as Hex,
      signature: JSON.parse(Buffer.from(header, "base64").toString()).payload.signature as Hex,
    };
    await expect(settler.settle(args)).rejects.toThrow(); // nonce already spent on chain
    const body2 = await challenge();
    const header2 = await payment(body2);
    const parsed = JSON.parse(Buffer.from(header2, "base64").toString()).payload;
    await expect(settler.settle({
      token: usdg, amount: PRICE, nonce: BigInt(body2.accepts[0].extra.nonce), deadline: BigInt(body2.accepts[0].extra.deadline),
      owner: payer.address, payTo: privateKeyToAccount(generatePrivateKey()).address, resource: body2.accepts[0].extra.witness.resource,
      signature: parsed.signature,
    })).rejects.toThrow(); // witness (recipient) differs from what was signed
    await expect(settler.settle({
      token: usdg, amount: PRICE, nonce: BigInt(body2.accepts[0].extra.nonce), deadline: BigInt(body2.accepts[0].extra.deadline),
      owner: payer.address, payTo, resource: resourceHash(resourceKey("GET", "/v1/other")), signature: parsed.signature,
    })).rejects.toThrow(); // witness (resource) differs
  }, 60_000);

  test("a payer without a Permit2 allowance is not served", async () => {
    const before = await balance(payTo);
    const body = await challenge();
    const res = await app.request("/v1/pool", { headers: { "x-payment": await payment(body, broke) } });
    expect(res.status).toBe(402);
    expect(((await res.json()) as any).error).toBe("settlement_failed");
    expect(await balance(payTo)).toBe(before);
  }, 60_000);

  test("an expired deadline is refused by the gate and by Permit2", async () => {
    const body = await challenge();
    const req = body.accepts[0];
    const past = BigInt(Math.floor(Date.now() / 1000) - 60);
    const fields = { token: usdg, amount: PRICE, nonce: 99n, deadline: past, spender: req.extra.spender as Address, payTo, resource: req.extra.witness.resource as Hex };
    const signature = await payer.signTypedData(permitTypedData(4663, fields));
    await expect(settler.settle({ token: usdg, amount: PRICE, nonce: 99n, deadline: past, owner: payer.address, payTo, resource: fields.resource, signature })).rejects.toThrow();
  }, 60_000);
});
