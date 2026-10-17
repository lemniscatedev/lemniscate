import { expect, test } from "bun:test";
import { Hono } from "hono";
import { rateLimit, rateLimitKey, walletsFromBody } from "./rate-limit";

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

test("rateLimitKey: IPv4 by address, IPv6 by /64, IPv4-mapped IPv6 as IPv4", () => {
  expect(rateLimitKey("203.0.113.9")).toBe("203.0.113.9");
  expect(rateLimitKey("2001:db8:1:2:aaaa:bbbb:cccc:dddd")).toBe("2001:db8:1:2::/64");
  expect(rateLimitKey("2001:DB8:1:2::1")).toBe("2001:db8:1:2::/64");
  expect(rateLimitKey("2001:db8:1:2:ffff:ffff:ffff:ffff")).toBe(rateLimitKey("2001:db8:1:2::5"));
  expect(rateLimitKey("2001:db8:1:3::5")).not.toBe(rateLimitKey("2001:db8:1:2::5"));
  expect(rateLimitKey("::ffff:203.0.113.9")).toBe("203.0.113.9");
  expect(rateLimitKey("::1")).toBe("0:0:0:0::/64");
  expect(rateLimitKey("unknown")).toBe("unknown");
});

test("addresses inside one IPv6 /64 share one budget; another /64 and IPv4 do not", async () => {
  const server = app(2, () => 0);
  const hit = (ip: string) => server.request("/", { headers: { "cf-connecting-ip": ip } });
  expect((await hit("2001:db8:1:2::1")).status).toBe(200);
  expect((await hit("2001:db8:1:2:dead:beef:0:7")).status).toBe(200);
  expect((await hit("2001:db8:1:2:1234::9")).status).toBe(429);
  expect((await hit("2001:db8:1:9::1")).status).toBe(200);
  expect((await hit("203.0.113.9")).status).toBe(200);
});

test("per-wallet keys: one wallet is limited across many client addresses, bodies without a wallet fall back to IP only", async () => {
  const server = new Hono();
  server.use("*", rateLimit({ limit: 100, walletLimit: 2, windowMs: 60_000, clientIpHeader: "cf-connecting-ip", now: () => 0, walletKeys: walletsFromBody(["address", "account"]) }));
  server.post("/", (context) => context.text("ok"));
  const alice = "0x" + "a1".repeat(20);
  const bob = "0x" + "b2".repeat(20);
  const post = (ip: string, body: unknown) => server.request("/", { method: "POST", headers: { "cf-connecting-ip": ip, "content-type": "application/json" }, body: JSON.stringify(body) });
  expect((await post("1.1.1.1", { address: alice })).status).toBe(200);
  expect((await post("2.2.2.2", { account: alice.toUpperCase().replace("0X", "0x") })).status).toBe(200);
  expect((await post("3.3.3.3", { address: alice })).status).toBe(429);
  expect((await post("3.3.3.3", { address: bob })).status).toBe(200);
  for (let i = 0; i < 5; i++) expect((await post(`9.9.9.${i}`, { nothing: true })).status).toBe(200);
  expect((await server.request("/", { method: "POST", headers: { "content-type": "application/json" }, body: "not json" })).status).toBe(200);
});
