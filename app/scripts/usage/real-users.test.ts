import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildReport, collectExclusions, formatReport, loadRows, type Queryable } from "./real-users-lib";

const a = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const [TEAM, CONTRACT, EXCL, U1, U2, U3] = [a(1), a(2), a(3), a(0xa1), a(0xa2), a(0xa3)];

/** A fake database: answers the two queries by the table they read, like the tagged-template client. */
function fakeSql(trades: { day: string; account: string }[], deposits: { day: string; account: string }[]): Queryable {
  return async (strings) => {
    const q = strings.join("?");
    if (q.includes("FROM pool_events")) return deposits;
    if (q.includes("FROM trades")) return trades;
    throw new Error("unexpected query: " + q);
  };
}

describe("report:users", () => {
  const dir = mkdtempSync(join(tmpdir(), "lmns-users-"));
  const pack = join(dir, "pack.json");
  const deployment = join(dir, "deployment.json");
  writeFileSync(pack, JSON.stringify({ owner: TEAM.toUpperCase().replace("0X", "0x") }));
  writeFileSync(deployment, JSON.stringify({ contracts: { engine: CONTRACT, stocks: [a(9)] } }));
  const { excluded, used } = collectExclusions({ walletPackFile: pack, deploymentFile: deployment, excludedWallets: `${EXCL}, ` });

  test("counts distinct non-team wallets per day, for trades and deposits", async () => {
    const rows = await loadRows(
      fakeSql(
        [
          { day: "2026-11-02", account: U1 },
          { day: "2026-11-02", account: U1 }, // same wallet twice is one wallet
          { day: "2026-11-02", account: TEAM },
          { day: "2026-11-02", account: CONTRACT },
          { day: "2026-11-03", account: U2 },
        ],
        [
          { day: "2026-11-02", account: U1 },
          { day: "2026-11-02", account: U3 },
          { day: "2026-11-02", account: EXCL },
          { day: "2026-11-03", account: TEAM },
        ],
      ),
    );
    expect(buildReport(rows, excluded)).toEqual([
      { day: "2026-11-02", traders: 1, depositors: 2, either: 2 },
      { day: "2026-11-03", traders: 1, depositors: 0, either: 1 },
    ]);
  });

  test("the wallet pack matches case-insensitively, and the zero address is always excluded", () => {
    const report = buildReport(
      { trades: [{ day: "2026-11-02", account: TEAM.toUpperCase().replace("0X", "0x") }, { day: "2026-11-02", account: "0x" + "0".repeat(40) }], deposits: [] },
      excluded,
    );
    expect(report).toEqual([]);
  });

  test("an empty database prints a readable report", () => {
    expect(formatReport([], used)).toContain("no events from outside wallets yet");
  });

  test("the table lists the exclusions used and one line per day", () => {
    const text = formatReport([{ day: "2026-11-02", traders: 3, depositors: 1, either: 3 }], used);
    expect(text).toContain("excluded via wallet pack");
    expect(text).toContain("excluded via EXCLUDED_WALLETS: 1 addresses");
    expect(text).toContain("2026-11-02       3          1       3");
  });

  test("a bad EXCLUDED_WALLETS entry and a missing file are refused", () => {
    expect(() => collectExclusions({ excludedWallets: "0x123" })).toThrow("bad address");
    expect(() => collectExclusions({ walletPackFile: join(dir, "nope.json") })).toThrow("not found");
    rmSync(dir, { recursive: true, force: true });
  });
});
