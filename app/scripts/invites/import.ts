// Loads codes from a file made by generate.ts into invite_codes (hashed; the database never holds a usable code).
//   DATABASE_URL=... bun run scripts/invites/import.ts <codes-file> [--max-uses 1] [--label launch]
// Safe to re-run: codes already present are left alone. Prints counts only, never a code.
import { readFileSync } from "node:fs";
import { hashInviteCode, isWellFormedInviteCode } from "../../src/lib/invite-code";
import { connect, flag, positional } from "./db";

const [file] = positional();
if (!file) {
  console.error("usage: bun run scripts/invites/import.ts <codes-file> [--max-uses 1] [--label launch]");
  process.exit(2);
}
const maxUses = Number(flag("max-uses") ?? "1");
if (!Number.isInteger(maxUses) || maxUses < 1) {
  console.error("--max-uses must be a whole number of at least 1.");
  process.exit(2);
}
const label = flag("label") ?? null;
const lines = readFileSync(file, "utf8").split("\n").map((line) => line.trim()).filter((line) => line && !line.startsWith("#"));
const bad = lines.filter((line) => !isWellFormedInviteCode(line));
if (bad.length > 0) {
  console.error(`${bad.length} line(s) are not well-formed invite codes. Nothing imported.`);
  process.exit(1);
}
const hashes = [...new Set(lines.map(hashInviteCode))];
const sql = connect();
try {
  let inserted = 0;
  await sql.begin(async (tx) => {
    for (const hash of hashes) {
      const rows = await tx`
        insert into invite_codes (code_hash, label, max_uses) values (${hash}, ${label}, ${maxUses})
        on conflict (code_hash) do nothing returning code_hash`;
      inserted += rows.length;
    }
  });
  console.log(`Imported ${inserted} new code(s); ${hashes.length - inserted} already present.`);
} finally {
  await sql.end({ timeout: 5 });
}
