import type { Address } from "viem";
import type { Sql } from "postgres";
import type { AaChain } from "../aa/chain";
import { RpcBudgetError } from "../aa/chain";
import { predictKernelAddressOffline } from "../aa/counterfactual";
import { kernelInitData } from "../aa/kernel";
import { kernelSalt } from "../aa/userop";
import type { RuntimeConfig } from "../config";
import { invitesRequired, isApproved } from "../db/queries/invites";
import { getSeries } from "../db/queries/series";
import type { ApiDependencies } from "./types";

/**
 * F25/F31: the policy that decides whether the API signs paymaster data for a one-tap operation.
 *
 * An operation is sponsored only when all of this holds:
 *  1. Identity. For a deployed account the owner is read from the Kernel validator on chain (the body's `owner` is never
 *     trusted); for a new account the builder proves `owner` against the predicted address. When invites are required, the
 *     owner or the account must have redeemed a code (entry flows only).
 *  2. A real trade. Buy/shield: at least SPONSOR_MIN_NOTIONAL_USDG and the account holds the USDG it will spend. Sell: the
 *     account holds the option tokens it sells and the proceeds are at least SPONSOR_MIN_SELL_USDG.
 *  3. Quotas, per UTC day, booked in the database before signing: per account, per owner, per IPv4/IPv6 /64 and globally,
 *     with exits in their own group so entries can never use up the budget that lets holders sell.
 *     R11: a booking is a RESERVATION, not a spend. It lives as long as the paymaster signature can still be used (the
 *     validity window plus a minute) and becomes a spend when the signed operation is relayed through /v1/userop/send. The
 *     per-account, per-owner and per-network limits count spends and live reservations (so a flood costs the flooder his
 *     own limits); the GLOBAL limit counts spends only, so nobody can use up the day's budget by asking for signatures
 *     he never submits. What stays bounded by the chain is the money: the paymaster's own daily caps.
 * Any failure to read what the policy needs denies sponsorship (fail closed). A denial is not an error for the user: the
 * route then returns the same operation unsponsored (they pay gas), and the plain transaction is always available.
 */
export type SponsorshipKind = "buy" | "sell" | "shield";
export type DenialReason =
  | "INVITE_REQUIRED" | "BELOW_MINIMUM" | "NO_POSITION" | "INSUFFICIENT_BALANCE" | "OWNER_UNVERIFIED"
  | "QUOTA_ACCOUNT" | "QUOTA_OWNER" | "QUOTA_NETWORK" | "QUOTA_GLOBAL" | "UNAVAILABLE"
  | "ACCOUNT_UNREGISTERED" | "ACCOUNT_UNSUPPORTED" | "ACCOUNT_REGISTERING";

export interface SponsorshipInput {
  readonly kind: SponsorshipKind;
  readonly account: Address;
  /** The owner named in the request (trusted only for an account that is not deployed yet, where the builder proves it). */
  readonly owner: Address | undefined;
  /** Rate-limit key of the caller: an IPv4 address or an IPv6 /64. */
  readonly ipKey: string;
  /** The plain intent the route built: maxCostUsdg / tokens / series / quote. */
  readonly plain: Record<string, unknown>;
  /** How long the signature stays usable, seconds (the paymaster validity); the reservation lasts a minute longer. */
  readonly validitySeconds?: number;
  /** The Kernel account index the request names (the CREATE2 salt), default 0 (R17 registration check). */
  readonly accountIndex?: number | undefined;
}

export type SponsorshipDecision =
  | { readonly granted: true; readonly ticket: number }
  | { readonly granted: false; readonly reason: DenialReason; readonly message: string };

export interface SponsorshipGate {
  evaluate(input: SponsorshipInput): Promise<SponsorshipDecision>;
  /** Gives the quota back when the operation could not be built after all. */
  release(ticket: number): Promise<void>;
  /** Ties the reservation to the operation it was signed for, so that relaying that operation can turn it into a spend. */
  attach(ticket: number, userOpHash: string): Promise<void>;
  /** The operation with this hash was relayed: its reservation becomes a spend (global budget). Returns the rows changed. */
  markSubmitted(userOpHash: string): Promise<number>;
}

