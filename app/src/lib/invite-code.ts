import { createHash, randomInt } from "node:crypto";

// 31 symbols with no 0/O/1/I/L, so a code read aloud or typed from a screenshot is hard to get wrong (about 59 bits per code).
export const INVITE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const GROUPS = 3;
const GROUP_LENGTH = 4;

/** Uppercase and strip spaces, dashes and anything else a person might paste around a code. */
export function normalizeInviteCode(input: string): string {
  return input.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export function isWellFormedInviteCode(input: string): boolean {
  const code = normalizeInviteCode(input);
  return code.length === GROUPS * GROUP_LENGTH && [...code].every((char) => INVITE_ALPHABET.includes(char));
}

/** The stored form: the database never holds a usable code. */
export function hashInviteCode(input: string): string {
  return createHash("sha256").update(`lemniscate-invite:${normalizeInviteCode(input)}`, "utf8").digest("hex");
}

/** XXXX-XXXX-XXXX from the OS random source (about 59 bits). */
export function generateInviteCode(): string {
  const groups: string[] = [];
  for (let g = 0; g < GROUPS; g++) {
    let group = "";
    for (let i = 0; i < GROUP_LENGTH; i++) group += INVITE_ALPHABET[randomInt(INVITE_ALPHABET.length)];
    groups.push(group);
  }
  return groups.join("-");
}
