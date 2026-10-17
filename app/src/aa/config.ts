import { z } from "zod";
import { entryPoint07Address } from "viem/account-abstraction";
import { KEY_ROLES, KeyConfigError, resolveKey } from "../keys";

const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "expected a 20-byte EVM address")
  .transform((value) => value.toLowerCase() as `0x${string}`);
const optionalAddress = z.preprocess((value) => (value === "" ? undefined : value), address.optional());
const wei = z.coerce.bigint().nonnegative();

/** Kernel v3.3 and its ECDSA validator on Robinhood Chain (mainnet 4663 and testnet 46630), verified with cast. */
export const KERNEL_V33_FACTORY = "0x2577507b78c2008Ff367261CB6285d44ba5eF2E9";
export const KERNEL_ECDSA_VALIDATOR = "0x845ADb2C711129d4f3966735eD98a9F09fC4cE57";

const schema = z.object({
  CHAIN_ID: z.coerce.number().int().positive().default(4663),
  /** Any ERC-4337 v0.7 bundler. The default is the free public endpoint for the configured chain. */
  BUNDLER_URL: z.preprocess((value) => (value === "" ? undefined : value), z.string().url().optional()),
  AA_ENTRYPOINT: address.default(entryPoint07Address.toLowerCase() as `0x${string}`),
  AA_KERNEL_FACTORY: address.default(KERNEL_V33_FACTORY.toLowerCase() as `0x${string}`),
  AA_KERNEL_VALIDATOR: address.default(KERNEL_ECDSA_VALIDATOR.toLowerCase() as `0x${string}`),
  /** Empty: sponsorship is off and every account pays its own gas. */
  PAYMASTER_ADDRESS: optionalAddress,
  /** The sponsoring signer's key is read by keys.ts: PAYMASTER_SIGNER_KEY (development) or PAYMASTER_SIGNER_KEYSTORE +
   * PAYMASTER_SIGNER_KEYSTORE_PASSWORD_FILE (the only form NODE_ENV=production accepts). The only key this service holds. */
  PAYMASTER_VALIDITY_SECONDS: z.coerce.number().int().min(60).max(3_600).default(300),
  AA_BUNDLER_TIMEOUT_MS: z.coerce.number().int().min(500).max(60_000).default(8_000),
  /** Conservative gas limits used when the bundler cannot estimate. */
  AA_FALLBACK_CALL_GAS: wei.default(1_500_000n),
  AA_FALLBACK_VERIFICATION_GAS: wei.default(700_000n),
  AA_FALLBACK_DEPLOY_VERIFICATION_GAS: wei.default(1_800_000n),
  AA_FALLBACK_PRE_VERIFICATION_GAS: wei.default(300_000n),
  AA_FALLBACK_PAYMASTER_VERIFICATION_GAS: wei.default(200_000n),
  AA_FALLBACK_PAYMASTER_POST_OP_GAS: wei.default(80_000n),
  /** Used only when the node gives no fee. 0.5 gwei keeps a deploy operation at the fallback gas limits (3.88M gas)
   * under the paymaster's maxCostPerOp of 0.002 ETH (decision 45); Robinhood Chain fees are far below it. */
  AA_FALLBACK_MAX_FEE_PER_GAS: wei.default(500_000_000n),
  AA_FALLBACK_PRIORITY_FEE_PER_GAS: wei.default(10_000_000n),
  /** Mirror of LemniscatePaymaster.maxCostPerOp (wei). A sponsored operation is priced under it or not signed. */
  PAYMASTER_MAX_COST_PER_OP_WEI: wei.default(2_000_000_000_000_000n),
});

/** LemniscatePaymaster.maxCostPerOp at launch (decision 45): 0.002 ETH. */
export const DEFAULT_MAX_COST_PER_OP_WEI = 2_000_000_000_000_000n;

export interface AaConfig {
  readonly chainId: number;
  readonly bundlerUrl: string;
  readonly entryPoint: `0x${string}`;
  readonly kernelFactory: `0x${string}`;
  readonly kernelValidator: `0x${string}`;
  readonly paymaster: {
    readonly address: `0x${string}`; readonly signerKey: `0x${string}`; readonly validitySeconds: number;
    /** LemniscatePaymaster.maxCostPerOp mirror (default 0.002 ETH). */
    readonly maxCostPerOpWei?: bigint;
  } | null;
  readonly bundlerTimeoutMs: number;
  readonly fallback: {
    readonly callGas: bigint; readonly verificationGas: bigint; readonly deployVerificationGas: bigint;
    readonly preVerificationGas: bigint; readonly paymasterVerificationGas: bigint; readonly paymasterPostOpGas: bigint;
    readonly maxFeePerGas: bigint; readonly priorityFeePerGas: bigint;
  };
}

