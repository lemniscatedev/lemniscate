import { loadConfig, stripKeeperSecrets } from "../config";
import { createDbClient } from "../db/client";
import { asRows, dateValue, textValue } from "../api/types";
import { isLaunched } from "../config/launch";
import { createLogger, safeErrorSummary } from "../log";

const [rawSymbol, action, ...noteParts] = process.argv.slice(2);
const symbol = rawSymbol?.toUpperCase() ?? "";
if (!/^[A-Z][A-Z0-9]{0,15}$/.test(symbol) || !["on", "off", "status"].includes(action ?? "")) {
  console.error("Usage: bun run src/bin/launch-market.ts <SYMBOL> on|off|status [note…]");
  process.exitCode = 2;
} else {
  stripKeeperSecrets();
  const config = loadConfig();
  const logger = createLogger(config.LOG_LEVEL, "launch-market");
  const { sql } = createDbClient(config);
  const note = noteParts.join(" ").trim() || null;

  try {
    const marketRows = asRows<Record<string, unknown>>(await sql`
      select symbol from markets where upper(symbol) = ${symbol} limit 1
    `);
    const marketIndexed = marketRows.length > 0;
    if (!marketIndexed) logger.warn({ symbol, action }, "Market is not indexed yet");

    if (action === "on" || action === "off") {
      await sql`
        insert into market_launch (symbol, launched, note)
        values (${symbol}, ${action === "on"}, ${note})
        on conflict (symbol) do update set
          launched = excluded.launched,
          updated_at = now(),
          note = excluded.note
      `;
    }

    const launchRows = asRows<Record<string, unknown>>(await sql`
      select symbol, launched, updated_at, note
      from market_launch where upper(symbol) = ${symbol} limit 1
    `);
    const launch = launchRows[0];
    const launchedOverride = typeof launch?.launched === "boolean" ? launch.launched : undefined;
    console.log(JSON.stringify({
      symbol,
      marketIndexed,
      launch: launch ? {
        symbol: textValue(launch.symbol),
        launched: launch.launched === true,
        updatedAt: dateValue(launch.updated_at)?.toISOString() ?? null,
        note: launch.note === null || launch.note === undefined ? null : textValue(launch.note),
      } : null,
      isLaunched: isLaunched(symbol, launchedOverride),
    }, null, 2));
  } catch (error) {
    logger.error({ err: safeErrorSummary(error), symbol, action }, "Market launch status update failed");
    process.exitCode = 1;
  } finally {
    await sql.end({ timeout: 5 });
  }
}
