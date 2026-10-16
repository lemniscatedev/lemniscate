import { z } from "zod";
import { ToolError } from "./api-client";
import type { KeyedLimiter } from "./rate-limit";
import { TOOLS, type ToolContext, type ToolDefinition } from "./tools";

export const SUPPORTED_PROTOCOLS = ["2025-06-18", "2025-03-26", "2024-11-05"] as const;
const INSTRUCTIONS = "Lemniscate everlasting options on Robinhood Chain. Quote and read freely. Trading tools act only through the account owner's agent policy and fail closed.";

type Id = string | number | null;
export interface RpcResponse { jsonrpc: "2.0"; id: Id; result?: unknown; error?: { code: number; message: string; data?: unknown } }

const rpcError = (id: Id, code: number, message: string): RpcResponse => ({ jsonrpc: "2.0", id, error: { code, message } });

export function toolListing(tools: readonly ToolDefinition<any>[] = TOOLS) {
  return tools.map((tool) => {
    const schema = z.toJSONSchema(tool.input, { io: "input" }) as Record<string, unknown>;
    return {
      name: tool.name, description: tool.description, inputSchema: schema,
      annotations: { readOnlyHint: !tool.execution, destructiveHint: false, openWorldHint: true },
    };
  });
}

export interface McpServerOptions {
  readonly context: ToolContext;
  readonly limiter: KeyedLimiter;
  readonly version?: string;
  readonly tools?: readonly ToolDefinition<any>[];
}

export function createMcpServer(options: McpServerOptions) {
  const tools = options.tools ?? TOOLS;
  const byName = new Map(tools.map((t) => [t.name, t]));
  const listing = toolListing(tools);

  const toolResult = (data: unknown, isError = false) => {
    const structured = data !== null && typeof data === "object" && !Array.isArray(data) ? data : { value: data };
    return { content: [{ type: "text", text: JSON.stringify(structured) }], structuredContent: structured, isError };
  };
  const toolFailure = (code: string, message: string, extra: Record<string, unknown> = {}) => toolResult({ error: code, message, ...extra }, true);

  async function callTool(params: unknown, callerKey: string) {
    const parsed = z.object({ name: z.string(), arguments: z.record(z.string(), z.unknown()).optional() }).safeParse(params);
    if (!parsed.success) return { error: rpcError(null, -32602, "Invalid params.").error! };
    const tool = byName.get(parsed.data.name);
    if (!tool) return { error: { code: -32602, message: `Unknown tool: ${parsed.data.name}` } };
    const taken = options.limiter.take(callerKey);
    if (!taken.ok) return { result: toolFailure("RATE_LIMITED", "Too many calls from this agent. Slow down.", { retryAfterSeconds: taken.retryAfterSeconds }) };
    const args = tool.input.safeParse(parsed.data.arguments ?? {});
    if (!args.success) {
      return { result: toolFailure("BAD_ARGUMENTS", args.error.issues.map((i: z.core.$ZodIssue) => `${i.path.join(".") || "arguments"}: ${i.message}`).join("; ")) };
    }
    try {
      return { result: toolResult(await tool.run(options.context, args.data)) };
    } catch (error) {
      if (error instanceof ToolError) {
        return { result: toolFailure(error.code, error.message, error.detail === undefined ? {} : { reason: error.detail }) };
      }
      // Unknown failure: say nothing about internals (an RPC URL or key could be inside the message).
      return { result: toolFailure("INTERNAL_ERROR", "The tool failed unexpectedly.") };
    }
  }

  /** Handle one JSON-RPC message. Returns null for notifications and responses (nothing to send back). */
  async function handle(message: unknown, callerKey: string): Promise<RpcResponse | null> {
    if (!message || typeof message !== "object" || Array.isArray(message)) return rpcError(null, -32600, "Invalid request.");
    const m = message as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
    const hasId = typeof m.id === "string" || typeof m.id === "number";
    if (m.jsonrpc !== "2.0" || typeof m.method !== "string") {
      return "result" in m || "error" in m ? null : rpcError(hasId ? m.id as Id : null, -32600, "Invalid request.");
    }
    if (!hasId) return null; // notification
    const id = m.id as Id;
    switch (m.method) {
      case "initialize": {
        const requested = (m.params as { protocolVersion?: unknown } | undefined)?.protocolVersion;
        const protocolVersion = (SUPPORTED_PROTOCOLS as readonly unknown[]).includes(requested) ? requested : SUPPORTED_PROTOCOLS[0];
        return { jsonrpc: "2.0", id, result: {
          protocolVersion, capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "lemniscate", version: options.version ?? "0.1.0" }, instructions: INSTRUCTIONS,
        } };
      }
      case "ping": return { jsonrpc: "2.0", id, result: {} };
      case "tools/list": return { jsonrpc: "2.0", id, result: { tools: listing } };
      case "tools/call": {
        const outcome = await callTool(m.params, callerKey);
        return "error" in outcome ? { jsonrpc: "2.0", id, error: outcome.error } : { jsonrpc: "2.0", id, result: outcome.result };
      }
      default: return rpcError(id, -32601, `Method not found: ${m.method}`);
    }
  }

  return { handle, listing };
}
export type McpServer = ReturnType<typeof createMcpServer>;
