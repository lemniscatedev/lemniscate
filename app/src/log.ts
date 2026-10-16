import { knownSecrets } from "./keys";
import pino, { type Logger } from "pino";

const redactPaths = [
  "DATABASE_URL",
  "ALCHEMY_API_KEYS",
  "KEEPER_PRIVATE_KEY",
  "HEDGER_PRIVATE_KEY",
  "VOL_SIGNER_KEY",
  "VOL_SENDER_KEY",
  "PAYMASTER_SIGNER_KEY",
  "X402_SETTLER_KEY",
  "AGENT_KEY",
  "FORK_RPC_URL",
  "RPC_URL_OVERRIDE",
  "*.url",
  "*.privateKey",
  "*.secret",
];

export function safeErrorSummary(error: unknown): { name: string; message: string } {
  const record = error && typeof error === "object" ? (error as Record<string, unknown>) : undefined;
  const cause = record?.cause;
  const causeRecord = cause && typeof cause === "object" ? (cause as Record<string, unknown>) : undefined;
  const name =
    error instanceof Error
      ? error.name
      : typeof record?.name === "string"
        ? record.name
        : "Error";
  const outerMessage = error instanceof Error
    ? error.message
    : typeof record?.message === "string"
      ? record.message
      : typeof record?.shortMessage === "string"
        ? record.shortMessage
        : String(error);
  const causeMessage =
    cause instanceof Error
      ? cause.message
      : typeof causeRecord?.message === "string"
        ? causeRecord.message
        : typeof causeRecord?.shortMessage === "string"
          ? causeRecord.shortMessage
          : undefined;
  const rawMessage = causeMessage ?? (/^failed query:/i.test(outerMessage) ? "Database query failed" : outerMessage);
  const rawCode = record?.code ?? causeRecord?.code;
  const code = typeof rawCode === "string" || typeof rawCode === "number" ? rawCode : undefined;
  let message = code === undefined ? rawMessage : `${rawMessage} (code ${code})`;
  const sensitiveValues = [
    ...(process.env.ALCHEMY_API_KEYS ?? "").split(","),
    process.env.DATABASE_URL ?? "",
    process.env.KEEPER_PRIVATE_KEY ?? "",
    ...knownSecrets(),
    process.env.FORK_RPC_URL ?? "",
    process.env.RPC_URL_OVERRIDE ?? "",
  ].filter((value) => value.length > 0);

  for (const value of sensitiveValues) message = message.split(value).join("[REDACTED]");
  message = message
    .replace(/https?:\/\/[^\s)'"<>]+/gi, "[URL]")
    .replace(/\/v2\/[^/?\s]+/gi, "/v2/[REDACTED]")
    .replace(/(api[_-]?key|token|secret)\s*[=:]\s*[^\s,;]+/gi, "$1=[REDACTED]");

  return { name, message: message.slice(0, 1000) };
}

export function createLogger(level = process.env.LOG_LEVEL ?? "info", name = "lemniscate"): Logger {
  return pino({
    name,
    level,
    redact: { paths: redactPaths, censor: "[REDACTED]" },
    serializers: { err: safeErrorSummary },
    base: { service: name },
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}

export const logger = createLogger();
