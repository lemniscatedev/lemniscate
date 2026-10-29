import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { isAddress } from "viem";
import type { ApiDependencies } from "../types";
import { apiNow } from "../clock";
import {
  currentWeek, programStatus, unitsText, weekBounds, weeklyPoolUnits, writerRewards, excludedWallets,
} from "../../config/writer-rewards";
import { buildWeek } from "../../rewards/writer-week";
import { indexedThroughSec } from "../../rewards/writer-history";
import { microText, usdgDays, type WeekTable } from "../../rewards/writer-points";

const TTL_MS = 30_000;
const decimal = z.string().regex(/^-?\d+(?:\.\d+)?$/);

const querySchema = z.object({
  week: z.string().regex(/^\d{1,3}$/).optional(),
  address: z.string().refine((value) => isAddress(value, { strict: false }), "Invalid EVM address").optional(),
});

const walletSchema = z.object({
  address: z.string(),
  excluded: z.boolean(),
  eligible: z.boolean(),
  reason: z.string(),
  depositHeldUsdg: decimal,
  timeWeightedUsdg: decimal,
  pointsUsdgDays: decimal,
  tokens: decimal,
  capped: z.boolean(),
});

export const writerRewardsResponseSchema = z.object({
  program: z.object({
    status: z.enum(["off", "awaiting_token", "scheduled", "active", "ended"]),
    message: z.string(),
    tokenSymbol: z.string(),
    tokenAddress: z.string().nullable(),
    weeklyPoolTokens: decimal,
    weeklyPoolPctOfSupply: z.number(),
    tokenTotalSupply: decimal,
    weeks: z.number().int(),
    startAt: z.string().nullable(),
    perWalletCapPct: z.number(),
    minTimeWeightedUsdg: z.number(),
    overCapPaidToOthers: z.boolean(),
    rules: z.array(z.string()),
  }),
  /** The reward week shown, or the last 7 days as a preview ("preview": true) before $LMNS launches. */
  week: z.object({
    number: z.number().int().nullable(),
    preview: z.boolean(),
    /** "illustrative": the 7-day preview before $LMNS exists (nothing is paid); "projected": a reward week still running,
     * counted as if every wallet stays in until it ends; "final": the indexer has read past the week's end. */
    basis: z.enum(["illustrative", "projected", "final"]),
    start: z.string(),
    end: z.string(),
    final: z.boolean(),
    eligibleWallets: z.number().int(),
    totalPointsUsdgDays: decimal,
    allocatedTokens: decimal,
    unallocatedTokens: decimal,
    digest: z.string(),
  }).nullable(),
  /** The requested address's own row (null without ?address=). */
  you: walletSchema.nullable(),
  notes: z.array(z.string()),
});

const route = createRoute({
  method: "get", path: "/v1/writers/rewards", tags: ["vault"],
  request: { query: querySchema },
  responses: {
    200: { description: "Early-writer $LMNS reward rules, the week's totals and, with ?address=, that wallet's own points", content: { "application/json": { schema: writerRewardsResponseSchema } } },
    404: { description: "No such reward week", content: { "application/json": { schema: z.object({ error: z.string(), message: z.string() }) } } },
  },
});

export const WRITER_RULES = (): string[] => {
  const c = writerRewards;
  const pool = unitsText(weeklyPoolUnits(), c.tokenDecimals);
  return [
    `Each reward week shares ${Number(pool).toLocaleString("en-US")} ${c.tokenSymbol} (${c.weeklyPoolBpsOfSupply / 100}% of the ${Number(c.tokenTotalSupply).toLocaleString("en-US")} total supply) between qualifying writers, for ${c.weeks} weeks; then the program is reviewed.`,
    "Points are the USDG you deposited that is still in the pool, multiplied by the days it stayed there during the week (USDG-days). They come only from Writer Pool events on chain.",
    `A wallet qualifies when its deposits still in the pool averaged at least ${c.minTimeWeightedUsdg.toLocaleString("en-US")} USDG over the whole week.`,
    `Your share of the week is your points divided by all qualifying points, and at most ${c.perWalletCapBps / 100}% of the week's ${c.tokenSymbol} per wallet.${c.redistributeOverCap ? " Anything above that cap is shared among the other qualifying wallets." : " Anything above that cap is not paid out; it stays with the owner."}`,
    "The cap is per wallet and there is no identity check, so one person can split deposits across several wallets and receive more than the cap in total. This is a known, accepted limit of the program.",
    "Asking to withdraw stops points for those shares at once. Shares received by transfer do not count; only USDG a wallet deposited itself does.",
    "Team and operator wallets, Lemniscate contracts, the zero address and contract wallets are excluded.",
    "Rewards are paid by the owner after each week from a list anyone can recompute. They have no cash value and are not a promise of any amount; amounts and dates are announced in the official channels.",
    "Not offered to residents of the United Kingdom, Canada or Switzerland.",
  ];
};

