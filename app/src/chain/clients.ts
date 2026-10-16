import {
  createPublicClient,
  createWalletClient,
  type PublicClient,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { RuntimeConfig } from "../config";
import { createRpcPool, type RpcPool } from "./rpc-pool";
import { chainFor } from "./chain";

export interface ServiceClients {
  readonly logsClient: PublicClient;
  readonly stateClient: PublicClient;
  readonly txClient: PublicClient;
  readonly walletClient?: WalletClient;
  readonly pool: RpcPool;
  /** The chain id every transaction is signed for (CHAIN_ID: 4663 mainnet, 31337 the anvil fork, 46630 testnet). */
  readonly chainId?: number;
}

/** `signerKey` is passed only by the keeper; other services get read-only clients. */
export function createClients(
  config: RuntimeConfig,
  pool = createRpcPool(config),
  signerKey?: `0x${string}`,
): ServiceClients {
  const chain = chainFor(config.CHAIN_ID);

  pool.startHourlyReporter();
  const clientOptions = { chain, batch: { multicall: true } } as const;
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

  if (!signerKey) return { logsClient, stateClient, txClient, pool, chainId: chain.id };

  const account = privateKeyToAccount(signerKey);
  const walletClient = createWalletClient({
    account,
    chain,
    transport: pool.transport("tx"),
  });
  return { logsClient, stateClient, txClient, walletClient, pool, chainId: chain.id };
}
