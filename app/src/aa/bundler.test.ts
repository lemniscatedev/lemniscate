import { describe, expect, test } from "bun:test";
import { entryPoint07Address } from "viem/account-abstraction";
import { BundlerError, createHttpBundler } from "./bundler";
import { createRundlerStub } from "./mock-bundler";
import { buildUserOp } from "./userop";
import { approveCall } from "./kernel";
import { ACCOUNT, ENGINE, USDG, createTestServices } from "./test-support";
import { DUMMY_ACCOUNT_SIGNATURE } from "./kernel";

describe("bundlerInterface (R4): HTTP client against a Rundler-compatible stub", () => {
  test("estimate, send and receipt go over the JSON-RPC wire format", async () => {
    const stub = createRundlerStub(entryPoint07Address);
    const bundler = createHttpBundler({ url: "http://bundler.invalid", fetch: stub.fetch as never });
    const { services } = createTestServices();
    const built = await buildUserOp({ ...services, bundler }, { account: ACCOUNT, calls: [approveCall(USDG, ENGINE, 1n), { to: ENGINE, value: 0n, data: "0x12345678" }], sponsor: true });
    expect(built.estimated).toBe(true);
    expect(stub.requests[0]!.method).toBe("eth_estimateUserOperationGas");
    const wire = stub.requests[0]!.params[0] as Record<string, string>;
    expect(wire.sender?.toLowerCase()).toBe(ACCOUNT);
    expect(wire.callGasLimit).toMatch(/^0x[0-9a-f]+$/); // hex quantities, as bundlers expect
    expect(wire.paymaster).toBeDefined();
    expect(built.userOp.callGasLimit).toBe(900_000n); // 400k: the larger of x1.5 and +500k

    const hash = await bundler.sendUserOperation({ ...built.userOp, signature: DUMMY_ACCOUNT_SIGNATURE }, entryPoint07Address);
    expect(hash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(await bundler.getUserOperationReceipt(hash)).toMatchObject({ success: true });
    expect(await bundler.getUserOperationReceipt(`0x${"ee".repeat(32)}`)).toBeNull();
  });

  test("an unsigned operation is rejected by the stub the way a bundler would", async () => {
    const stub = createRundlerStub(entryPoint07Address);
    const bundler = createHttpBundler({ url: "http://bundler.invalid", fetch: stub.fetch as never });
    const { services } = createTestServices();
    const built = await buildUserOp(services, { account: ACCOUNT, calls: [{ to: ENGINE, value: 0n, data: "0x12345678" }], sponsor: false });
    await expect(bundler.sendUserOperation(built.userOp, entryPoint07Address)).rejects.toBeInstanceOf(BundlerError);
  });

  test("transport failures and malformed answers are BundlerErrors, not crashes", async () => {
    const down = createHttpBundler({ url: "http://x.invalid", fetch: (async () => { throw new TypeError("network"); }) as never });
    await expect(down.getUserOperationReceipt(`0x${"aa".repeat(32)}`)).rejects.toThrow("unreachable");
    const http500 = createHttpBundler({ url: "http://x.invalid", fetch: (async () => new Response("no", { status: 500 })) as never });
    await expect(http500.getUserOperationReceipt(`0x${"aa".repeat(32)}`)).rejects.toThrow("HTTP 500");
    const junk = createHttpBundler({ url: "http://x.invalid", fetch: (async () => new Response(JSON.stringify({ result: { nope: 1 } }))) as never });
    const { services } = createTestServices();
    const built = await buildUserOp(services, { account: ACCOUNT, calls: [{ to: ENGINE, value: 0n, data: "0x12345678" }], sponsor: false });
    await expect(junk.estimateUserOperationGas(built.userOp, entryPoint07Address)).rejects.toThrow("unusable estimate");
  });

  test("a bundler that cannot estimate leaves the builder on its fallbacks", async () => {
    const broken = createHttpBundler({ url: "http://x.invalid", fetch: (async () => new Response(JSON.stringify({ error: { code: -32500, message: "AA23 reverted" } }))) as never });
    const { services } = createTestServices();
    const calls = [{ to: ENGINE, value: 0n, data: "0x12345678" as const }];
    const built = await buildUserOp({ ...services, bundler: broken }, { account: ACCOUNT, calls, sponsor: false });
    expect(built.estimated).toBe(false);
    expect(built.userOp.callGasLimit).toBe(1_500_000n);
    // F25: the same failure on a sponsored operation is refused instead of signed over the fallbacks.
    await expect(buildUserOp({ ...services, bundler: broken }, { account: ACCOUNT, calls, sponsor: true })).rejects.toMatchObject({ apiError: "SPONSOR_SIMULATION_FAILED" });
  });

  test("a local Bun server speaks the same protocol (real HTTP, loopback only)", async () => {
    const stub = createRundlerStub(entryPoint07Address);
    const server = Bun.serve({
      port: 0, hostname: "127.0.0.1",
      async fetch(request) { return await stub.fetch("", { body: await request.text() }); },
    });
    try {
      const bundler = createHttpBundler({ url: `http://127.0.0.1:${server.port}`, timeoutMs: 2_000 });
      const { services } = createTestServices();
      const built = await buildUserOp({ ...services, bundler }, { account: ACCOUNT, calls: [{ to: ENGINE, value: 0n, data: "0x12345678" }], sponsor: false });
      expect(built.estimated).toBe(true);
    } finally {
      server.stop(true);
    }
  });
});
