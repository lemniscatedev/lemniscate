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

test("per-wallet keys (R3-07): a wallet is limited per client that names it, never across clients; bodies without a wallet fall back to IP only", async () => {
  const server = new Hono();
  server.use("*", rateLimit({ limit: 100, walletLimit: 2, windowMs: 60_000, clientIpHeader: "cf-connecting-ip", now: () => 0, walletKeys: walletsFromBody(["address", "account"]) }));
  server.post("/", (context) => context.text("ok"));
  const alice = "0x" + "a1".repeat(20);
  const bob = "0x" + "b2".repeat(20);
  const post = (ip: string, body: unknown) => server.request("/", { method: "POST", headers: { "cf-connecting-ip": ip, "content-type": "application/json" }, body: JSON.stringify(body) });
  expect((await post("1.1.1.1", { address: alice })).status).toBe(200);
  expect((await post("1.1.1.1", { account: alice.toUpperCase().replace("0X", "0x") })).status).toBe(200);
  expect((await post("1.1.1.1", { address: alice })).status).toBe(429); // the same client, the same wallet: limited
  expect((await post("1.1.1.1", { address: bob })).status).toBe(200);
  expect((await post("3.3.3.3", { address: alice })).status).toBe(200); // another client is not charged for 1.1.1.1's requests
  for (let i = 0; i < 5; i++) expect((await post(`9.9.9.${i}`, { nothing: true })).status).toBe(200);
  expect((await server.request("/", { method: "POST", headers: { "content-type": "application/json" }, body: "not json" })).status).toBe(200);
});

function walletServer(limit: number, walletLimit: number, now: () => number) {
  const server = new Hono();
  server.use("*", rateLimit({ limit, walletLimit, windowMs: 60_000, clientIpHeader: "cf-connecting-ip", now, walletKeys: walletsFromBody(["account", "owner"]) }));
  server.post("/", (context) => context.text("ok"));
  return (ip: string, body: unknown) => server.request("/", { method: "POST", headers: { "cf-connecting-ip": ip, "content-type": "application/json" }, body: JSON.stringify(body) });
}

test("R3-07 PoC: one IP flooding requests that name a holder's wallet no longer locks the holder out", async () => {
  const victim = "0x" + "c3".repeat(20);
  const post = walletServer(300, 30, () => 0);
  for (let i = 0; i < 300; i++) await post("198.51.100.66", { account: victim, series: "x", units: "1" });
  for (let i = 0; i < 300; i++) await post("198.51.100.66", { userOp: { sender: victim } });
  expect((await post("198.51.100.66", { account: victim })).status).toBe(429); // the flooder is limited ...
  for (let i = 0; i < 30; i++) expect((await post("203.0.113.10", { account: victim })).status).toBe(200); // ... the holder is not
  expect((await post("203.0.113.10", { account: victim })).status).toBe(429); // the holder's own share is still a limit
});

test("R3-07 PROPERTY: any number of requests from other clients naming account A never make a request from A's own client return 429", async () => {
  let seed = 7007;
  const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  const wallet = (n: number) => "0x" + n.toString(16).padStart(40, "0");
  for (let trial = 0; trial < 25; trial++) {
    const limit = 5 + rnd(20);
    const walletLimit = 1 + rnd(limit);
    let at = 0;
    const post = walletServer(limit, walletLimit, () => at);
    const victim = wallet(0xa000 + trial);
    const home = `2001:db8:${trial.toString(16)}:1::1`;
    // The holder's own fixed window, as the limiter keeps it: it opens at the holder's first request after the last one closed.
    let ownInWindow = 0;
    let windowStart = -Infinity;
    for (let step = 0; step < 400; step++) {
      at += rnd(400);
      if (rnd(10) < 8) {
        // a stranger: another IPv4 or another /64, naming the victim in any field the limiter reads
        const ip = rnd(2) ? `198.51.100.${rnd(250)}` : `2001:db8:ffff:${rnd(65535).toString(16)}::${rnd(9) + 1}`;
        const field = rnd(3);
        await post(ip, field === 0 ? { account: victim } : field === 1 ? { owner: victim } : { userOp: { sender: victim } });
      } else {
        if (at - windowStart >= 60_000) { windowStart = at; ownInWindow = 0; }
        if (ownInWindow >= walletLimit) continue; // the holder's own share is a limit: stay inside it
        ownInWindow += 1;
        const response = await post(home.replace("::1", `::${rnd(9) + 1}`), { account: victim });
        expect(response.status).toBe(200);
      }
    }
  }
});
