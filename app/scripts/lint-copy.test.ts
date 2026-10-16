import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkText, cmsStrings, htmlText, jsStrings, lintRepo, tsStrings } from "./lint-copy";

const BAD = [
  "Earn a 12% APY on the pool",
  "The vault yield this week",
  "Steady income for writers",
  "You can't lose with Shield",
  "Funds you cannot lose",
  "Try our free options today",
  "Trading with no fees",
  "Everlasting means no time decay",
  "Our partnership with Robinhood",
  "Powered by Chainlink",
];
const GOOD = [
  "Pool NAV rose by the funding received",
  "Max loss is the premium you paid",
  "A 3 bps fee is included in the quoted price",
  "The option's units shrink each day, paid in kind",
  "Chainlink price feeds are an input to pricing",
];

describe("copy lint rules", () => {
  for (const text of BAD) test(`flags: ${text}`, () => expect(checkText("x", text).length).toBeGreaterThan(0));
  for (const text of GOOD) test(`allows: ${text}`, () => expect(checkText("x", text)).toEqual([]));
});

describe("extractors", () => {
  test("htmlText drops scripts and styles, keeps meta content", () => {
    const text = htmlText('<meta name="description" content="hello meta"><style>.a{b:c}</style><script>var yield=1</script><p>body</p>');
    expect(text).toContain("hello meta");
    expect(text).toContain("body");
    expect(text).not.toContain("yield");
  });
  test("tsStrings reads literals and template parts, not comments or identifiers", () => {
    const strings = tsStrings("// yield in a comment\nconst yieldValue = 'summary one';\nconst t = `a ${yieldValue} b`;\n");
    expect(strings).toContain("summary one");
    expect(strings.join("|")).toContain("a ");
    expect(strings.join("|")).not.toContain("comment");
    expect(strings.join("|")).not.toContain("yieldValue");
  });
  test("jsStrings finds quoted strings", () => {
    expect(jsStrings(`var a="one two";var b='three four';`)).toEqual(['"one two"', "'three four'"]);
  });
  test("cmsStrings decodes string and rich text fields", () => {
    const u32 = (n: number) => Buffer.from([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
    const field = (key: string, type: number, value: string, version = false) =>
      Buffer.concat([u32(key.length), Buffer.from(key), Buffer.from([type]), ...(version ? [Buffer.from([1])] : []), u32(Buffer.byteLength(value)), Buffer.from(value)]);
    const buf = Buffer.concat([u32(1), Buffer.from([0, 2]), field("title", 0x0c, "Hello"), field("body", 0x0b, "Rich text", true)]);
    expect(cmsStrings(buf)).toEqual(["Hello", "Rich text"]);
  });
});

describe("lintRepo", () => {
  test("scans markdown, web html and api sources, skips tests", () => {
    const root = mkdtempSync(join(tmpdir(), "lint-copy-"));
    try {
      mkdirSync(join(root, "web/dist"), { recursive: true });
      mkdirSync(join(root, "app/src/api"), { recursive: true });
      writeFileSync(join(root, "README.md"), "All good here.\n");
      writeFileSync(join(root, "web/dist/index.html"), "<p>no time decay at all</p>");
      writeFileSync(join(root, "app/src/api/a.ts"), 'export const summary = "Pool APY today";\n');
      writeFileSync(join(root, "app/src/api/a.test.ts"), 'export const bad = "Pool APY today";\n');
      const findings = lintRepo(root);
      expect(findings.map((f) => f.file).sort()).toEqual(["app/src/api/a.ts", "web/dist/index.html"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
