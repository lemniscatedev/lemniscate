// Signing keys for every Lemniscate service. Each signer is configured in one of two forms:
//   <RAW>                          a hex private key (local development and CI only)
//   <PREFIX>_KEYSTORE              path of an encrypted Web3 Secret Storage v3 file (what `cast wallet import` writes)
//   <PREFIX>_KEYSTORE_PASSWORD_FILE  path of a file holding its password
// With NODE_ENV=production only the keystore form is accepted. The key is decrypted in this process (scrypt or pbkdf2 +
// aes-128-ctr), kept in memory and never written anywhere. Errors from this module name variables and file paths, never a
// key or a password. The operator supplies the keystore files; nothing here creates or reads a key from anywhere else.
import { createDecipheriv, pbkdf2Sync, scryptSync } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { bytesToHex, concat, keccak256, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

export class KeyConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KeyConfigError";
  }
}

export interface KeyRole {
  /** Human name used in errors. */
  readonly label: string;
  /** Variable holding a raw key (development only). */
  readonly raw: string;
  /** Variable holding the keystore file path. */
  readonly keystore: string;
  /** Variable holding the password file path. */
  readonly passwordFile: string;
}

const role = (label: string, raw: string, prefix: string): KeyRole => ({
  label, raw, keystore: `${prefix}_KEYSTORE`, passwordFile: `${prefix}_KEYSTORE_PASSWORD_FILE`,
});

export const KEY_ROLES = {
  keeper: role("keeper", "KEEPER_PRIVATE_KEY", "KEEPER"),
  hedger: role("hedger", "HEDGER_PRIVATE_KEY", "HEDGER"),
  volSigner: role("vol signer", "VOL_SIGNER_KEY", "VOL_SIGNER"),
  volSender: role("vol sender", "VOL_SENDER_KEY", "VOL_SENDER"),
  paymasterSigner: role("paymaster signer", "PAYMASTER_SIGNER_KEY", "PAYMASTER_SIGNER"),
  x402Settler: role("x402 settler", "X402_SETTLER_KEY", "X402_SETTLER"),
  agent: role("agent", "AGENT_KEY", "AGENT"),
} as const satisfies Record<string, KeyRole>;

export type KeyRoleName = keyof typeof KEY_ROLES;

/** Every variable that can carry a key or point to one, for stripping from processes that must not sign. */
export const keyVariables = (r: KeyRole): string[] => [r.raw, r.keystore, r.passwordFile];

type Source = Record<string, string | undefined>;

// ---------------------------------------------------------------------------------------------------------------- redaction
const resolved = new Set<string>();

/** Values (key hex with and without 0x) this process has decrypted or been given. The logger scrubs them from messages. */
export function knownSecrets(): string[] {
  return [...resolved];
}

function remember(key: string) {
  resolved.add(key);
  resolved.add(key.replace(/^0x/i, ""));
}

// ---------------------------------------------------------------------------------------------------------------- keystore
type KeystoreCrypto = {
  cipher: string;
  cipherparams: { iv: string };
  ciphertext: string;
  kdf: "scrypt" | "pbkdf2";
  kdfparams: { dklen: number; salt: string; n?: number; r?: number; p?: number; c?: number; prf?: string };
  mac: string;
};
type Keystore = { crypto?: KeystoreCrypto; Crypto?: KeystoreCrypto };

const strip = (h: string) => h.replace(/^0x/i, "");

/** Web3 Secret Storage v3. Returns the raw 32-byte key. Throws KeyConfigError (never echoing the password or key). */
export function decryptKeystore(json: string, password: string): Hex {
  let ks: Keystore;
  try {
    ks = JSON.parse(json) as Keystore;
  } catch {
    throw new KeyConfigError("keystore: not valid JSON");
  }
  const c = ks.crypto ?? ks.Crypto;
  if (!c) throw new KeyConfigError("keystore: no crypto section");
  if (c.cipher !== "aes-128-ctr") throw new KeyConfigError(`keystore: unsupported cipher ${c.cipher}`);
  const salt = Buffer.from(strip(c.kdfparams.salt), "hex");
  const pw = Buffer.from(password.normalize("NFKD"), "utf8");
  let dk: Buffer;
  try {
    if (c.kdf === "scrypt") {
      const { n, r, p, dklen } = c.kdfparams;
      if (!n || !r || !p) throw new KeyConfigError("keystore: incomplete scrypt parameters");
      dk = scryptSync(pw, salt, dklen, { N: n, r, p, maxmem: 256 * n * r + 1024 * 1024 });
    } else if (c.kdf === "pbkdf2") {
      if (c.kdfparams.prf !== "hmac-sha256") throw new KeyConfigError(`keystore: unsupported prf ${c.kdfparams.prf}`);
      if (!c.kdfparams.c) throw new KeyConfigError("keystore: incomplete pbkdf2 parameters");
      dk = pbkdf2Sync(pw, salt, c.kdfparams.c, c.kdfparams.dklen, "sha256");
    } else {
      throw new KeyConfigError(`keystore: unsupported kdf ${(c as { kdf: string }).kdf}`);
    }
  } catch (e) {
    if (e instanceof KeyConfigError) throw e;
    throw new KeyConfigError("keystore: key derivation failed (bad parameters)");
  }
  const ct = Buffer.from(strip(c.ciphertext), "hex");
  const mac = keccak256(concat([bytesToHex(new Uint8Array(dk.subarray(16, 32))), bytesToHex(new Uint8Array(ct))]));
  if (strip(mac).toLowerCase() !== strip(c.mac).toLowerCase()) throw new KeyConfigError("keystore: wrong password (MAC mismatch)");
  const d = createDecipheriv("aes-128-ctr", dk.subarray(0, 16), Buffer.from(strip(c.cipherparams.iv), "hex"));
  const key = Buffer.concat([d.update(ct), d.final()]);
  if (key.length !== 32) throw new KeyConfigError("keystore: decrypted key is not 32 bytes");
  return bytesToHex(new Uint8Array(key));
}

