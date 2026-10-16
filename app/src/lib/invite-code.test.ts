import { expect, test } from "bun:test";
import { generateInviteCode, hashInviteCode, INVITE_ALPHABET, isWellFormedInviteCode, normalizeInviteCode } from "./invite-code";

test("generated codes are well formed, unambiguous and unique", () => {
  const seen = new Set<string>();
  for (let i = 0; i < 500; i++) {
    const code = generateInviteCode();
    expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(isWellFormedInviteCode(code)).toBe(true);
    expect(/[01OIL]/.test(code)).toBe(false);
    seen.add(code);
  }
  expect(seen.size).toBe(500);
  expect(INVITE_ALPHABET.length).toBe(31);
});

test("normalizing ignores case, spaces and dashes, and the hash follows", () => {
  expect(normalizeInviteCode(" abcd-efgh 2345 ")).toBe("ABCDEFGH2345");
  expect(hashInviteCode("abcd-efgh-2345")).toBe(hashInviteCode("ABCDEFGH2345"));
  expect(hashInviteCode("ABCD-EFGH-2345")).not.toBe(hashInviteCode("ABCD-EFGH-2346"));
  expect(hashInviteCode("ABCD-EFGH-2345")).toMatch(/^[0-9a-f]{64}$/);
});

test("malformed codes are rejected", () => {
  for (const bad of ["", "ABCD", "ABCD-EFGH-IJKL", "ABCD-EFGH-2345-6789", "0000-0000-0000"]) expect(isWellFormedInviteCode(bad)).toBe(false);
});
