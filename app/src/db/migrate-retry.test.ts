import { describe, expect, test } from "bun:test";
import { EXIT_NOT_SWITCHED, isLockTimeout, migrateWithLockRetry } from "./migrate-retry";

const lockErr = Object.assign(new Error("canceling statement due to lock timeout"), { code: "55P03" });
const noSleep = async () => {};

describe("migrate lock retry", () => {
  test("recognises a lock timeout, also wrapped in a cause", () => {
    expect(isLockTimeout(lockErr)).toBe(true);
    expect(isLockTimeout(new Error("migration failed", { cause: lockErr }))).toBe(true);
    expect(isLockTimeout(new Error("syntax error at or near"))).toBe(false);
    expect(isLockTimeout(undefined)).toBe(false);
  });

  test("retries a lock timeout and succeeds", async () => {
    let n = 0;
    const r = await migrateWithLockRetry(async () => {
      n += 1;
      if (n < 3) throw lockErr;
    }, 3, 0, noSleep);
    expect(r).toEqual({ ok: true, attempts: 3, lockTimeout: false });
  });

  test("gives up after the tries with lockTimeout set (exit 75 in migrate.ts)", async () => {
    const r = await migrateWithLockRetry(async () => { throw lockErr; }, 3, 0, noSleep);
    expect(r.ok).toBe(false);
    expect(r.lockTimeout).toBe(true);
    expect(r.attempts).toBe(3);
    expect(EXIT_NOT_SWITCHED).toBe(75);
  });

  test("does not retry other errors", async () => {
    let n = 0;
    const r = await migrateWithLockRetry(async () => { n += 1; throw new Error("bad sql"); }, 3, 0, noSleep);
    expect(n).toBe(1);
    expect(r.ok).toBe(false);
    expect(r.lockTimeout).toBe(false);
  });
});
