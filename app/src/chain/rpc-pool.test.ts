import { expect, test } from "bun:test";
import { loadConfig } from "../config";
import { createRpcPool } from "./rpc-pool";

test("fee reads on the tx route are never served from cache", async () => {
  const config = loadConfig({
    DATABASE_URL: "postgres://user:pass@localhost:5432/test", POSTGRES_PASSWORD: "x",
    RPC_URL_OVERRIDE: "http://127.0.0.1:1",
  });
  let calls = 0;
  const pool = createRpcPool(config, { requestFactory: () => async () => `0x${(++calls).toString(16)}` });
  expect(await pool.request("tx", { method: "eth_gasPrice" })).toBe("0x1");
  expect(await pool.request("tx", { method: "eth_gasPrice" })).toBe("0x2");
  // Non-transaction readers may share a short-lived cached value.
  expect(await pool.request("state", { method: "eth_gasPrice" })).toBe("0x3");
  expect(await pool.request("state", { method: "eth_gasPrice" })).toBe("0x3");
});

test("a single endpoint that had one transient failure is still tried (todo 23: the fork's indexer stalled for minutes)", async () => {
  const config = loadConfig({
    DATABASE_URL: "postgres://user:pass@localhost:5432/test", POSTGRES_PASSWORD: "x",
    RPC_URL_OVERRIDE: "http://127.0.0.1:1",
  });
  let calls = 0;
  const pool = createRpcPool(config, {
    requestFactory: () => async () => {
      calls++;
      if (calls === 1) throw Object.assign(new Error("request timed out"), { status: 503 });
      return "0x10";
    },
  });
  await expect(pool.request("logs", { method: "eth_blockNumber" })).rejects.toThrow();
  // Within the cool-down there is nothing else to fail over to: the endpoint must be retried, not skipped.
  expect(await pool.request("logs", { method: "eth_getLogs", params: [{}] })).toBe("0x10");
  expect(calls).toBe(2);
});
