import {
  createPublicClient,
  createWalletClient,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { RuntimeConfig } from "../config";
import { createRpcPool, type RpcPool } from "./rpc-pool";
import { robinhoodChain } from "./chain";

export interface ServiceClients {
  readonly logsClient: PublicClient;
  readonly stateClient: PublicClient;
  readonly txClient: PublicClient;
  readonly walletClient?: WalletClient;
  readonly pool: RpcPool;
}

/** `signerKey` is passed only by the keeper; other services get read-only clients. */
export function createClients(
  config: RuntimeConfig,
  pool = createRpcPool(config),
  signerKey?: `0x${string}`,
): ServiceClients {
  if (config.CHAIN_ID !== robinhoodChain.id) {
    throw new Error(`Unsupported chain id ${config.CHAIN_ID}; this service only supports 4663`);
  }

  pool.startHourlyReporter();
  const clientOptions = { chain: robinhoodChain, batch: { multicall: true } } as const;
  const logsClient = createPublicClient({
    ...clientOptions,
    transport: pool.transport("logs"),
  });
  const stateClient = createPublicClient({
    ...clientOptions,
    transport: pool.transport("state"),
  });
  const txClient = createPublicClient({
    ...clientOptions,
    transport: pool.transport("tx"),
  });

  if (!signerKey) return { logsClient, stateClient, txClient, pool };

  const account = privateKeyToAccount(signerKey);
  const walletClient = createWalletClient({
    account,
    chain: robinhoodChain,
    transport: pool.transport("tx"),
  });
  return { logsClient, stateClient, txClient, walletClient, pool };
}
