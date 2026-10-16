import type { McpServer } from "./server";

/** Newline-delimited JSON-RPC over stdio. Only protocol messages go to `write`; logs belong on stderr. */
export async function runStdio(
  server: McpServer, lines: AsyncIterable<string>, write: (line: string) => void, callerKey: string,
): Promise<void> {
  const pending = new Set<Promise<void>>();
  for await (const line of lines) {
    if (!line.trim()) continue;
    const job = (async () => {
      let parsed: unknown;
      try { parsed = JSON.parse(line); }
      catch { write(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error." } })); return; }
      const batch = Array.isArray(parsed) ? parsed : [parsed];
      for (const message of batch) {
        const response = await server.handle(message, callerKey);
        if (response) write(JSON.stringify(response));
      }
    })().finally(() => pending.delete(job));
    pending.add(job);
  }
  await Promise.all(pending);
}

export async function* stdinLines(stream: NodeJS.ReadableStream = process.stdin): AsyncGenerator<string> {
  let buffer = "";
  for await (const chunk of stream) {
    buffer += typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString("utf8");
    let index: number;
    while ((index = buffer.indexOf("\n")) >= 0) { yield buffer.slice(0, index); buffer = buffer.slice(index + 1); }
    if (buffer.length > 1_000_000) throw new Error("stdin line too long");
  }
  if (buffer) yield buffer;
}
