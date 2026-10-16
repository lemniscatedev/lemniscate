import { describe, expect, test } from "bun:test";
import { createClients } from "./clients";
import { chainFor } from "./chain";
import { loadConfig } from "../config";

const base = { DATABASE_URL: "postgres://u:p@127.0.0.1:5432/db", POSTGRES_PASSWORD: "x", RPC_URL_OVERRIDE: "http://127.0.0.1:1" };

describe("chain ids the services run on (todo 23: the anvil fork is 31337, never 4663)", () => {
  test("createClients accepts the fork (31337) and testnet (46630) ids, not only mainnet", () => {
    for (const id of [4663, 31337, 46630]) {
      const clients = createClients(loadConfig({ ...base, CHAIN_ID: String(id) }));
      expect(clients.chainId).toBe(id);
      expect(clients.stateClient.chain?.id).toBe(id);
    }
  });
  test("any other chain id is refused", () => {
    expect(() => createClients(loadConfig({ ...base, CHAIN_ID: "1" }))).toThrow("Unsupported chain id 1");
    expect(() => chainFor(1)).toThrow();
  });
});
