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

export type Deployment = z.infer<typeof deploymentSchema>;

export class DeploymentFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeploymentFileError";
  }
}

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

export function assertDeploymentNetwork(deployment: Deployment, config: RuntimeConfig): void {
  if (deployment.chainId !== config.CHAIN_ID || deployment.network !== config.NETWORK) {
    throw new DeploymentFileError(
      `Deployment targets ${deployment.network}/${deployment.chainId}; service is configured for ${config.NETWORK}/${config.CHAIN_ID}`,
    );
  }
}