export class AaConfigError extends Error {
  constructor(message: string) { super(message); this.name = "AaConfigError"; }
}

/** The key-free part of the AA settings: what the public smart-account route needs. It never touches a key, a keystore
 * or the filesystem (F33), so a request handler can call it safely. */
export interface AaPublicConfig {
  readonly chainId: number;
  readonly entryPoint: `0x${string}`;
  readonly kernelFactory: `0x${string}`;
  readonly kernelValidator: `0x${string}`;
}

export function loadAaPublicConfig(source: Record<string, string | undefined> = process.env): AaPublicConfig {
  const parsed = schema.pick({ CHAIN_ID: true, AA_ENTRYPOINT: true, AA_KERNEL_FACTORY: true, AA_KERNEL_VALIDATOR: true }).safeParse(source);
  if (!parsed.success) {
    throw new AaConfigError(`Invalid account abstraction configuration: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }
  const env = parsed.data;
  return { chainId: env.CHAIN_ID, entryPoint: env.AA_ENTRYPOINT, kernelFactory: env.AA_KERNEL_FACTORY, kernelValidator: env.AA_KERNEL_VALIDATOR };
}

/** Reads the AA settings from the environment (they are not part of the core service config). */
export function loadAaConfig(source: Record<string, string | undefined> = process.env): AaConfig {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    throw new AaConfigError(`Invalid account abstraction configuration: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
  }
  const env = parsed.data;
  let signerKey: `0x${string}` | undefined;
  try {
    signerKey = resolveKey(KEY_ROLES.paymasterSigner, source);
  } catch (error) {
    if (error instanceof KeyConfigError) throw new AaConfigError(`Invalid account abstraction configuration: ${error.message}`);
    throw error;
  }
  // Decision 45: a deploy operation at the fallback limits and fee must fit the paymaster's maxCostPerOp.
  const deployGas = env.AA_FALLBACK_PRE_VERIFICATION_GAS + env.AA_FALLBACK_DEPLOY_VERIFICATION_GAS + env.AA_FALLBACK_CALL_GAS
    + env.AA_FALLBACK_PAYMASTER_VERIFICATION_GAS + env.AA_FALLBACK_PAYMASTER_POST_OP_GAS;
  if (deployGas * env.AA_FALLBACK_MAX_FEE_PER_GAS > env.PAYMASTER_MAX_COST_PER_OP_WEI) {
    throw new AaConfigError("AA_FALLBACK_MAX_FEE_PER_GAS x the fallback deploy gas exceeds the paymaster's maxCostPerOp (PAYMASTER_MAX_COST_PER_OP_WEI)");
  }
  if (env.AA_FALLBACK_PRIORITY_FEE_PER_GAS > env.AA_FALLBACK_MAX_FEE_PER_GAS) {
    throw new AaConfigError("AA_FALLBACK_PRIORITY_FEE_PER_GAS must not exceed AA_FALLBACK_MAX_FEE_PER_GAS");
  }
  if ((env.PAYMASTER_ADDRESS === undefined) !== (signerKey === undefined)) {
    throw new AaConfigError("PAYMASTER_ADDRESS and the paymaster signer key (PAYMASTER_SIGNER_KEY or PAYMASTER_SIGNER_KEYSTORE) must be set together or both left empty");
  }
  return {
    chainId: env.CHAIN_ID,
    bundlerUrl: env.BUNDLER_URL ?? `https://public.pimlico.io/v2/${env.CHAIN_ID}/rpc`,
    entryPoint: env.AA_ENTRYPOINT,
    kernelFactory: env.AA_KERNEL_FACTORY,
    kernelValidator: env.AA_KERNEL_VALIDATOR,
    paymaster: env.PAYMASTER_ADDRESS && signerKey
      ? { address: env.PAYMASTER_ADDRESS, signerKey, validitySeconds: env.PAYMASTER_VALIDITY_SECONDS, maxCostPerOpWei: env.PAYMASTER_MAX_COST_PER_OP_WEI }
      : null,
    bundlerTimeoutMs: env.AA_BUNDLER_TIMEOUT_MS,
    fallback: {
      callGas: env.AA_FALLBACK_CALL_GAS, verificationGas: env.AA_FALLBACK_VERIFICATION_GAS,
      deployVerificationGas: env.AA_FALLBACK_DEPLOY_VERIFICATION_GAS, preVerificationGas: env.AA_FALLBACK_PRE_VERIFICATION_GAS,
      paymasterVerificationGas: env.AA_FALLBACK_PAYMASTER_VERIFICATION_GAS, paymasterPostOpGas: env.AA_FALLBACK_PAYMASTER_POST_OP_GAS,
      maxFeePerGas: env.AA_FALLBACK_MAX_FEE_PER_GAS, priorityFeePerGas: env.AA_FALLBACK_PRIORITY_FEE_PER_GAS,
    },
  };
}
