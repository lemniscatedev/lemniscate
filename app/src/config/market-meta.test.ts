import { expect, test } from "bun:test";
import { marketMeta, marketMetadataSchema } from "./market-meta";

test("validates labels and restricts color to an RGB hex value", () => {
  expect(marketMetadataSchema.parse({ AMD: { name: "AMD", category: "Technology", color: "#ff6b9a" } }).AMD?.name).toBe("AMD");
  for (const invalid of [{ AMD: { name: "", category: "Tech", color: "#ffffff" } }, { amd: { name: "AMD", category: "Tech", color: "#ffffff" } }, { AMD: { name: "AMD", category: "Tech", color: "url(foo)" } }, { AMD: { name: "AMD", category: "Tech", color: "#ffffff", extra: true } }]) {
    expect(marketMetadataSchema.safeParse(invalid).success).toBe(false);
  }
});
test("preserves known metadata and leaves unknown symbols absent", () => {
  expect(marketMeta("NVDA")).toEqual({ name: "NVIDIA", category: "Technology", color: "#42dec9" });
  expect(marketMeta("qqq")?.name).toBe("Nasdaq-100");
  expect(marketMeta("UNKNOWN")).toBeUndefined();
  expect(marketMeta("constructor")).toBeUndefined();
});
