// Copy lint (todo 22 R1): fails on wording the product must never use, in every user-visible string the repository ships:
// the website (`web/`: HTML text, string literals in the shipped JavaScript, CMS content), the Markdown docs at the
// repository root, and the strings of the API (`app/src/api`), the agent server (`app/src/mcp`) and pay-per-call
// (`app/src/x402`) sources, which become route summaries, schema descriptions and tool descriptions.
// Rules (CLAUDE.md): never "APY", "yield", "income" for the pool or vaults (say NAV, funding received); never "can't lose",
// "free options", "no fees", "no time decay"; no partnership or endorsement wording with Robinhood, Chainlink, Cboe or any venue.
// Usage: bun run scripts/lint-copy.ts [repoRoot]      (exit 1 when anything is found)
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import ts from "typescript";

export const RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bAPY\b|\bAPR\b/, 'APY/APR: say NAV or funding received'],
  [/\byield(s|ing)?\b/i, '"yield": say NAV or funding received'],
  [/\bincome\b/i, '"income": say funding received'],
  [/\bcan(?:'|’|no)?t lose\b|\bcannot lose\b|\bno risk\b|\brisk[- ]free\b|\bguaranteed (?:return|profit)/i, "no-loss or guarantee wording"],
  [/\bfree options?\b/i, '"free options"'],
  [/\bno fees?\b|\bzero fees?\b|\bfee[- ]free\b/i, '"no fees"'],
  [/\bno (?:time )?decay\b/i, '"no time decay"'],
  [
    /\b(?:partner(?:ed|s|ship)?|endorse(?:d|s|ment)?|affiliated|in association with|sponsored by|backed by|powered by|official (?:partner|integration))\b/i,
    "partnership or endorsement wording",
  ],
];

export interface Finding {
  readonly file: string;
  readonly reason: string;
  readonly excerpt: string;
}

/** Applies every rule to one piece of text. */
export function checkText(file: string, text: string): Finding[] {
  const findings: Finding[] = [];
  for (const [pattern, reason] of RULES) {
    const match = pattern.exec(text);
    if (match) {
      const start = Math.max(0, match.index - 50);
      findings.push({ file, reason, excerpt: text.slice(start, match.index + match[0].length + 50).replace(/\s+/g, " ") });
    }
  }
  return findings;
}

/** Visible text of an HTML page: script and style bodies dropped, meta content kept, tags removed. */
export function htmlText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<meta[^>]*content="([^"]*)"[^>]*>/gi, " $1 ")
    .replace(/<[^>]+>/g, " ");
}

/** Every string literal of a TypeScript file (comments and identifiers are not copy). Template literals contribute their text parts. */
export function tsStrings(source: string, fileName = "file.ts"): string[] {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const out: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) out.push(node.text);
    else if (ts.isTemplateExpression(node)) {
      out.push(node.head.text);
      for (const span of node.templateSpans) out.push(span.literal.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return out;
}

const JS_STRING = /`(?:[^`\\]|\\.)*`|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g;
/** String literals of shipped (possibly minified) JavaScript, by regex: good enough for text, no parsing needed. */
export function jsStrings(source: string): string[] {
  return source.match(JS_STRING) ?? [];
}

/** Reads the length-prefixed `.framercms` files: uint32 itemCount, per item uint16 fieldCount, per field uint32 keyLength + key +
 * type byte + value (0x0c string, 0x0a JSON, 0x0b rich text with a version byte first: uint32 length + UTF-8; 0x04 number: 8 bytes;
 * 0x00/0x01/0x02 no payload). Returns the string values. */
export function cmsStrings(buf: Buffer): string[] {
  let o = 0;
  const u32 = () => ((o += 4), buf.readUInt32BE(o - 4));
  const u16 = () => ((o += 2), buf.readUInt16BE(o - 2));
  const str = (n: number) => ((o += n), buf.subarray(o - n, o).toString("utf8"));
  const out: string[] = [];
  const count = u32();
  for (let i = 0; i < count; i++) {
    const fields = u16();
    for (let j = 0; j < fields; j++) {
      str(u32());
      const type = buf[o++];
      if (type === 0x0c || type === 0x0a) out.push(str(u32()));
      else if (type === 0x0b) {
        o += 1;
        out.push(str(u32()));
      } else if (type === 0x04) o += 8;
      else if (type !== 0x00 && type !== 0x01 && type !== 0x02) throw new Error(`unknown CMS type 0x${type?.toString(16)} at ${o - 1}`);
    }
  }
  return out;
}

// Library modules in the website bundle carry developer messages, not product copy.
const LIBRARY = /^(react|framer|motion|rolldown-runtime|shared-lib)\./;
const SKIP_DIRS = new Set(["app", "node_modules", ".git", "fonts", "photos", "slots", "icons", "lib", "out", "cache"]);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(path, out);
    } else out.push(path);
  }
  return out;
}

function exists(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Lints a repository checkout and returns every finding. */
export function lintRepo(root: string): Finding[] {
  const findings: Finding[] = [];
  const add = (file: string, text: string) => findings.push(...checkText(relative(root, file), text));

  // 1. Markdown at the root and in the service and contract folders (the vendored libraries are skipped by SKIP_DIRS).
  for (const dir of ["", "contracts", "app", "vol-engine"]) {
    const base = join(root, dir);
    if (!exists(base)) continue;
    for (const name of readdirSync(base)) if (name.endsWith(".md")) add(join(base, name), readFileSync(join(base, name), "utf8"));
  }

  // 2. The website: HTML text, shipped JavaScript strings, CMS content.
  const web = join(root, "web");
  if (exists(web)) {
    for (const file of walk(web)) {
      const name = basename(file);
      if (file.endsWith(".html")) add(file, htmlText(readFileSync(file, "utf8")));
      else if (/\.m?js$/.test(file) && !LIBRARY.test(name) && relative(web, file).startsWith("dist")) {
        for (const text of jsStrings(readFileSync(file, "utf8"))) if (text.length > 3 && !/__lmContentB64/.test(text)) add(file, text);
      } else if (file.endsWith(".framercms")) {
        for (const text of cmsStrings(readFileSync(file))) add(file, text);
      }
    }
  }

  // 3. API, agent-server and pay-per-call sources: route summaries, schema descriptions, tool descriptions.
  for (const dir of ["app/src/api", "app/src/mcp", "app/src/x402"]) {
    const base = join(root, dir);
    if (!exists(base)) continue;
    for (const file of walk(base)) {
      if (!file.endsWith(".ts") || file.endsWith(".test.ts")) continue;
      for (const text of tsStrings(readFileSync(file, "utf8"), file)) if (text.length > 3) add(file, text);
    }
  }
  return findings;
}

if (import.meta.main) {
  const root = resolve(process.argv[2] ?? join(import.meta.dir, "../.."));
  const findings = lintRepo(root);
  if (findings.length > 0) {
    for (const f of findings) console.error(`${f.file}: ${f.reason}: "${f.excerpt}"`);
    console.error(`Copy lint: ${findings.length} forbidden phrase(s).`);
    process.exitCode = 1;
  } else {
    console.log("Copy lint: no forbidden phrases.");
  }
}