const MESSAGES: Record<DenialReason, string> = {
  INVITE_REQUIRED: "Gas is sponsored for invited accounts only. The operation is returned unsponsored.",
  BELOW_MINIMUM: "This trade is below the minimum size that gets sponsored gas. The operation is returned unsponsored.",
  NO_POSITION: "The account does not hold what this sell needs, so gas is not sponsored.",
  INSUFFICIENT_BALANCE: "The account does not hold the USDG this trade spends, so gas is not sponsored.",
  OWNER_UNVERIFIED: "The account owner could not be verified, so gas is not sponsored.",
  QUOTA_ACCOUNT: "This account used its sponsored operations for today. The operation is returned unsponsored.",
  QUOTA_OWNER: "This owner used its sponsored operations for today. The operation is returned unsponsored.",
  QUOTA_NETWORK: "This network used its sponsored operations for today. The operation is returned unsponsored.",
  QUOTA_GLOBAL: "Today's sponsored operations are used up. The operation is returned unsponsored.",
  UNAVAILABLE: "Sponsorship could not be checked right now, so gas is not sponsored.",
  ACCOUNT_UNREGISTERED: "Gas is sponsored only for smart accounts the paymaster knows (created with sponsored gas or registered). The operation is returned unsponsored.",
  ACCOUNT_UNSUPPORTED: "This smart account runs an implementation the paymaster does not sponsor. The operation is returned unsponsored.",
  ACCOUNT_REGISTERING: "This smart account was created outside the app, so it is being registered with the paymaster now. Sponsored gas works in a few minutes; this operation is returned unsponsored.",
};

const deny = (reason: DenialReason): SponsorshipDecision => ({ granted: false, reason, message: MESSAGES[reason] });
const micro = (value: unknown): bigint | null => (typeof value === "string" && /^\d+$/.test(value) ? BigInt(value) : null);
const usdgToNumber = (value: bigint): number => Number(value) / 1_000_000;
/** Serialises quota check + booking across API instances. */
const QUOTA_LOCK = 7_203_015;
/** PAYMASTER_VALIDITY_SECONDS default, used when the caller does not say. */
const DEFAULT_VALIDITY_SECONDS = 300;

export interface SponsorshipLimits {
  readonly minNotionalUsdg: number;
  readonly minSellUsdg: number;
  readonly entry: { readonly account: number; readonly owner: number; readonly ip: number; readonly global: number };
  readonly exit: { readonly account: number; readonly owner: number; readonly ip: number; readonly global: number };
}

export function limitsFromConfig(config: Partial<RuntimeConfig>): SponsorshipLimits {
  const c = config as Record<string, number | undefined>;
  return {
    minNotionalUsdg: c.SPONSOR_MIN_NOTIONAL_USDG ?? 5,
    minSellUsdg: c.SPONSOR_MIN_SELL_USDG ?? 1,
    entry: { account: c.SPONSOR_ENTRY_PER_ACCOUNT_DAILY ?? 10, owner: c.SPONSOR_ENTRY_PER_OWNER_DAILY ?? 10, ip: c.SPONSOR_ENTRY_PER_IP_DAILY ?? 30, global: c.SPONSOR_ENTRY_GLOBAL_DAILY ?? 1500 },
    exit: { account: c.SPONSOR_EXIT_PER_ACCOUNT_DAILY ?? 20, owner: c.SPONSOR_EXIT_PER_OWNER_DAILY ?? 20, ip: c.SPONSOR_EXIT_PER_IP_DAILY ?? 60, global: c.SPONSOR_EXIT_GLOBAL_DAILY ?? 1000 },
  };
}

