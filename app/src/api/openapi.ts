import { readFile } from "node:fs/promises";

interface PackageMetadata { version?: string }
const packageMetadata = JSON.parse(
  await readFile(new URL("../../package.json", import.meta.url), "utf8"),
) as PackageMetadata;

export const openApiDocument = {
  openapi: "3.1.0" as const,
  info: {
    title: "Lemniscate API",
    version: packageMetadata.version ?? "0.1.0",
    description: "Read-only market, account and vault data for Lemniscate.",
  },
  tags: [
    { name: "system", description: "Runtime configuration and service health" },
    { name: "markets", description: "Market prices, candles, carry and activity" },
    { name: "accounts", description: "Wallet portfolio and activity" },
    { name: "vault", description: "Writer Pool vault state and history" },
  ],
};
