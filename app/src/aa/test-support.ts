import { type Address, type Hex } from "viem";
import { entryPoint07Address } from "viem/account-abstraction";
import type { AaChain } from "./chain";
import { KERNEL_ECDSA_VALIDATOR, KERNEL_V33_FACTORY, type AaConfig } from "./config";
import { createMockBundler, type MockBundlerOptions } from "./mock-bundler";
import { createSponsor } from "./paymaster";
import { KERNEL_V33_IMPLEMENTATION } from "./counterfactual";
import type { AaServices } from "./userop";

export const ENGINE = "0x00000000000000000000000000000000000000e1" as Address;
export const USDG = "0x00000000000000000000000000000000000000d1" as Address;
export const PAYMASTER = "0x2222222222222222222222222222222222222222" as Address;
export const OWNER = "0x00000000000000000000000000000000000000c3" as Address;
export const ACCOUNT = "0x00000000000000000000000000000000000000ac" as Address;
export const SIGNER_KEY = `0x${"0000000000000000000000000000000000000000000000000000000000a11ce0"}` as Hex; // test-key
export const NOW_MS = 1_792_200_100_000;

export function testConfig(overrides: Partial<AaConfig> = {}): AaConfig {
  return {
    chainId: 4663, bundlerUrl: "http://bundler.invalid", entryPoint: entryPoint07Address,
    kernelFactory: KERNEL_V33_FACTORY as Address, kernelValidator: KERNEL_ECDSA_VALIDATOR as Address,
    paymaster: { address: PAYMASTER, signerKey: SIGNER_KEY, validitySeconds: 300 },
    bundlerTimeoutMs: 1_000,
    fallback: {
      callGas: 1_500_000n, verificationGas: 700_000n, deployVerificationGas: 1_800_000n, preVerificationGas: 300_000n,
      paymasterVerificationGas: 200_000n, paymasterPostOpGas: 80_000n, maxFeePerGas: 2_000_000_000n, priorityFeePerGas: 1_000_000_000n,
    },
    ...overrides,
  };
}

export interface FakeChainState {
  deployed: Set<string>;
  nonces: Map<string, bigint>;
  predicted: Address;
  fees: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint } | null;
  reads: string[];
  down: boolean;
  /** Stored ECDSA owner per deployed account (lower case). */
  owners: Map<string, Address | null>;
  /** USDG-style balances per `${token}:${owner}` (lower case). */
  balances: Map<string, bigint>;
  /** LemniscatePaymaster.kernelAccount: null = every deployed account is known. */
  kernelAccounts: Set<string> | null;
  /** ERC-1967 implementation per account (lower case); absent = the Kernel v3.3 implementation. */
  implementations: Map<string, Address>;
}

export function createFakeChain(state: Partial<FakeChainState> = {}) {
  const s: FakeChainState = {
    deployed: new Set([ACCOUNT.toLowerCase()]), nonces: new Map(), predicted: ACCOUNT, fees: { maxFeePerGas: 1_000_000_000n, maxPriorityFeePerGas: 100_000_000n },
    reads: [], down: false, owners: new Map([[ACCOUNT.toLowerCase(), OWNER.toLowerCase() as Address]]), balances: new Map(),
    kernelAccounts: null, implementations: new Map(), ...state,
  };
  const chain: AaChain = {
    async isDeployed(account) { if (s.down) throw new Error("rpc down"); s.reads.push("code"); return s.deployed.has(account.toLowerCase()); },
    async entryPointNonce(_ep, sender, key) {
      if (s.down) throw new Error("rpc down");
      s.reads.push(`nonce:${key}`);
      return (key << 64n) | (s.nonces.get(`${sender.toLowerCase()}:${key}`) ?? 0n);
    },
    async predictKernelAddress() { s.reads.push("predict"); return s.predicted; },
    async feesPerGas() { return s.fees; },
    async kernelOwner(_validator, account) { if (s.down) throw new Error("rpc down"); s.reads.push("owner"); return s.owners.get(account.toLowerCase()) ?? null; },
    async tokenBalance(token, owner) { if (s.down) throw new Error("rpc down"); s.reads.push("balance"); return s.balances.get(`${token.toLowerCase()}:${owner.toLowerCase()}`) ?? 0n; },
    async paymasterKnowsAccount(_paymaster, account) {
      if (s.down) throw new Error("rpc down");
      s.reads.push("kernelAccount");
      return s.kernelAccounts ? s.kernelAccounts.has(account.toLowerCase()) : s.deployed.has(account.toLowerCase());
    },
    async implementationOf(account) {
      if (s.down) throw new Error("rpc down");
      s.reads.push("implementation");
      if (!s.deployed.has(account.toLowerCase())) return null;
      return (s.implementations.get(account.toLowerCase()) ?? KERNEL_V33_IMPLEMENTATION.toLowerCase()) as Address;
    },
  };
  return { chain, state: s };
}

export function createTestServices(options: { sponsor?: boolean; bundler?: MockBundlerOptions; chain?: Partial<FakeChainState>; agentRouter?: Address } = {}) {
  const fake = createFakeChain(options.chain);
  const mock = createMockBundler(options.bundler);
  const config = testConfig(options.sponsor === false ? { paymaster: null } : {});
  const services: AaServices = {
    config, chain: fake.chain, bundler: mock.bundler,
    sponsor: config.paymaster ? createSponsor({ ...config.paymaster, chainId: config.chainId }) : null,
    policy: { engine: ENGINE, usdg: USDG, agentRouter: options.agentRouter },
    now: () => NOW_MS,
  };
  return { services, ...fake, mock };
}
