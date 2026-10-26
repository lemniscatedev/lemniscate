// Dry run only: makes the anvil fork of the testnet charge what the testnet charges, so the gas ledger is tested for real.
// The testnet (Orbit) keeps the base fee at its 0.01 gwei floor and suggests a 0 priority fee; anvil lets the base fee
// decay on empty blocks and always suggests 1 gwei, which would make every wallet reserve 100x the real price and
// fail "insufficient funds" where the testnet would not. This JSON-RPC proxy sits in front of anvil and
//   - answers eth_maxPriorityFeePerGas with 0 and eth_gasPrice with the floor (as the testnet does),
//   - refuses eth_fillTransaction as the testnet's Nitro node does (anvil would fill in its own 1 gwei tip),
//   - pins every next block's base fee to the testnet floor (anvil_setNextBlockBaseFeePerGas, every 200 ms).
// Everything else is forwarded untouched. Refuses to start unless the node behind it is an anvil on chain 46630.
//
//   bun scripts/testnet/fee-shim.ts --port 8615 --anvil http://127.0.0.1:8616 [--base-fee 10000000]
const arg = (name: string, fallback?: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1]! : fallback;
};
const port = Number(arg("port", "8615"));
const anvil = arg("anvil", "http://127.0.0.1:8616")!;
const baseFee = BigInt(arg("base-fee", "10000000")!);

async function rpc(method: string, params: unknown[] = []): Promise<unknown> {
  const res = await fetch(anvil, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const body = (await res.json()) as { result?: unknown; error?: { message: string } };
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

/** The rewritten answer for a request, or undefined to forward it. */
export function rewrite(method: string): unknown {
  if (method === "eth_maxPriorityFeePerGas") return "0x0";
  if (method === "eth_gasPrice") return `0x${baseFee.toString(16)}`;
  return undefined;
}

if (import.meta.main) {
  const version = String(await rpc("web3_clientVersion"));
  const chain = Number(BigInt(String(await rpc("eth_chainId"))));
  if (!/anvil/i.test(version) || chain !== 46630) throw new Error(`fee-shim: ${anvil} is ${version} on chain ${chain}, not an anvil fork of 46630; refusing`);
  const pin = async () => { try { await rpc("anvil_setNextBlockBaseFeePerGas", [`0x${baseFee.toString(16)}`]); } catch { /* anvil restarting */ } };
  await pin();
  setInterval(pin, 200);
  Bun.serve({
    hostname: "127.0.0.1", port,
    async fetch(request) {
      const text = await request.text();
      let body: unknown;
      try { body = JSON.parse(text); } catch { return new Response("bad json", { status: 400 }); }
      const one = async (req: { id?: unknown; method: string }) => {
        if (req.method === "eth_fillTransaction") {
          return { jsonrpc: "2.0", id: req.id ?? null, error: { code: -32601, message: "the method eth_fillTransaction does not exist/is not available" } };
        }
        const r = rewrite(req.method);
        return r === undefined ? undefined : { jsonrpc: "2.0", id: req.id ?? null, result: r };
      };
      if (!Array.isArray(body)) {
        const local = await one(body as { id?: unknown; method: string });
        if (local) return Response.json(local);
      } else if ((body as { method: string }[]).some((r) => rewrite(r.method) !== undefined || r.method === "eth_fillTransaction")) {
        const out = await Promise.all((body as { id?: unknown; method: string; params?: unknown[] }[]).map(async (req) => (await one(req)) ?? (await (await fetch(anvil, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(req) })).json())));
        return Response.json(out);
      }
      const res = await fetch(anvil, { method: "POST", headers: { "content-type": "application/json" }, body: text });
      return new Response(res.body, { status: res.status, headers: { "content-type": "application/json" } });
    },
  });
  console.log(`fee-shim: 127.0.0.1:${port} -> ${anvil} (base fee pinned to ${baseFee} wei, priority fee 0)`);
}
