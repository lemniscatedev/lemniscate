import { defineChain } from "viem";

export const robinhoodChain = defineChain({
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: { decimals: 18, name: "Ether", symbol: "ETH" },
  rpcUrls: {
    default: { http: ["https://rpc.mainnet.chain.robinhood.com"] },
  },
  blockExplorers: {
    default: {
      name: "Blockscout",
      url: "https://robinhoodchain.blockscout.com",
    },
  },
  contracts: {
    multicall3: {
      address: "0xcA11bde05977b3631167028862bE2a173976CA11",
      blockCreated: 0,
    },
  },
});

/** The anvil mainnet fork (contracts/script/DeploySystem fork profile): mainnet state, chain id 31337 so nothing signed
 * on the fork can be replayed on mainnet. Multicall3 exists at the same address because the state is mainnet's. */
export const robinhoodFork = defineChain({
  ...robinhoodChain,
  id: 31337,
  name: "Robinhood Chain (anvil fork)",
  rpcUrls: { default: { http: ["http://127.0.0.1:8545"] } },
  blockExplorers: undefined,
});

/** Robinhood Chain testnet; Multicall3 has code there (chain-facts, todo 00). */
export const robinhoodTestnet = defineChain({
  ...robinhoodChain,
  id: 46630,
  name: "Robinhood Chain Testnet",
  rpcUrls: { default: { http: ["https://rpc.testnet.chain.robinhood.com"] } },
  blockExplorers: undefined,
});

export const SUPPORTED_CHAIN_IDS = [robinhoodChain.id, robinhoodFork.id, robinhoodTestnet.id] as const;

/** The viem chain for a service's CHAIN_ID; throws for anything but mainnet, the fork and testnet. */
export function chainFor(chainId: number) {
  if (chainId === robinhoodChain.id) return robinhoodChain;
  if (chainId === robinhoodFork.id) return robinhoodFork;
  if (chainId === robinhoodTestnet.id) return robinhoodTestnet;
  throw new Error(`Unsupported chain id ${chainId}; services run on ${SUPPORTED_CHAIN_IDS.join(", ")}`);
}
