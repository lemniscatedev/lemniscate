import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { RuntimeConfig } from "../config";

const addressSchema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{40}$/, "expected a 20-byte EVM address")
  .transform((address) => address.toLowerCase() as `0x${string}`);

const blockSchema = z.union([
  z.number().int().nonnegative().safe(),
  z.string().regex(/^\d+$/).transform(Number),
]);

const scaleSchema = z.union([
  z.number().positive(),
  z.string().regex(/^\d+(?:\.\d+)?$/).transform(Number),
]);

/** @deprecated Layout of the retired power-payoff deployment. Still read by the keeper and API until todos 13 and 15
 * move to {@link OptionDeployment}; nothing new may use it. */
const deploymentSchema = z.object({
  chainId: z.literal(4663),
  network: z.enum(["mainnet", "fork"]),
  deployBlock: blockSchema,
  deployer: addressSchema,
  admin: addressSchema,
  keeper: addressSchema,
  contracts: z.object({
    engine: addressSchema,
    vault: addressSchema,
    marketHours: addressSchema,
    lens: addressSchema,
    hedgeAdapter: addressSchema,
    usdg: addressSchema,
    engineImpl: addressSchema,
    vaultImpl: addressSchema,
    marketHoursImpl: addressSchema,
  }),
  forkProof: z
    .object({
      blockNumber: z.number().int().nonnegative().safe(),
      blockHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
    })
    .optional(),
  markets: z.array(
    z.object({
      id: z.number().int().min(0).max(255),
      symbol: z.string().min(1).max(16),
      token: addressSchema,
      stock: addressSchema,
      feed: addressSchema,
      scale: scaleSchema,
      poolFee: z.number().int().nonnegative(),
      listing: z.object({
        transactionHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
        blockNumber: z.number().int().positive().safe(),
        blockHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
      }).optional(),
    }),
  ),
});

/** @deprecated see deploymentSchema */
export type Deployment = z.infer<typeof deploymentSchema>;

export class DeploymentFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeploymentFileError";
  }
}

/** @deprecated reads the retired layout; use loadOptionDeployment. */
export async function loadDeployment(filePath: string): Promise<Deployment> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    const code = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
    throw new DeploymentFileError(
      code === "ENOENT"
        ? `Deployment file does not exist: ${filePath}`
        : `Could not read deployment file: ${filePath}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new DeploymentFileError(`Deployment file is not valid JSON: ${filePath}`);
  }

  const result = deploymentSchema.safeParse(parsed);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join(".") || "deployment"}: ${issue.message}`)
      .join("; ");
    throw new DeploymentFileError(`Invalid deployment file ${filePath}: ${details}`);
  }
  return result.data;
}

export function assertDeploymentNetwork(
  deployment: { readonly chainId: number; readonly network: string },
  config: RuntimeConfig,
): void {
  if (deployment.chainId !== config.CHAIN_ID || deployment.network !== config.NETWORK) {
    throw new DeploymentFileError(
      `Deployment targets ${deployment.network}/${deployment.chainId}; service is configured for ${config.NETWORK}/${config.CHAIN_ID}`,
    );
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Everlasting option system deployment
// ---------------------------------------------------------------------------------------------------------------

const stockEntrySchema = z.object({
  /** Ticker the product shows, upper case: NVDA, TSLA, SPY, QQQ, HOOD. */
  name: z.string().regex(/^[A-Z0-9.]{1,12}$/, "expected an upper case ticker"),
  stock: addressSchema,
  feed: addressSchema.optional(),
});

const optionDeploymentSchema = z.object({
  chainId: z.literal(4663),
  network: z.enum(["mainnet", "fork"]),
  /** First block the indexer reads (the engine deployment block). */
  deployBlock: blockSchema,
  deployer: addressSchema.optional(),
  admin: addressSchema.optional(),
  keeper: addressSchema.optional(),
  contracts: z.object({
    engine: addressSchema,
    pool: addressSchema,
    registry: addressSchema,
    priceGuard: addressSchema,
    volOracle: addressSchema,
    usdg: addressSchema,
    marketHours: addressSchema.optional(),
    agentRouter: addressSchema.optional(),
    /** Holds the loss-absorbing reserve in USDG; its balance is reported as pool_nav.reserve. */
    reserve: addressSchema.optional(),
    feeRouter: addressSchema.optional(),
  }),
  /** Decimals of the pool share token (ERC-4626 shares). The reference vault used 12 (6 asset + 6 offset). */
  poolShareDecimals: z.number().int().min(0).max(36).default(12),
  stocks: z.array(stockEntrySchema).min(1),
  forkProof: z
    .object({
      blockNumber: z.number().int().nonnegative().safe(),
      blockHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
    })
    .optional(),
});

export type OptionDeployment = z.infer<typeof optionDeploymentSchema>;
export type OptionStock = OptionDeployment["stocks"][number];

export function parseOptionDeployment(raw: unknown, label = "deployment"): OptionDeployment {
  const result = optionDeploymentSchema.safeParse(raw);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => `${issue.path.join(".") || "deployment"}: ${issue.message}`)
      .join("; ");
    throw new DeploymentFileError(`Invalid deployment file ${label}: ${details}`);
  }
  const names = new Set<string>();
  const stocks = new Set<string>();
  for (const entry of result.data.stocks) {
    if (names.has(entry.name) || stocks.has(entry.stock)) {
      throw new DeploymentFileError(`Invalid deployment file ${label}: stocks contains a duplicate name or address`);
    }
    names.add(entry.name);
    stocks.add(entry.stock);
  }
  return result.data;
}

export async function loadOptionDeployment(filePath: string): Promise<OptionDeployment> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (error) {
    const code = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
    throw new DeploymentFileError(
      code === "ENOENT"
        ? `Deployment file does not exist: ${filePath}`
        : `Could not read deployment file: ${filePath}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new DeploymentFileError(`Deployment file is not valid JSON: ${filePath}`);
  }
  return parseOptionDeployment(parsed, filePath);
}
