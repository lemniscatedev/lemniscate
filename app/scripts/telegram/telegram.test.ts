import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const here = import.meta.dir;
const TOKEN = "123456:TESTTOKEN-never-print-me";
let dir: string;
let server: ReturnType<typeof Bun.serve>;
let calls: { path: string; fields: Record<string, string>; files: Record<string, number> }[] = [];
let failNext = false;

async function run(script: string, args: string[], extraEnv: Record<string, string> = {}) {
  const proc = Bun.spawn(["python3", join(here, script), ...args], {
    env: { ...process.env, PATH: `${join(dir, "bin")}:${process.env.PATH}`, RELEASE_ENV: join(dir, "release.env"), TELEGRAM_API_BASE: `http://127.0.0.1:${server.port}`, ...extraEnv },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code: proc.exitCode, out: out + err };
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "lmns-tg-"));
  writeFileSync(join(dir, "release.env"), `# test\nTELEGRAM_BOT_TOKEN=${TOKEN}\nTELEGRAM_COMMUNITY_CHAT_ID=-1001\nTELEGRAM_OPS_CHAT_ID=-1002\n`);
  // a curl wrapper that records every command line, then runs the real curl: the token must never be in it
  const bin = join(dir, "bin");
  Bun.spawnSync(["mkdir", "-p", bin]);
  const real = Bun.spawnSync(["which", "curl"]).stdout.toString().trim();
  writeFileSync(join(bin, "curl"), `#!/bin/sh\nprintf '%s\\n' "$*" >> "${join(dir, "curl-argv.log")}"\nexec ${real} "$@"\n`);
  chmodSync(join(bin, "curl"), 0o755);
  writeFileSync(join(dir, "a.png"), "png-a");
  writeFileSync(join(dir, "b.png"), "png-b");
  const slots = (day: number, hours: number[], from: number) =>
    hours.map((h, i) => ({ id: `TU${String(from + i).padStart(2, "0")}`, n: from + i, day, title: `Title ${from + i}`, slot: `2026-11-0${day}T${String(h).padStart(2, "0")}:00:00Z` }));
  // launch Sunday 2026-11-01 05:00 UTC; US clocks change at 06:00 UTC that day (EDT -> EST)
  const updates = [
    { id: "TU01", n: 1, day: 1, title: "Status page", slot: "2026-11-01T05:00:00Z" },
    { id: "TU02", n: 2, day: 1, title: "Holding cost", slot: "2026-11-01T07:00:00Z" },
    ...slots(2, [5, 7], 3),
  ];
  writeFileSync(join(dir, "schedule.json"), JSON.stringify({ launchAt: "2026-11-01T05:00:00Z", cadence: { intervalMinutes: 120 }, updates }));
  // 36 long-titled updates over 3 days to force a split
  const long = Array.from({ length: 36 }, (_, i) => ({ id: `TU${i + 1}`, n: i + 1, day: Math.floor(i / 12) + 1, title: "x".repeat(300 + (i % 5)) }));
  writeFileSync(join(dir, "long.json"), JSON.stringify({ launchAt: "2026-11-03T14:00:00Z", cadence: { intervalMinutes: 120 }, updates: long }));
  writeFileSync(
    join(dir, "posts.txt"),
    ["HEADER", "=".repeat(30), "UPDATE 01 · Day 1, hour 00 after launch ({{UTC}}) · Status page", "Poster: posters/update-01.png", "", "[Telegram / Discord]", "Status page is live. " + "w ".repeat(900), "", "[X] (10 characters)", "x text", "=".repeat(30), "UPDATE 02 · Day 1 · Other", "", "[Telegram / Discord]", "second", ""].join("\n"),
  );
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const form = await req.formData();
      const fields: Record<string, string> = {};
      const files: Record<string, number> = {};
      for (const [k, v] of form.entries()) {
        if (typeof v === "string") fields[k] = v;
        else files[k] = (v as Blob).size;
      }
      calls.push({ path: url.pathname, fields, files });
      if (failNext) {
        failNext = false;
        return Response.json({ ok: false, description: `Bad Request: chat not found for ${TOKEN}` }, { status: 400 });
      }
      return Response.json({ ok: true, result: {} });
    },
  });
});
afterAll(() => {
  server?.stop(true);
  rmSync(dir, { recursive: true, force: true });
});

