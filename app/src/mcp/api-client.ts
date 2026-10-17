import { AsyncLocalStorage } from "node:async_hooks";

/** The address of the MCP caller whose tool call is running. The API counts rate limits per client address, and every
 * MCP request reaches it from 127.0.0.1, so the caller's address is forwarded (X-Forwarded-For) or all MCP users would
 * share one bucket (F40). Set by the HTTP transport around each request; absent for stdio. */
export const callerAddress = new AsyncLocalStorage<string>();

export class ToolError extends Error {
  constructor(readonly code: string, message: string, readonly detail?: unknown) {
    super(message);
    this.name = "ToolError";
  }
}

export interface ApiClient {
  get(path: string): Promise<unknown>;
  post(path: string, body: unknown): Promise<unknown>;
}

/** Thin JSON client for the REST API (todo 15). A non-2xx answer becomes a ToolError carrying the API's own code. */
export function createApiClient(baseUrl: string, fetchImpl: typeof fetch = fetch, timeoutMs = 15_000): ApiClient {
  async function call(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
    let response: Response;
    try {
      const forwarded = callerAddress.getStore();
      response = await fetchImpl(`${baseUrl}${path}`, {
        method, headers: {
          accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...(forwarded ? { "x-forwarded-for": forwarded } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw new ToolError("API_UNREACHABLE", "The Lemniscate API did not answer. Try again shortly.");
    }
    const text = await response.text();
    let json: unknown = null;
    try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON error page */ }
    if (!response.ok) {
      const record = json && typeof json === "object" ? json as Record<string, unknown> : {};
      throw new ToolError(
        typeof record.error === "string" ? record.error : `HTTP_${response.status}`,
        typeof record.message === "string" ? record.message : `The API answered ${response.status}.`,
        record.reason,
      );
    }
    return json;
  }
  return { get: (path) => call("GET", path), post: (path, body) => call("POST", path, body) };
}