// ---------------------------------------------------------------------------------------------------------------- resolve
const RAW_KEY = /^(0x)?[0-9a-fA-F]{64}$/;

export const isProduction = (source: Source = process.env): boolean => source.NODE_ENV?.trim() === "production";

function readFile(path: string, what: string, variable: string, production: boolean): string {
  try {
    // In production a key file must not be readable by "other" (the server uses root:lemniscate 0440).
    if (production && (statSync(path).mode & 0o007) !== 0) {
      throw new KeyConfigError(`${variable}: ${path} is readable by other users; chmod 0440 (or 0400) and chown it to the service group`);
    }
    return readFileSync(path, "utf8");
  } catch (e) {
    if (e instanceof KeyConfigError) throw e;
    throw new KeyConfigError(`${variable}: cannot read the ${what} at ${path}`);
  }
}

/**
 * The key for one role from `source`, or undefined when the role is not configured at all.
 *  - raw and keystore together are refused;
 *  - NODE_ENV=production refuses the raw form;
 *  - a keystore needs its password file, and the password never comes from a plain environment variable.
 */
export function resolveKey(spec: KeyRole, source: Source = process.env): Hex | undefined {
  const raw = source[spec.raw]?.trim();
  const ks = source[spec.keystore]?.trim();
  const pwFile = source[spec.passwordFile]?.trim();
  const production = isProduction(source);
  if (raw && ks) throw new KeyConfigError(`set ${spec.raw} or ${spec.keystore}, not both`);
  if (raw) {
    if (production) {
      throw new KeyConfigError(`${spec.raw} is set but NODE_ENV=production only accepts a keystore: use ${spec.keystore} and ${spec.passwordFile}`);
    }
    if (!RAW_KEY.test(raw)) throw new KeyConfigError(`${spec.raw} must be a 0x-prefixed 32-byte hex key`);
    const key = (raw.startsWith("0x") ? raw : `0x${raw}`) as Hex;
    remember(key);
    return key;
  }
  if (!ks) {
    if (pwFile) throw new KeyConfigError(`${spec.passwordFile} is set without ${spec.keystore}`);
    return undefined;
  }
  if (!pwFile) throw new KeyConfigError(`${spec.keystore} needs ${spec.passwordFile}`);
  const password = readFile(pwFile, "password file", spec.passwordFile, production).replace(/\r?\n$/, "");
  const key = decryptKeystore(readFile(ks, "keystore", spec.keystore, production), password);
  remember(key);
  return key;
}

/** Like resolveKey, but a role that is not configured is an error. */
export function requireKey(spec: KeyRole, source: Source = process.env): Hex {
  const key = resolveKey(spec, source);
  if (!key) throw new KeyConfigError(`no ${spec.label} key: set ${spec.keystore} and ${spec.passwordFile}${isProduction(source) ? "" : ` (or ${spec.raw} for development)`}`);
  return key;
}

/** The address a role's key controls (public), or undefined when the role is not configured. */
export function resolveAddress(spec: KeyRole, source: Source = process.env): `0x${string}` | undefined {
  const key = resolveKey(spec, source);
  return key ? privateKeyToAccount(key).address : undefined;
}

/**
 * Launch preflight: resolves every role present in `source`, refuses raw keys in production, and returns the public
 * address of each. Key separation (no two of keeper, hedger, vol signer, paymaster signer, x402 settler share an address)
 * is checked here for roles configured in the same environment.
 */
export function preflightKeys(source: Source = process.env, roles: readonly KeyRoleName[] = Object.keys(KEY_ROLES) as KeyRoleName[]): { role: KeyRoleName; label: string; address: `0x${string}` }[] {
  const out: { role: KeyRoleName; label: string; address: `0x${string}` }[] = [];
  for (const name of roles) {
    const address = resolveAddress(KEY_ROLES[name], source);
    if (address) out.push({ role: name, label: KEY_ROLES[name].label, address });
  }
  for (let i = 0; i < out.length; i++) {
    for (let j = i + 1; j < out.length; j++) {
      const a = out[i]!, b = out[j]!;
      if (a.address !== b.address) continue;
      if (a.role === "volSigner" && b.role === "volSender") continue;
      throw new KeyConfigError(`the ${a.label} and ${b.label} keys must be different keys`);
    }
  }
  return out;
}