describe("post-schedule", () => {
  test("dry run prints UTC and local time with DST, sends nothing, reads no token", async () => {
    calls = [];
    const r = await run("post-schedule.py", ["--schedule", join(dir, "schedule.json"), "--new", "TU02", "--dry-run"], { RELEASE_ENV: join(dir, "missing.env") });
    expect(r.code).toBe(0);
    expect(calls).toHaveLength(0);
    expect(r.out).toContain("05:00 UTC (01:00 EDT): Update 1, Status page");
    expect(r.out).toContain("07:00 UTC (02:00 EST): Update 2, Holding cost (NEW)"); // clocks fell back in between
    expect(r.out).toContain("Day 2");
    expect(r.out).toContain("Each update goes live only after its checks pass");
    expect(r.out).not.toContain("—");
  });

  test("sends to the community chat through the fake receiver, token in the URL path only, never in argv or output", async () => {
    calls = [];
    const r = await run("post-schedule.py", ["--schedule", join(dir, "schedule.json")]);
    expect(r.code).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.path).toBe(`/bot${TOKEN}/sendMessage`);
    expect(calls[0]!.fields.chat_id).toBe("-1001");
    expect(calls[0]!.fields.text).toContain("Update 3");
    expect(r.out).not.toContain(TOKEN);
    expect(readFileSync(join(dir, "curl-argv.log"), "utf8")).not.toContain(TOKEN.split(":")[1]!);
    expect(readFileSync(join(dir, "curl-argv.log"), "utf8")).toContain("-K -");
  });

  test("splits under 3,800 characters and puts the footer last", async () => {
    calls = [];
    const r = await run("post-schedule.py", ["--schedule", join(dir, "long.json"), "--chat", "ops"]);
    expect(r.code).toBe(0);
    expect(calls.length).toBeGreaterThan(2);
    for (const c of calls) {
      expect(c.fields.text!.length).toBeLessThanOrEqual(3800);
      expect(c.fields.chat_id).toBe("-1002");
    }
    expect(calls.at(-1)!.fields.text).toContain("held, never released broken");
    expect(calls.map((c) => c.fields.text).join("\n")).toContain("Update 36");
  });

  test("refuses a schedule without a launch time", async () => {
    writeFileSync(join(dir, "none.json"), JSON.stringify({ launchAt: null, updates: [{ id: "TU01", n: 1, day: 1, title: "t" }] }));
    const r = await run("post-schedule.py", ["--schedule", join(dir, "none.json"), "--dry-run"]);
    expect(r.code).toBe(2);
    expect(r.out).toContain("launch time is not set");
  });

  test("a Telegram error never echoes the token", async () => {
    calls = [];
    failNext = true;
    const r = await run("post-schedule.py", ["--schedule", join(dir, "schedule.json")]);
    expect(r.code).toBe(2);
    expect(r.out).toContain("refused by Telegram");
    expect(r.out).not.toContain(TOKEN);
  });

  test("an API base that is not Telegram or a local server is refused before any token is read", async () => {
    const r = await run("post-schedule.py", ["--schedule", join(dir, "schedule.json")], { TELEGRAM_API_BASE: "https://evil.example.com" });
    expect(r.code).toBe(2);
    expect(r.out).toContain("TELEGRAM_API_BASE");
  });
});

describe("post-poster", () => {
  test("one image uses sendPhoto with the caption and the file", async () => {
    calls = [];
    const r = await run("post-poster.py", ["--image", join(dir, "a.png"), "--caption", "Short caption"]);
    expect(r.code).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.path).toBe(`/bot${TOKEN}/sendPhoto`);
    expect(calls[0]!.fields.caption).toBe("Short caption");
    expect(calls[0]!.files.photo).toBe(5);
    expect(r.out).not.toContain(TOKEN);
  });

  test("several images use sendMediaGroup with the caption on the first only", async () => {
    calls = [];
    const r = await run("post-poster.py", ["--image", join(dir, "a.png"), "--image", join(dir, "b.png"), "--caption", "Album"]);
    expect(r.code).toBe(0);
    expect(calls[0]!.path).toBe(`/bot${TOKEN}/sendMediaGroup`);
    const media = JSON.parse(calls[0]!.fields.media!);
    expect(media).toHaveLength(2);
    expect(media[0].caption).toBe("Album");
    expect(media[1].caption).toBeUndefined();
    expect(Object.keys(calls[0]!.files).sort()).toEqual(["p0", "p1"]);
  });

  test("a caption over 1,024 characters is refused, exactly 1,024 is accepted", async () => {
    calls = [];
    const over = await run("post-poster.py", ["--image", join(dir, "a.png"), "--caption", "c".repeat(1025)]);
    expect(over.code).toBe(2);
    expect(over.out).toContain("stops at 1024");
    expect(calls).toHaveLength(0);
    const ok = await run("post-poster.py", ["--image", join(dir, "a.png"), "--caption", "c".repeat(1024)]);
    expect(ok.code).toBe(0);
    expect(calls[0]!.fields.caption).toHaveLength(1024);
  });

  test("--update N sends the poster with a short caption, then the full text as split messages", async () => {
    calls = [];
    mkdirSyncP(join(dir, "posters"));
    writeFileSync(join(dir, "posters", "update-01.png"), "png-1");
    const r = await run("post-poster.py", ["--update", "1", "--posters", join(dir, "posters"), "--posts", join(dir, "posts.txt")]);
    expect(r.code).toBe(0);
    expect(calls[0]!.path).toContain("/sendPhoto");
    expect(calls[0]!.fields.caption).toBe("Update 1: Status page");
    const texts = calls.slice(1);
    expect(texts.length).toBeGreaterThanOrEqual(1);
    for (const t of texts) {
      expect(t.path).toContain("/sendMessage");
      expect(t.fields.text!.length).toBeLessThanOrEqual(3800);
    }
    expect(texts[0]!.fields.text).toContain("Status page is live.");
    expect(texts.map((t) => t.fields.text).join(" ")).not.toContain("second");
  });

  test("dry run sends nothing and needs no env file", async () => {
    calls = [];
    const r = await run("post-poster.py", ["--image", join(dir, "a.png"), "--caption", "Hi", "--dry-run"], { RELEASE_ENV: join(dir, "missing.env") });
    expect(r.code).toBe(0);
    expect(calls).toHaveLength(0);
    expect(r.out).toContain("would send photo");
  });

  test("more than 10 images and a missing file are refused", async () => {
    const many = Array.from({ length: 11 }, () => ["--image", join(dir, "a.png")]).flat();
    expect((await run("post-poster.py", [...many, "--dry-run"])).out).toContain("at most 10");
    expect((await run("post-poster.py", ["--image", join(dir, "nope.png"), "--dry-run"])).out).toContain("image not found");
  });
});

function mkdirSyncP(p: string) {
  Bun.spawnSync(["mkdir", "-p", p]);
}
