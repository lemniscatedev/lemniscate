// Switches the invite gate and verifies the result against the running API, reverting on any failure.
// The launch autopilot calls this: `on` at launch, `off` at the time Kal picks (default launch + 8 h).
//   DATABASE_URL=... bun run scripts/invites/verify.ts on|off --api https://api.example [--codes <codes-file>] [--sample 20]
// Exit 0 = the new state is live and verified. Exit 1 = a check failed and the previous state was restored.
// Checks: status endpoint agrees; a never-approved wallet is refused (on) or let through (off) on buy and shield;
// sells are never refused; sampled already-approved wallets still pass and still read as approved; a throwaway code is
// redeemed end to end with a real signature (then removed); with --codes, no imported code is missing or revoked (on).
import { readFileSync } from "node:fs";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { buildSignedMessage, canonicalPayloadHash } from "../../src/api/signed-action";
import { generateInviteCode, hashInviteCode, normalizeInviteCode } from "../../src/lib/invite-code";
import { connect, flag, positional } from "./db";

const [mode] = positional();
const api = (flag("api") ?? "").replace(/\/+$/, "");
if ((mode !== "on" && mode !== "off") || !api) {
  console.error("usage: verify.ts on|off --api <url> [--codes <file>] [--sample 20]");
  process.exit(2);
}
const wantOn = mode === "on";
const sample = Number(flag("sample") ?? "20");
const codesFile = flag("codes");
const BOGUS_SERIES = `0x${"00".repeat(31)}01`;
const failures: string[] = [];
const fail = (message: string) => { failures.push(message); console.error(`FAIL ${message}`); };
const pass = (message: string) => console.log(`ok   ${message}`);

async function post(path: string, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const response = await fetch(api + path, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000),
  });
  return { status: response.status, json: await response.json().catch(() => ({})) as Record<string, unknown> };
}
async function status(address?: string): Promise<{ required: boolean; approved: boolean | null }> {
  const response = await fetch(`${api}/v1/invites/status${address ? `?address=${address}` : ""}`, { signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`status endpoint returned ${response.status}`);
  return await response.json() as { required: boolean; approved: boolean | null };
}
const buyBody = (account: string) => ({ series: BOGUS_SERIES, units: "1", account });
const shieldBody = (account: string) => ({ name: "NVDA", tokenUnits: "1", account });

/** Expect the gate to refuse (403 INVITE_REQUIRED) or to stay out of the way (anything but 403). */
async function expectGate(label: string, path: string, body: unknown, refused: boolean) {
  const { status: code, json } = await post(path, body);
  const got = code === 403 && json.error === "INVITE_REQUIRED";
  if (got === refused) pass(`${label}: ${refused ? "refused" : "not gated"} (HTTP ${code})`);
  else fail(`${label}: expected ${refused ? "INVITE_REQUIRED" : "no gate"}, got HTTP ${code}`);
}

const sql = connect();
const [previousRow] = await sql`select value from app_settings where key = 'invites_required'`;
const previous = previousRow ? String(previousRow.value) : null;
let probeAddress: string | null = null;
let probeHash: string | null = null;
try {
  await sql`insert into app_settings (key, value) values ('invites_required', ${wantOn ? "1" : "0"})
    on conflict (key) do update set value = excluded.value, updated_at = now()`;
  console.log(`switched invites ${mode}; verifying against ${api}`);

  const live = await status();
  if (live.required === wantOn) pass(`status endpoint reports required=${live.required}`);
  else fail(`status endpoint reports required=${live.required}, expected ${wantOn}`);

  const stranger = privateKeyToAccount(generatePrivateKey()).address.toLowerCase();
  await expectGate("buy by a never-approved wallet", "/v1/intent/buy", buyBody(stranger), wantOn);
  await expectGate("shield by a never-approved wallet", "/v1/intent/shield", shieldBody(stranger), wantOn);
  await expectGate("sell by a never-approved wallet", "/v1/intent/sell", buyBody(stranger), false);

  const approved = await sql`select address from invite_redemptions order by redeemed_at desc limit ${sample}`;
  let okApproved = 0;
  for (const row of approved) {
    const address = String(row.address);
    const [state, buy] = await Promise.all([status(address), post("/v1/intent/buy", buyBody(address))]);
    if (state.approved === true && !(buy.status === 403 && buy.json.error === "INVITE_REQUIRED")) okApproved++;
    else fail(`an existing approved wallet (${address.slice(0, 6)}...${address.slice(-4)}) is no longer approved or is refused`);
  }
  pass(`${okApproved}/${approved.length} sampled approved wallets still pass`);

  // End to end: a throwaway code, a throwaway key, a real signed redeem, then cleanup.
  const probeCode = generateInviteCode();
  probeHash = hashInviteCode(probeCode);
  await sql`insert into invite_codes (code_hash, label, max_uses) values (${probeHash}, 'verify-probe', 1)`;
  const account = privateKeyToAccount(generatePrivateKey());
  probeAddress = account.address.toLowerCase();
  const nonce = Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, "0")).join("");
  const issued = new Date(Date.now() - 1_000).toISOString();
  const expires = new Date(Date.now() + 5 * 60_000).toISOString();
  const payloadHash = canonicalPayloadHash({ code: normalizeInviteCode(probeCode) });
  const signature = await account.signMessage({
    message: buildSignedMessage({ action: "invites.redeem", address: probeAddress, payloadHash, nonce, issued, expires }),
  });
  const redeem = await post("/v1/invites/redeem", { address: probeAddress, nonce, issued, expires, signature, code: probeCode });
  if (redeem.status === 200 && redeem.json.approved === true) pass("a fresh code redeems with a real signature");
  else fail(`a fresh code did not redeem (HTTP ${redeem.status})`);
  if ((await status(probeAddress)).approved === true) pass("the redeemed wallet reads as approved");
  else fail("the redeemed wallet does not read as approved");
  await expectGate("buy by the redeemed wallet", "/v1/intent/buy", buyBody(probeAddress), false);

  if (wantOn && codesFile) {
    const hashes = readFileSync(codesFile, "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#")).map(hashInviteCode);
    const rows = await sql`select code_hash, revoked from invite_codes where code_hash in ${sql(hashes)}`;
    const found = new Map(rows.map((r) => [String(r.code_hash), r.revoked === true]));
    const missing = hashes.filter((h) => !found.has(h)).length;
    const revoked = hashes.filter((h) => found.get(h) === true).length;
    if (missing === 0 && revoked === 0) pass(`all ${hashes.length} codes in the file are imported and active`);
    else fail(`${missing} code(s) missing and ${revoked} revoked of ${hashes.length}`);
  }
} catch (error) {
  fail(`verification error: ${error instanceof Error ? error.message : String(error)}`);
} finally {
  if (probeAddress) await sql`delete from invite_redemptions where address = ${probeAddress}`.catch(() => undefined);
  if (probeHash) await sql`delete from invite_codes where code_hash = ${probeHash}`.catch(() => undefined);
  if (failures.length > 0) {
    if (previous === null) await sql`delete from app_settings where key = 'invites_required'`.catch(() => undefined);
    else await sql`update app_settings set value = ${previous}, updated_at = now() where key = 'invites_required'`.catch(() => undefined);
    console.error(`REVERTED to the previous state (${previous === null ? "unset" : previous === "1" ? "on" : "off"}); ${failures.length} check(s) failed.`);
  } else {
    console.log(`VERIFIED: invites are ${mode}.`);
  }
  await sql.end({ timeout: 5 });
}
process.exit(failures.length > 0 ? 1 : 0);
