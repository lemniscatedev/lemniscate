import { KEY_ROLES, keyVariables } from "../keys";
import { buildMcp, createMcpHttpApp, loadMcpSettings, runStdio, stdinLines } from "../mcp";

// Agent MCP server. Default: stdio (for an agent host). `--http`: streamable HTTP on MCP_HTTP_HOST:MCP_HTTP_PORT.
// stdout is the protocol channel in stdio mode, so every diagnostic goes to stderr and no secret is ever printed.
for (const role of [KEY_ROLES.keeper, KEY_ROLES.x402Settler]) for (const variable of keyVariables(role)) delete process.env[variable];

const settings = loadMcpSettings();
const { server, agent } = buildMcp(settings);
const note = (text: string) => process.stderr.write(`[lemniscate-mcp] ${text}\n`);
note(agent ? `execution enabled for agent ${agent.account.address}` : "read-only (no AGENT_KEY)");

if (process.argv.includes("--http")) {
  if (agent && !settings.httpToken) {
    note("refusing to serve HTTP with an agent key and no MCP_HTTP_TOKEN (16+ characters)");
    process.exit(1);
  }
  const app = createMcpHttpApp(server, { token: settings.httpToken, allowedOrigins: settings.allowedOrigins });
  const http = Bun.serve({ hostname: settings.httpHost, port: settings.httpPort, fetch: app.fetch });
  note(`listening on ${settings.httpHost}:${http.port}/mcp`);
  const stop = () => { http.stop(true); process.exit(0); };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
} else {
  await runStdio(server, stdinLines(), (line) => process.stdout.write(`${line}\n`), agent?.account.address ?? "stdio");
}
