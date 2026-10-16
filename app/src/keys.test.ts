// Keystore signers (todo 24b). Anvil's well-known dev key is encrypted here at test time into a temp dir; no key file is committed.
import { afterAll, describe, expect, test } from "bun:test";
import { createCipheriv, pbkdf2Sync, randomBytes, scryptSync } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bytesToHex, concat, keccak256, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { loadAaConfig } from "./aa/config";
import { assertKeysSeparated, ConfigurationError, loadKeeperSigningKey, stripKeeperSecrets } from "./config";
import { assertHedgerKeyDistinct, loadHedgerSigningKey, stripHedgerSecrets } from "./hedger/settings";
import { decryptKeystore, KEY_ROLES, KeyConfigError, knownSecrets, preflightKeys, requireKey, resolveKey } from "./keys";
import { safeErrorSummary } from "./log";
import { loadMcpSettings } from "./mcp/config";
import { loadX402Settings } from "./x402/config";

const ANVIL_KEY: Hex = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"; // test-key
const ANVIL_ADDRESS = privateKeyToAccount(ANVIL_KEY).address;
const OTHER_KEY: Hex = `0x${"22".repeat(32)}`; // test-key
const THIRD_KEY: Hex = `0x${"33".repeat(32)}`; // test-key
const PASSWORD = "correct horse battery staple"; // test-password
const dir = mkdtempSync(join(tmpdir(), "lmns-keys-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** Web3 Secret Storage v3, written the way cast does it (low scrypt cost here so the suite stays fast). */
function encrypt(key: Hex, password: string, kdf: "scrypt" | "pbkdf2" = "scrypt"): string {
  const salt = randomBytes(32), iv = randomBytes(16), dklen = 32;
  const pw = Buffer.from(password.normalize("NFKD"));
  const kdfparams = kdf === "scrypt" ? { dklen, n: 16, r: 8, p: 1, salt: salt.toString("hex") } : { dklen, c: 1000, prf: "hmac-sha256", salt: salt.toString("hex") };
  const dk = kdf === "scrypt" ? scryptSync(pw, salt, dklen, { N: 16, r: 8, p: 1 }) : pbkdf2Sync(pw, salt, 1000, dklen, "sha256");
  const c = createCipheriv("aes-128-ctr", dk.subarray(0, 16), iv);
  const ct = Buffer.concat([c.update(Buffer.from(key.slice(2), "hex")), c.final()]);
  const mac = keccak256(concat([bytesToHex(new Uint8Array(dk.subarray(16, 32))), bytesToHex(new Uint8Array(ct))])).slice(2);
  return JSON.stringify({ version: 3, crypto: { cipher: "aes-128-ctr", cipherparams: { iv: iv.toString("hex") }, ciphertext: ct.toString("hex"), kdf, kdfparams, mac } });
}

let n = 0;
/** Writes a keystore + password file pair (mode 0440) and returns the env variables that point at them. */
function pair(spec: { keystore: string; passwordFile: string }, key: Hex, opts: { password?: string; kdf?: "scrypt" | "pbkdf2"; mode?: number } = {}) {
  const id = n++;
  const ks = join(dir, `ks-${id}.json`), pw = join(dir, `ks-${id}.password`);
  writeFileSync(ks, encrypt(key, opts.password ?? PASSWORD, opts.kdf));
  writeFileSync(pw, `${PASSWORD}\n`);
  chmodSync(ks, opts.mode ?? 0o440);
  chmodSync(pw, opts.mode ?? 0o440);
  return { [spec.keystore]: ks, [spec.passwordFile]: pw };
}

describe("decryptKeystore", () => {
  test("scrypt and pbkdf2 keystores unlock to the key that was encrypted", () => {
    expect(decryptKeystore(encrypt(ANVIL_KEY, PASSWORD), PASSWORD)).toBe(ANVIL_KEY);
    expect(decryptKeystore(encrypt(OTHER_KEY, PASSWORD, "pbkdf2"), PASSWORD)).toBe(OTHER_KEY);
  });
  test("a wrong password and a damaged file fail without echoing either", () => {
    expect(() => decryptKeystore(encrypt(ANVIL_KEY, PASSWORD), "wrong")).toThrow("wrong password");
    expect(() => decryptKeystore("{not json", PASSWORD)).toThrow(KeyConfigError);
    expect(() => decryptKeystore("{}", PASSWORD)).toThrow("no crypto section");
    try { decryptKeystore(encrypt(ANVIL_KEY, PASSWORD), "wrong-password-xyz"); } catch (e) { expect(String(e)).not.toContain("wrong-password-xyz"); }
  });
  test("reads what cast writes (skipped when cast is absent)", () => {
    const cast = Bun.which("cast");
    if (!cast) return;
    const out = mkdtempSync(join(dir, "cast-"));
    const r = Bun.spawnSync([cast, "wallet", "import", "t", "--private-key", ANVIL_KEY.slice(2), "--unsafe-password", PASSWORD, "--keystore-dir", out], { stdout: "pipe", stderr: "pipe" });
    expect(r.exitCode).toBe(0);
    expect(decryptKeystore(require("node:fs").readFileSync(join(out, "t"), "utf8"), PASSWORD)).toBe(ANVIL_KEY);
  });
});

describe("resolveKey", () => {
  test("raw (development), keystore, and unset", () => {
    expect(resolveKey(KEY_ROLES.keeper, { KEEPER_PRIVATE_KEY: ANVIL_KEY })).toBe(ANVIL_KEY);
    expect(resolveKey(KEY_ROLES.keeper, pair({ keystore: "KEEPER_KEYSTORE", passwordFile: "KEEPER_KEYSTORE_PASSWORD_FILE" }, ANVIL_KEY))).toBe(ANVIL_KEY);
    expect(resolveKey(KEY_ROLES.keeper, {})).toBeUndefined();
    expect(() => requireKey(KEY_ROLES.keeper, {})).toThrow("no keeper key");
  });
  test("every role reads its own variables", () => {
    for (const [name, spec] of Object.entries(KEY_ROLES)) {
      expect(resolveKey(spec, pair(spec, THIRD_KEY, { kdf: "pbkdf2" }))).toBe(THIRD_KEY);
      expect(resolveKey(spec, { [spec.raw]: THIRD_KEY })).toBe(THIRD_KEY);
      expect(name.length).toBeGreaterThan(0);
    }
  });
  test("raw and keystore together, a keystore without its password file, and a lone password file are refused", () => {
    const p = pair(KEY_ROLES.keeper, ANVIL_KEY);
    expect(() => resolveKey(KEY_ROLES.keeper, { ...p, KEEPER_PRIVATE_KEY: ANVIL_KEY })).toThrow("not both");
    expect(() => resolveKey(KEY_ROLES.keeper, { KEEPER_KEYSTORE: p.KEEPER_KEYSTORE })).toThrow("needs KEEPER_KEYSTORE_PASSWORD_FILE");
    expect(() => resolveKey(KEY_ROLES.keeper, { KEEPER_KEYSTORE_PASSWORD_FILE: p.KEEPER_KEYSTORE_PASSWORD_FILE })).toThrow("without KEEPER_KEYSTORE");
    expect(() => resolveKey(KEY_ROLES.keeper, { KEEPER_PRIVATE_KEY: "0x1234" })).toThrow("32-byte");
  });
  test("production accepts only the keystore form", () => {
    const p = pair(KEY_ROLES.keeper, ANVIL_KEY);
    expect(resolveKey(KEY_ROLES.keeper, { ...p, NODE_ENV: "production" })).toBe(ANVIL_KEY);
    expect(() => resolveKey(KEY_ROLES.keeper, { NODE_ENV: "production", KEEPER_PRIVATE_KEY: ANVIL_KEY })).toThrow("only accepts a keystore");
    try { resolveKey(KEY_ROLES.keeper, { NODE_ENV: "production", KEEPER_PRIVATE_KEY: ANVIL_KEY }); } catch (e) { expect(String(e)).not.toContain(ANVIL_KEY.slice(2)); }
  });
  test("production refuses key files other users can read; development does not check", () => {
    const open = pair(KEY_ROLES.keeper, ANVIL_KEY, { mode: 0o644 });
    expect(() => resolveKey(KEY_ROLES.keeper, { ...open, NODE_ENV: "production" })).toThrow("readable by other users");
    expect(resolveKey(KEY_ROLES.keeper, open)).toBe(ANVIL_KEY);
  });
  test("a missing file, a wrong password file and a failed unlock name the variable, never the secret", () => {
    const p = pair(KEY_ROLES.keeper, ANVIL_KEY);
    expect(() => resolveKey(KEY_ROLES.keeper, { ...p, KEEPER_KEYSTORE: join(dir, "missing.json") })).toThrow("cannot read the keystore");
    const bad = join(dir, "bad.password");
    writeFileSync(bad, "not the password\n");
    try { resolveKey(KEY_ROLES.keeper, { ...p, KEEPER_KEYSTORE_PASSWORD_FILE: bad }); throw new Error("should fail"); } catch (e) {
      expect(String(e)).toContain("wrong password");
      expect(String(e)).not.toContain("not the password");
    }
  });
});

describe("services read keystores", () => {
  test("keeper and hedger", () => {
    const keeper = pair(KEY_ROLES.keeper, ANVIL_KEY);
    const hedger = pair(KEY_ROLES.hedger, OTHER_KEY);
    expect(loadKeeperSigningKey({ ...keeper, ...hedger })).toBe(ANVIL_KEY);
    expect(loadHedgerSigningKey({ ...keeper, ...hedger })).toBe(OTHER_KEY);
    expect(() => assertHedgerKeyDistinct({ ...keeper, ...hedger })).not.toThrow();
  });
  test("key separation compares derived addresses across forms", () => {
    const keeperKs = pair(KEY_ROLES.keeper, ANVIL_KEY);
    const hedgerKs = pair(KEY_ROLES.hedger, ANVIL_KEY);
    const volKs = pair(KEY_ROLES.volSigner, THIRD_KEY);
    // keystore + keystore, keystore + raw, raw + keystore: all the same address
    expect(() => assertKeysSeparated({ ...keeperKs, ...hedgerKs })).toThrow("keeper and hedger keys must be different");
    expect(() => assertKeysSeparated({ ...keeperKs, HEDGER_PRIVATE_KEY: ANVIL_KEY })).toThrow(ConfigurationError);
    expect(() => assertKeysSeparated({ KEEPER_PRIVATE_KEY: ANVIL_KEY.toUpperCase().replace("0X", "0x"), ...hedgerKs })).toThrow("must be different");
    expect(() => assertHedgerKeyDistinct({ ...keeperKs, ...hedgerKs })).toThrow("must differ");
    expect(() => loadKeeperSigningKey({ ...keeperKs, ...volKs, VOL_SIGNER_KEY: undefined })).not.toThrow();
    expect(() => assertKeysSeparated({ ...keeperKs, ...pair(KEY_ROLES.hedger, OTHER_KEY), ...volKs })).not.toThrow();
    // the vol sender may equal the vol signer, not the keeper
    expect(() => assertKeysSeparated({ ...volKs, ...pair(KEY_ROLES.volSender, THIRD_KEY) })).not.toThrow();
    expect(() => assertKeysSeparated({ ...keeperKs, ...pair(KEY_ROLES.volSender, ANVIL_KEY) })).toThrow("keeper and vol sender");
  });
  test("production start-up refuses a raw keeper key as a ConfigurationError", () => {
    expect(() => loadKeeperSigningKey({ NODE_ENV: "production", KEEPER_PRIVATE_KEY: ANVIL_KEY })).toThrow(ConfigurationError);
  });
  test("paymaster signer, x402 settler and agent", () => {
    const pm = pair(KEY_ROLES.paymasterSigner, ANVIL_KEY);
    const address = "0x00000000000000000000000000000000000000aa";
    expect(loadAaConfig({ PAYMASTER_ADDRESS: address, ...pm }).paymaster?.signerKey).toBe(ANVIL_KEY);
    expect(() => loadAaConfig({ PAYMASTER_ADDRESS: address })).toThrow("must be set together");
    expect(() => loadAaConfig({ ...pm })).toThrow("must be set together");
    expect(() => loadAaConfig({ PAYMASTER_ADDRESS: address, PAYMASTER_SIGNER_KEY: ANVIL_KEY, NODE_ENV: "production" })).toThrow("only accepts a keystore");
    expect(loadAaConfig({}).paymaster).toBeNull();

    const x402 = pair(KEY_ROLES.x402Settler, OTHER_KEY);
    const payTo = "0x00000000000000000000000000000000000000bb";
    expect(loadX402Settings({ X402_ENABLED: "1", X402_PAY_TO: payTo, ...x402 }).settlerKey).toBe(OTHER_KEY);
    expect(() => loadX402Settings({ X402_ENABLED: "1", X402_PAY_TO: payTo })).toThrow("settler key");
    expect(loadX402Settings({}).settlerKey).toBeUndefined();

    const agent = pair(KEY_ROLES.agent, THIRD_KEY);
    expect(loadMcpSettings({ ...agent }).agentKey).toBe(THIRD_KEY);
    expect(loadMcpSettings({}).agentKey).toBeUndefined();
    expect(() => loadMcpSettings({ AGENT_KEY: "0xnothex" })).toThrow("AGENT_KEY");
  });
  test("processes that must not sign drop the keystore locations too", () => {
    const env: Record<string, string | undefined> = { ...pair(KEY_ROLES.keeper, ANVIL_KEY), ...pair(KEY_ROLES.hedger, OTHER_KEY), KEEPER_PRIVATE_KEY: ANVIL_KEY, HEDGER_PRIVATE_KEY: OTHER_KEY };
    stripKeeperSecrets(env);
    expect(Object.keys(env).filter((k) => k.startsWith("KEEPER"))).toEqual([]);
    expect(Object.keys(env).filter((k) => k.startsWith("HEDGER")).length).toBe(3);
    stripHedgerSecrets(env);
    expect(Object.keys(env)).toEqual([]);
  });
});

describe("preflightKeys", () => {
  test("lists the address of each configured role and never a key", () => {
    const env = { ...pair(KEY_ROLES.keeper, ANVIL_KEY), ...pair(KEY_ROLES.hedger, OTHER_KEY), ...pair(KEY_ROLES.volSigner, THIRD_KEY), NODE_ENV: "production" };
    const out = preflightKeys(env);
    expect(out.map((r) => r.role)).toEqual(["keeper", "hedger", "volSigner"]);
    expect(out[0]!.address).toBe(ANVIL_ADDRESS);
    expect(JSON.stringify(out)).not.toContain(ANVIL_KEY.slice(2));
  });
  test("refuses duplicates and raw keys in production", () => {
    expect(() => preflightKeys({ ...pair(KEY_ROLES.keeper, ANVIL_KEY), ...pair(KEY_ROLES.paymasterSigner, ANVIL_KEY) })).toThrow("keeper and paymaster signer");
    expect(() => preflightKeys({ NODE_ENV: "production", HEDGER_PRIVATE_KEY: OTHER_KEY })).toThrow("only accepts a keystore");
  });
});

describe("keys never reach the logs", () => {
  test("a decrypted key is redacted from error messages", () => {
    const key = resolveKey(KEY_ROLES.hedger, pair(KEY_ROLES.hedger, THIRD_KEY))!;
    expect(knownSecrets()).toContain(key);
    const out = safeErrorSummary(new Error(`rpc failed for ${key} and ${key.slice(2)}`));
    expect(out.message).not.toContain(key.slice(2));
    expect(out.message).toContain("[REDACTED]");
  });
});
