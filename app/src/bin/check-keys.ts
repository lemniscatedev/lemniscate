// Launch preflight for the signing keys. Usage: bun src/bin/check-keys.ts <keys dir>   (deploy.sh runs it as the service user)
// For each role with a <role>.json and <role>.password in the folder it unlocks the keystore (so a wrong password or a
// damaged file is found now, not when the service starts), checks the files are not readable by other users, and checks that no
// two roles control the same address. It prints each role and its public ADDRESS, never a key, so the addresses can be
// compared with the wallet pack. Exit 0 = good, 1 = a problem (named on stderr).
import { join } from "node:path";
import { existsSync } from "node:fs";
import { KEY_ROLES, KeyConfigError, preflightKeys, type KeyRoleName } from "../keys";

const FILES: Record<string, KeyRoleName> = {
  keeper: "keeper",
  hedger: "hedger",
  "vol-signer": "volSigner",
  "paymaster-signer": "paymasterSigner",
  "x402-settler": "x402Settler",
};

const dir = process.argv[2];
if (!dir) {
  console.error("usage: bun src/bin/check-keys.ts <keys dir>");
  process.exit(64);
}

// Production rules always apply here, whatever the calling shell has set.
const source: Record<string, string> = { NODE_ENV: "production" };
for (const [file, role] of Object.entries(FILES)) {
  const ks = join(dir, `${file}.json`);
  if (!existsSync(ks)) continue;
  source[KEY_ROLES[role].keystore] = ks;
  source[KEY_ROLES[role].passwordFile] = join(dir, `${file}.password`);
}

try {
  const found = preflightKeys(source);
  for (const r of found) console.log(`${r.label}: ${r.address}`);
  console.log(`keys ok: ${found.length} keystore(s) unlock, all addresses distinct`);
} catch (error) {
  console.error(`keys: ${error instanceof KeyConfigError ? error.message : "unexpected error while checking the keystores"}`);
  process.exit(1);
}
