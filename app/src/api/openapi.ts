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
    description: "Chains, quotes, unsigned transaction intents, pool, volatility and positions for Lemniscate everlasting options. Reads only Postgres.",
  },
  tags: [
    { name: "system", description: "Runtime configuration and service health" },
    { name: "markets", description: "Option chains, quotes, intents, series and volatility" },
    { name: "accounts", description: "Wallet positions, activity, agent policies and smart account" },
    { name: "vault", description: "Writer Pool state" },
  ],
};
