// Flips the invite gate live, no restart: writes the app_settings row `invites_required`.
//   DATABASE_URL=... bun run scripts/invites/switch.ts on|off|status
// For the launch autopilot use verify.ts, which flips AND verifies AND reverts on failure.
import { connect, positional } from "./db";

const [mode] = positional();
if (mode !== "on" && mode !== "off" && mode !== "status") {
  console.error("usage: switch.ts on|off|status");
  process.exit(2);
}
const sql = connect();
try {
  if (mode !== "status") {
    await sql`insert into app_settings (key, value) values ('invites_required', ${mode === "on" ? "1" : "0"})
      on conflict (key) do update set value = excluded.value, updated_at = now()`;
  }
  const [row] = await sql`select value from app_settings where key = 'invites_required'`;
  console.log(`invites_required: ${row ? (row.value === "1" ? "on" : "off") : "not set (the INVITES_REQUIRED env value applies)"}`);
} finally {
  await sql.end({ timeout: 5 });
}
