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
