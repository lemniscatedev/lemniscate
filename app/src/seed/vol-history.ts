/** Pure parts of the vol-engine history seed (todo 13 R9). IO lives in scripts/seed-vol-history.ts. */

export interface Bar { date: string; open: number; close: number }
export interface Report { /** New York date of the release */ date: string; /** minutes after New York midnight */ minute: number }

const ET = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});

export function etParts(date: Date): { date: string; minute: number } {
  const p = Object.fromEntries(ET.formatToParts(date).filter((x) => x.type !== "literal").map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, minute: Number(p.hour) * 60 + Number(p.minute) };
}

/** Daily bars from a Yahoo chart response (open and close; rows with a missing value are dropped). */
export function parseYahooBars(payload: unknown): Bar[] {
  const result = (payload as { chart?: { result?: { timestamp?: number[]; indicators?: { quote?: { open?: (number | null)[]; close?: (number | null)[] }[] } }[] } })
    .chart?.result?.[0];
  const stamps = result?.timestamp ?? [];
  const quote = result?.indicators?.quote?.[0];
  if (!stamps.length || !quote?.open || !quote.close) throw new Error("Yahoo chart response has no daily bars");
  const bars: Bar[] = [];
  stamps.forEach((stamp, i) => {
    const open = quote.open![i];
    const close = quote.close![i];
    if (typeof open === "number" && typeof close === "number" && open > 0 && close > 0) {
      bars.push({ date: etParts(new Date(stamp * 1000)).date, open, close });
    }
  });
  return bars;
}

const daysBetween = (a: string, b: string): number => Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000);

/** Earnings releases from an SEC submissions response: 8-Ks carrying Item 2.02 (results of operations). */
export function parseEdgarReports(payload: unknown): Report[] {
  const recent = (payload as { filings?: { recent?: { form: string[]; items: string[]; acceptanceDateTime: string[] } } }).filings?.recent;
  if (!recent) throw new Error("SEC response has no recent filings");
  const reports: Report[] = [];
  recent.form.forEach((form, i) => {
    if (form !== "8-K" || !(recent.items[i] ?? "").split(",").map((x) => x.trim()).includes("2.02")) return;
    const accepted = new Date(recent.acceptanceDateTime[i]!);
    if (Number.isFinite(accepted.getTime())) reports.push(etParts(accepted));
  });
  reports.sort((a, b) => (a.date < b.date ? -1 : 1));
  // Some companies also file Item 2.02 for other results (Tesla files its delivery numbers on the 2nd of each
  // quarter, three weeks before earnings). Reports are a quarter apart, so within 40 days only the later one counts.
  const collapsed: Report[] = [];
  for (const report of reports) {
    const last = collapsed.at(-1);
    if (last && daysBetween(last.date, report.date) < 40) collapsed[collapsed.length - 1] = report;
    else collapsed.push(report);
  }
  return collapsed;
}

const round = (x: number) => Math.round(x * 1e6) / 1e6;

/** Absolute Friday-close to Monday-open moves, the last `weeks` of them, oldest first. Only a Friday followed directly by
 * the next Monday counts (a holiday weekend is a longer gap and a different statistic). */
export function weekendGaps(bars: readonly Bar[], weeks = 26): number[] {
  const gaps: number[] = [];
  for (let i = 0; i + 1 < bars.length; i++) {
    const a = bars[i]!;
    const b = bars[i + 1]!;
    if (new Date(`${a.date}T12:00:00Z`).getUTCDay() === 5 && daysBetween(a.date, b.date) === 3) gaps.push(round(Math.abs(b.open / a.close - 1)));
  }
  return gaps.slice(-weeks);
}

/** The one-day price reaction to each of the last `count` reports, signed, oldest first. A release after the 16:00 close
 * moves the next session; one before the open moves the same session. */
export function earningsMoves(bars: readonly Bar[], reports: readonly Report[], count = 8): number[] {
  const moves: number[] = [];
  for (const report of reports) {
    const index = bars.findIndex((bar) => bar.date >= report.date);
    if (index < 0) continue;
    const post = report.minute >= 16 * 60;
    if (post) {
      const base = bars[index]!.date === report.date ? index : -1;
      const reaction = base + 1;
      if (base < 0 || reaction >= bars.length) continue;
      moves.push(round(bars[reaction]!.close / bars[base]!.close - 1));
    } else {
      if (bars[index]!.date !== report.date || index === 0) continue;
      moves.push(round(bars[index]!.close / bars[index - 1]!.close - 1));
    }
  }
  return moves.slice(-count);
}
