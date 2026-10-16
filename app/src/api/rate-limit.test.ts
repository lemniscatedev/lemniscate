import { expect, test } from "bun:test";
import { Hono } from "hono";
import { rateLimit } from "./rate-limit";

function app(limit: number, now: () => number) {
  const server = new Hono();
  server.use("*", rateLimit({ limit, windowMs: 60_000, clientIpHeader: "cf-connecting-ip", now }));
  server.get("/", (context) => context.text("ok"));
  return server;
}

test("requests over the per-IP limit get 429 until the window resets", async () => {
  let now = 0;
  const server = app(2, () => now);
  const hit = (ip: string) => server.request("/", { headers: { "cf-connecting-ip": ip } });
  expect((await hit("1.1.1.1")).status).toBe(200);
  expect((await hit("1.1.1.1")).status).toBe(200);
  const limited = await hit("1.1.1.1");
  expect(limited.status).toBe(429);
  expect(limited.headers.get("retry-after")).toBe("60");
  expect((await hit("2.2.2.2")).status).toBe(200);
  now = 60_000;
  expect((await hit("1.1.1.1")).status).toBe(200);
});

test("the client IP falls back to the first X-Forwarded-For hop, and 0 disables the limiter", async () => {
  const server = app(1, () => 0);
  const hit = (forwarded: string) => server.request("/", { headers: { "x-forwarded-for": forwarded } });
  expect((await hit("3.3.3.3, 10.0.0.1")).status).toBe(200);
  expect((await hit("3.3.3.3, 10.0.0.2")).status).toBe(429);
  expect((await hit("4.4.4.4, 10.0.0.1")).status).toBe(200);
  const open = app(0, () => 0);
  for (let i = 0; i < 5; i++) expect((await open.request("/")).status).toBe(200);
});