function statusMessage(status: ReturnType<typeof programStatus>): string {
  const symbol = writerRewards.tokenSymbol;
  switch (status) {
    case "off": return `Early-writer ${symbol} rewards are switched off.`;
    case "awaiting_token": return `Rewards start when $${symbol} launches. Until then the numbers here are a preview of the last 7 days.`;
    case "scheduled": return `Reward week 1 starts at ${writerRewards.startAt}.`;
    case "active": return `Early-writer ${symbol} rewards are running.`;
    case "ended": return `The ${writerRewards.weeks}-week early-writer program has ended and is being reviewed.`;
  }
}

/** L3: how to read a week's figures. Before $LMNS: illustrative; a running week: projected as if everyone stays in. */
export function weekBasis(number: number | null, final: boolean): "illustrative" | "projected" | "final" {
  return number === null ? "illustrative" : final ? "final" : "projected";
}

function weekView(table: WeekTable, number: number | null, final: boolean) {
  const dec = writerRewards.tokenDecimals;
  return {
    number,
    preview: number === null,
    basis: weekBasis(number, final),
    start: new Date(table.startSec * 1_000).toISOString(),
    end: new Date(table.endSec * 1_000).toISOString(),
    final,
    eligibleWallets: table.eligibleWallets,
    totalPointsUsdgDays: usdgDays(table.totalEligibleWeight),
    allocatedTokens: unitsText(table.allocatedUnits, dec),
    unallocatedTokens: unitsText(table.unallocatedUnits, dec),
    digest: table.digest,
  };
}

export function registerWriterRoutes(app: OpenAPIHono, deps: ApiDependencies): void {
  app.openapi(route, async (context) => {
    context.header("Cache-Control", "public, max-age=30");
    const query = context.req.valid("query");
    const now = await apiNow(deps);
    const nowMs = now.getTime();
    const status = programStatus(nowMs);
    let weekNumber: number | null = null;
    if (query.week !== undefined) {
      weekNumber = Number(query.week);
      if (!weekBounds(weekNumber)) {
        return context.json({ error: "NOT_FOUND", message: status === "awaiting_token" ? statusMessage(status) : `There is no reward week ${weekNumber}.` }, 404);
      }
    } else if (status === "active" || status === "ended") {
      weekNumber = currentWeek(nowMs);
    }
    const preview = weekNumber === null;
    const cacheKey = `writers:week:${preview ? "preview" : weekNumber}`;
    const nowSec = Math.floor(nowMs / 60_000) * 60; // the preview window moves once a minute so the cache stays useful
    const pool = deps.deployment.contracts.pool;
    const built = status === "off" || !pool ? null : await deps.cache.getOrLoad(cacheKey, TTL_MS, async () => {
      const table = await buildWeek({ sql: deps.sql, pool, contracts: deps.deployment.contracts as Record<string, string>, week: preview ? "preview" : weekNumber!, nowSec });
      const through = await indexedThroughSec(deps.sql);
      return table ? { table, final: !preview && through !== null && through >= table.endSec } : null;
    });

    let you: z.infer<typeof walletSchema> | null = null;
    if (query.address && built) {
      const address = query.address.toLowerCase();
      const row = built.table.rows.find((entry) => entry.address === address);
      const excludedReason = excludedWallets(deps.deployment.contracts as Record<string, string>).get(address);
      you = {
        address,
        excluded: !!excludedReason,
        eligible: row?.eligible ?? false,
        reason: row?.reason ?? (excludedReason ? `excluded: ${excludedReason}` : "no deposit held during the week"),
        depositHeldUsdg: microText(row?.basisEndMicro ?? 0n),
        timeWeightedUsdg: microText(row?.avgMicro ?? 0n),
        pointsUsdgDays: usdgDays(row?.weightMicroSec ?? 0n),
        tokens: unitsText(row?.units ?? 0n, writerRewards.tokenDecimals),
        capped: row?.capped ?? false,
      };
    }
    const notes = [
      "Contract wallets are removed when the weekly payout list is made, so amounts here are estimates until the week is final and paid.",
      ...(preview ? ["Illustrative: the last 7 days, with the weekly amount, to show how points work before the program starts. Nothing is paid for it."] : []),
      ...(!preview && built && !built.final ? ["Projected: this week is still running. The figures assume every wallet stays in until the week ends; a withdrawal request or a new deposit changes them."] : []),
    ];
    return context.json({
      program: {
        status,
        message: statusMessage(status),
        tokenSymbol: writerRewards.tokenSymbol,
        tokenAddress: writerRewards.tokenAddress || null,
        weeklyPoolTokens: unitsText(weeklyPoolUnits(), writerRewards.tokenDecimals),
        weeklyPoolPctOfSupply: writerRewards.weeklyPoolBpsOfSupply / 100,
        tokenTotalSupply: writerRewards.tokenTotalSupply,
        weeks: writerRewards.weeks,
        startAt: writerRewards.startAt || null,
        perWalletCapPct: writerRewards.perWalletCapBps / 100,
        minTimeWeightedUsdg: writerRewards.minTimeWeightedUsdg,
        overCapPaidToOthers: writerRewards.redistributeOverCap,
        rules: WRITER_RULES(),
      },
      week: built ? weekView(built.table, weekNumber, built.final) : null,
      you,
      notes,
    }, 200);
  });
}
