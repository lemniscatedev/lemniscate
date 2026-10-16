import { expect, test } from "bun:test";
import { createLogger } from "../log";
import { createScheduler, retryDelayMs } from "./scheduler";

test("retry delay doubles from 15 seconds to the cap and never exceeds the job interval", () => {
  expect([1, 2, 3, 4, 5, 6, 7, 8, 20].map((n) => retryDelayMs(n, 3_600_000))).toEqual(
    [15_000, 30_000, 60_000, 120_000, 240_000, 480_000, 600_000, 600_000, 600_000]);
  expect(retryDelayMs(5, 60_000)).toBe(60_000);
  expect(retryDelayMs(0, 3_600_000)).toBe(15_000);
});

test("a failing job does not stop the others, and its failure is recorded", async () => {
  const statements: string[] = [];
  const sql = Object.assign(async (strings: TemplateStringsArray) => { statements.push(strings.join("?")); return []; }, {});
  const scheduler = createScheduler(sql as never, createLogger("silent"));
  let good = 0;
  let bad = 0;
  scheduler.add({ name: "bad", everyMs: 60_000, run: async () => { bad++; throw new Error("rpc down"); } });
  scheduler.add({ name: "good", everyMs: 60_000, run: async () => { good++; return { ok: true }; } });
  await scheduler.trigger("bad");
  await scheduler.trigger("good");
  expect([bad, good]).toEqual([1, 1]);
  expect(statements.some((s) => s.includes("last_error"))).toBe(true);
  await scheduler.stop();
});