export interface SponsorshipGateOptions {
  readonly deps: Pick<ApiDependencies, "sql" | "config">;
  readonly chain: AaChain;
  readonly kernelValidator: Address;
  readonly usdg: Address;
  readonly limits?: SponsorshipLimits;
  /** F26 (decision 44): with the paymaster set, a deployed account must be one it knows (kernelAccount) and run
   * `kernelImplementation` in its ERC-1967 slot before anything is signed. A new account is deployed by the builder
   * through the Kernel factory in the same operation, which is what the paymaster accepts. */
  readonly paymaster?: Address | undefined;
  readonly kernelImplementation?: Address | undefined;
  /** R17 (decision 62): the Kernel factory the paymaster trusts. With it, a deployed standard account the paymaster does not
   * know (someone deployed it through the public factory) is queued for the keeper's registerKernelAccount call. */
  readonly kernelFactory?: Address | undefined;
}

export function createSponsorshipGate(options: SponsorshipGateOptions): SponsorshipGate {
  const { deps, chain } = options;
  const limits = options.limits ?? limitsFromConfig(deps.config);
  const sql = deps.sql as Sql;

  /** R17: queue a deployed, unknown account for LemniscatePaymaster.registerKernelAccount when it is the standard setup of its
   * stored owner (the address the factory gives the standard init data and salt). The contract checks it all again. */
  async function queueRegistration(account: Address, owner: Address, accountIndex = 0): Promise<boolean> {
    if (!options.kernelFactory || !options.kernelImplementation) return false;
    if (!Number.isInteger(accountIndex) || accountIndex < 0 || accountIndex > 0xffff_ffff) return false;
    const deployment = { factory: options.kernelFactory, validator: options.kernelValidator, implementation: options.kernelImplementation };
    if (predictKernelAddressOffline(deployment, owner, accountIndex).toLowerCase() !== account.toLowerCase()) return false;
    await sql`insert into kernel_registrations (account, owner, init_data, salt)
      values (${account.toLowerCase()}, ${owner.toLowerCase()}, ${kernelInitData(options.kernelValidator, owner)}, ${kernelSalt(accountIndex)})
      on conflict (account) do nothing`;
    return true;
  }

  return {
    async evaluate(input) {
      try {
        const group = input.kind === "sell" ? "exit" : "entry";
        const quota = limits[group];
        const account = input.account.toLowerCase();

        // 1. Identity: the owner that counts is the one the chain says owns a deployed account.
        let owner = input.owner?.toLowerCase();
        const deployed = await chain.isDeployed(input.account);
        if (deployed) {
          const stored = await chain.kernelOwner(options.kernelValidator, input.account);
          if (!stored) return deny("OWNER_UNVERIFIED");
          owner = stored.toLowerCase();
          if (options.paymaster) {
            const implementation = await chain.implementationOf(input.account);
            const expected = options.kernelImplementation?.toLowerCase();
            if (!implementation || (expected && implementation.toLowerCase() !== expected)) return deny("ACCOUNT_UNSUPPORTED");
            if (!await chain.paymasterKnowsAccount(options.paymaster, input.account)) {
              return deny(await queueRegistration(input.account, owner as Address, input.accountIndex) ? "ACCOUNT_REGISTERING" : "ACCOUNT_UNREGISTERED");
            }
          }
        }
        if (group === "entry" && await invitesRequired(deps)) {
          const approved = (owner && await isApproved(deps, owner)) || await isApproved(deps, account);
          if (!approved) return deny("INVITE_REQUIRED");
        }

        // 2. A real trade.
        let notional: bigint;
        if (group === "entry") {
          const maxCost = micro(input.plain.maxCostUsdg);
          if (maxCost === null) return deny("UNAVAILABLE");
          notional = maxCost;
          if (usdgToNumber(notional) < limits.minNotionalUsdg) return deny("BELOW_MINIMUM");
          if (await chain.tokenBalance(options.usdg, input.account) < maxCost) return deny("INSUFFICIENT_BALANCE");
        } else {
          const quoteUsdg = micro((input.plain.quote as { usdg?: unknown } | undefined)?.usdg);
          const tokens = micro(input.plain.tokens);
          const seriesId = typeof input.plain.series === "string" ? input.plain.series : "";
          if (quoteUsdg === null || tokens === null || !seriesId) return deny("UNAVAILABLE");
          notional = quoteUsdg;
          const series = await getSeries({ sql: deps.sql } as never, seriesId);
          if (!series) return deny("UNAVAILABLE");
          const rows = await sql`SELECT balance::text AS balance FROM balances WHERE token = ${series.token.toLowerCase()} AND account = ${account}` as unknown as { balance: string }[];
          const held = rows[0]?.balance ? wadFromDecimal(rows[0].balance) : 0n;
          if (held <= 0n || held < tokens) return deny("NO_POSITION");
          if (usdgToNumber(notional) < limits.minSellUsdg) return deny("BELOW_MINIMUM");
        }

        // 3. Quotas, booked atomically so concurrent requests cannot both take the last slot.
        return await sql.begin(async (tx) => {
          await tx`select pg_advisory_xact_lock(${QUOTA_LOCK})`;
          // R11: spends (submitted) and live reservations count against an actor; only spends count against the global budget.
          const rows = await tx`
            select count(*) filter (where account = ${account})::int as per_account,
                   count(*) filter (where owner = ${owner ?? null})::int as per_owner,
                   count(*) filter (where ip_key = ${input.ipKey})::int as per_ip,
                   count(*) filter (where submitted_at is not null)::int as total
            from sponsorship_grants
            where day = ((now() at time zone 'utc')::date) and grp = ${group} and (submitted_at is not null or expires_at > now())` as unknown as
            { per_account: number; per_owner: number; per_ip: number; total: number }[];
          const used = rows[0]!;
          if (used.total >= quota.global) return deny("QUOTA_GLOBAL");
          if (used.per_ip >= quota.ip) return deny("QUOTA_NETWORK");
          if (used.per_account >= quota.account) return deny("QUOTA_ACCOUNT");
          if (owner && used.per_owner >= quota.owner) return deny("QUOTA_OWNER");
          const ttl = Math.max(60, Math.floor(input.validitySeconds ?? DEFAULT_VALIDITY_SECONDS)) + 60;
          const inserted = await tx`
            insert into sponsorship_grants (grp, kind, account, owner, ip_key, notional_usdg, expires_at)
            values (${group}, ${input.kind}, ${account}, ${owner ?? null}, ${input.ipKey}, ${usdgToNumber(notional)}, now() + ${ttl} * interval '1 second')
            returning id` as unknown as { id: string | number }[];
          return { granted: true as const, ticket: Number(inserted[0]!.id) };
        });
      } catch (error) {
        // A node that is out of budget or down, or a database that cannot be read: nothing is signed.
        if (error instanceof RpcBudgetError) return deny("UNAVAILABLE");
        return deny("UNAVAILABLE");
      }
    },
    async release(ticket) {
      try { await sql`delete from sponsorship_grants where id = ${ticket} and submitted_at is null`; } catch { /* the reservation expires on its own */ }
    },
    async attach(ticket, userOpHash) {
      try { await sql`update sponsorship_grants set user_op_hash = ${userOpHash.toLowerCase()} where id = ${ticket}`; } catch { /* the reservation expires on its own */ }
    },
    async markSubmitted(userOpHash) {
      try {
        const rows = await sql`update sponsorship_grants set submitted_at = now()
          where user_op_hash = ${userOpHash.toLowerCase()} and submitted_at is null returning id`;
        return rows.length;
      } catch { return 0; }
    },
  };
}

/** "12.5" (18 dp, as the balances table stores option tokens) to a raw 18-decimal integer. */
function wadFromDecimal(text: string): bigint {
  const [whole = "0", fraction = ""] = text.split(".");
  return BigInt(whole || "0") * 10n ** 18n + BigInt((fraction + "0".repeat(18)).slice(0, 18) || "0");
}
