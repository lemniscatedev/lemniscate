import { expect, test } from "bun:test";
import { decodeKind, underlyingOf } from "./market-kind";

test("decodes curve kind and the always-open bit", () => {
  expect(decodeKind(0)).toEqual({ curve: "squared", exponent: 2, alwaysOpen: false });
  expect(decodeKind(0x80)).toEqual({ curve: "squared", exponent: 2, alwaysOpen: true });
  expect(decodeKind(1)).toEqual({ curve: "ratio", exponent: 1, alwaysOpen: false });
  expect(decodeKind(2)).toEqual({ curve: "cubed", exponent: 3, alwaysOpen: false });
  expect(decodeKind(3)).toEqual({ curve: "root", exponent: 0.5, alwaysOpen: false });
  expect(decodeKind(0x83)).toEqual({ curve: "root", exponent: 0.5, alwaysOpen: true });
  expect(decodeKind(4)).toEqual({ curve: "downside", exponent: -1, alwaysOpen: false });
  expect(decodeKind(0x89)).toEqual({ curve: "unknown", exponent: null, alwaysOpen: true });
});

test("rejects invalid byte values and derives underlying symbols", () => {
  for (const kind of [9, -1, 256, 1.5, Number.NaN, "x"]) {
    expect(decodeKind(kind)).toEqual({ curve: "unknown", exponent: null, alwaysOpen: false });
  }
  expect(underlyingOf("QQQ3", "cubed")).toBe("QQQ");
  expect(underlyingOf("SPYROOT", "root")).toBe("SPY");
  expect(underlyingOf("NVDAINV", "downside")).toBe("NVDA");
  expect(underlyingOf("ETH", "squared")).toBe("ETH");
});
