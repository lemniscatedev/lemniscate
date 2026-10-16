import { createHash, timingSafeEqual } from "node:crypto";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { McpServer } from "./server";

export interface McpHttpOptions {
  /** Bearer token. Required whenever the server holds an agent key. */
  readonly token: string | undefined;
  readonly allowedOrigins: readonly string[];
}

const digest = (value: string) => createHash("sha256").update(value).digest();

/** MCP streamable HTTP, request/response flavour: POST /mcp with one JSON-RPC message (or a batch), JSON back. */
export function createMcpHttpApp(server: McpServer, options: McpHttpOptions) {
  const app = new Hono();
  const origins = new Set(options.allowedOrigins);
  app.use("/mcp", bodyLimit({ maxSize: 64 * 1024, onError: (c) => c.json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Request too large." } }, 413) }));
  app.use("/mcp", async (context, next) => {
    // DNS-rebinding guard: a browser page on another origin must not reach a local agent server.
    const origin = context.req.header("origin");
    if (origin && !origins.has(origin)) return context.json({ error: "FORBIDDEN_ORIGIN" }, 403);
    if (options.token) {
      const supplied = context.req.header("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
      if (!timingSafeEqual(digest(supplied), digest(options.token))) return context.json({ error: "UNAUTHORIZED" }, 401);
    }
    return next();
  });
  app.post("/mcp", async (context) => {
    let body: unknown;
    try { body = await context.req.json(); }
    catch { return context.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error." } }, 400); }
    // Per caller: the bearer token if present, else the client address.
    const bearer = context.req.header("authorization");
    const callerKey = bearer ? `t:${digest(bearer).toString("hex").slice(0, 16)}`
      : `ip:${context.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "local"}`;
    const batch = Array.isArray(body);
    const messages: unknown[] = Array.isArray(body) ? body : [body];
    if (messages.length === 0 || messages.length > 20) return context.json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid batch." } }, 400);
    const responses = (await Promise.all(messages.map((m) => server.handle(m, callerKey)))).filter((r) => r !== null);
    if (responses.length === 0) return context.body(null, 202);
    context.header("Cache-Control", "no-store");
    return context.json(batch ? responses : responses[0]!, 200);
  });
  // No server-initiated stream and no sessions: say so, as the transport spec allows.
  app.on(["GET", "DELETE"], "/mcp", (context) => context.json({ error: "METHOD_NOT_ALLOWED" }, 405, { Allow: "POST" }));
  return app;
}
