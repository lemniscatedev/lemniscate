import { describe, expect, test } from "bun:test";
import { lmnsText, meetsTier, perksFor, tierFor, unlockText } from "./tiers";
import { issueHolderSession, verifyHolderSession, bearerToken } from "./session";

const t = { holderLmns: 100_000, whaleLmns: 1_000_000, decimals: 18 };
const lmns = (n: bigint) => n * 10n ** 18n;

describe("holder tiers", () => {
  test("boundaries: exactly 100,000 and 1,000,000 LMNS count; one unit less does not", () => {
    expect(tierFor(0n, t)).toBe("none");
    expect(tierFor(lmns(100_000n) - 1n, t)).toBe("none");
    expect(tierFor(lmns(100_000n), t)).toBe("holder");
    expect(tierFor(lmns(1_000_000n) - 1n, t)).toBe("holder");
    expect(tierFor(lmns(1_000_000n), t)).toBe("whale");
    expect(tierFor(lmns(1_000_000_000n), t)).toBe("whale");
  });

  test("a whale has every holder perk; nobody else has whale perks", () => {
    expect(meetsTier("whale", "holder")).toBe(true);
    expect(meetsTier("holder", "whale")).toBe(false);
    expect(meetsTier("none", "holder")).toBe(false);
    expect(perksFor("none").every((p) => !p.unlocked)).toBe(true);
    expect(perksFor("holder").filter((p) => p.unlocked).every((p) => p.level === "holder")).toBe(true);
    expect(perksFor("whale").every((p) => p.unlocked)).toBe(true);
  });

  test("locked text says how much to hold, with no price words", () => {
    expect(unlockText("holder", t)).toBe("Hold 100,000 $LMNS to unlock");
    expect(unlockText("whale", t)).toBe("Hold 1,000,000 $LMNS to unlock");
    expect(unlockText("whale", t)).not.toMatch(/apy|yield|return|invest/i);
  });

  test("balance text", () => {
    expect(lmnsText(lmns(123_456n) + 5n * 10n ** 17n, 18)).toBe("123456.5");
    expect(lmnsText(0n, 18)).toBe("0");
  });
});

describe("holder sessions", () => {
  const secret = "s".repeat(64);
  const address = `0x${"ab".repeat(20)}`;

  test("a token names its address until it expires", () => {
    const token = issueHolderSession(secret, address, 2_000);
    expect(verifyHolderSession(secret, token, 1_999)).toBe(address);
    expect(verifyHolderSession(secret, token, 2_000)).toBeNull();
  });

  test("a changed address, expiry or secret is refused", () => {
    const token = issueHolderSession(secret, address, 2_000);
    const [, exp, mac] = token.split(".");
    expect(verifyHolderSession(secret, `0x${"cd".repeat(20)}.${exp}.${mac}`, 1)).toBeNull();
    expect(verifyHolderSession(secret, `${address}.9999999.${mac}`, 1)).toBeNull();
    expect(verifyHolderSession("x".repeat(64), token, 1)).toBeNull();
    expect(verifyHolderSession(secret, "garbage", 1)).toBeNull();
  });

  test("bearer header parsing", () => {
    expect(bearerToken("Bearer abc.def")).toBe("abc.def");
    expect(bearerToken(undefined)).toBeNull();
    expect(bearerToken("Basic abc")).toBeNull();
  });
});
