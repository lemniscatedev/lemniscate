import { keccak256, parseAbi, toFunctionSelector, type Address, type Hex } from "viem";
import type { KeeperContext } from "../context";
import { saveJobMeta } from "../context";

/** The OpenZeppelin TimelockController events the watcher reads (v5). */
export const TimelockEventsAbi = parseAbi([
  "event CallScheduled(bytes32 indexed id, uint256 indexed index, address target, uint256 value, bytes data, bytes32 predecessor, uint256 delay)",
  "event CallExecuted(bytes32 indexed id, uint256 indexed index, address target, uint256 value, bytes data)",
  "event Cancelled(bytes32 indexed id)",
  "event MinDelayChange(uint256 oldDuration, uint256 newDuration)",
]);

/** Blocks per eth_getLogs call (the indexer starts at the same size) and calls per pass, so a first run after a long
 * stop catches up in a few passes without a single huge request. */
export const ADMIN_WATCH_RANGE = 50_000n;
export const ADMIN_WATCH_MAX_RANGES_PER_PASS = 10;
/** While code stays at the owner address, the alert repeats at most this often (one alert per cause, then hourly). */
export const OWNER_CODE_REMINDER_MS = 3_600_000;

/** A few well-known admin selectors, so an alert can say what a scheduled call does in words. Anything else is shown
 * as its 4-byte selector. */
const KNOWN_SELECTORS: Record<string, string> = Object.fromEntries(
  [
    "upgradeToAndCall(address,bytes)", "grantRole(bytes32,address)", "revokeRole(bytes32,address)", "renounceRole(bytes32,address)",
    "updateDelay(uint256)", "setSigner(address)", "setRecipient(bytes32,address)", "setProtocolFeeBps(uint16)", "freezeUpgrades()",
    "setBuysPaused(bool)", "setDepositsPaused(bool)", "setTwapSource(address,address,uint32,uint16)", "setHedgeDepthCap(address,uint256)",
    "setAgentRouter(address)", "setFeeTiers(address)", "setMarketHours(address)",
  ].map((signature) => [toFunctionSelector(signature), signature.split("(")[0]!]),
);

export interface AdminWatchState {
  /** Next block to read; undefined until the first pass loads it (saved cursor, else the deploy block). */
  cursor?: bigint;
  /** Dedupe keys of event alerts already sent (bounded). A pass that fails before saving its cursor re-reads the same
   * range; these keys keep the retry from alerting twice. */
  sent: Set<string>;
  /** Owner code alert: the hash of the code last alerted and when. */
  ownerCode?: { hash: Hex; alertedAtMs: number } | undefined;
}

/** M1 (skeptic review of the EOA owner model): watches the 48h TimelockController and the owner address, so the "48 hours
 * to react" in SECURITY.md is backed by a real watcher. Alerts (logger.error with `alert: true` and a `dedupeKey`, read by
 * the ops-chat runner when it exists) on every CallScheduled, CallExecuted, Cancelled and MinDelayChange of the timelock,
 * and whenever the owner address has code (an EIP-7702 delegation or anything else). Read-only: it never sends a
 * transaction and never pauses anything; the guardian decides. */
export function createAdminWatchJob(context: KeeperContext, state: AdminWatchState = { sent: new Set() }) {
  const timelock = nonZero(context.deployment.contracts.timelock);
  const owner = nonZero(context.deployment.safe);
  const names = contractNames(context);
  return async (): Promise<Record<string, unknown>> => {
    if (!timelock && !owner) return { idle: true, reason: "no timelock or owner in the deployment" };
    const result: Record<string, unknown> = { idle: false };
    if (owner) result.ownerCode = await checkOwnerCode(context, state, owner);
    if (!timelock) return result;

    let cursor: bigint = state.cursor ?? await loadCursor(context);
    state.cursor = cursor;
    const head = await context.clients.logsClient.getBlockNumber();
    let events = 0;
    let ranges = 0;
    while (cursor <= head && ranges < ADMIN_WATCH_MAX_RANGES_PER_PASS) {
      const fromBlock: bigint = cursor;
      const toBlock: bigint = fromBlock + ADMIN_WATCH_RANGE - 1n < head ? fromBlock + ADMIN_WATCH_RANGE - 1n : head;
      const logs = await context.clients.logsClient.getLogs({ address: timelock, events: TimelockEventsAbi, fromBlock, toBlock, strict: true });
      for (const log of logs) if (alertEvent(context, state, names, log as unknown as TimelockLog)) events++;
      cursor = toBlock + 1n;
      state.cursor = cursor;
      ranges++;
      await saveJobMeta(context, "admin-watch", { cursor: cursor.toString() });
    }
    if (state.sent.size > 10_000) state.sent.clear(); // the cursor is the real dedupe; this only covers a retried range
    return { ...result, timelock, events, cursor: cursor.toString(), behind: cursor <= head };
  };
}

interface TimelockLog {
  eventName: "CallScheduled" | "CallExecuted" | "Cancelled" | "MinDelayChange";
  args: { id?: Hex; index?: bigint; target?: Address; value?: bigint; data?: Hex; delay?: bigint; oldDuration?: bigint; newDuration?: bigint };
  blockNumber: bigint | null;
  transactionHash: Hex | null;
  logIndex: number | null;
}

function alertEvent(context: KeeperContext, state: AdminWatchState, names: Map<string, string>, log: TimelockLog): boolean {
  const { args } = log;
  const dedupeKey = `timelock:${log.eventName}:${args.id ?? ""}:${args.index ?? ""}:${log.transactionHash ?? ""}:${log.logIndex ?? ""}`;
  if (state.sent.has(dedupeKey)) return false;
  state.sent.add(dedupeKey);
  const where = { block: log.blockNumber?.toString(), tx: log.transactionHash, operation: args.id };
  const what = args.target ? describeCall(names, args.target, args.data, args.value) : "";
  if (log.eventName === "CallScheduled") {
    const hours = Number(args.delay ?? 0n) / 3600;
    context.logger.error({ alert: true, dedupeKey, ...where, delayHours: hours },
      `ALERT: an admin action was scheduled on the timelock: ${what}. It can run ${hours} hours after block ${log.blockNumber ?? "?"}. ` +
      "If the owner did not schedule it, treat the owner key as compromised: the guardian pauses buys and deposits, " +
      "users are told to exit, and the owner cancels it while it still can (INCIDENT.md).");
  } else if (log.eventName === "CallExecuted") {
    context.logger.error({ alert: true, dedupeKey, ...where },
      `ALERT: a timelocked admin action was executed: ${what}. Check it matches the action announced 48 hours ago.`);
  } else if (log.eventName === "Cancelled") {
    context.logger.error({ alert: true, dedupeKey, ...where },
      "ALERT: a scheduled admin action was cancelled on the timelock. Expected only when the owner withdraws its own action.");
  } else {
    context.logger.error({ alert: true, dedupeKey, ...where, oldSeconds: args.oldDuration?.toString(), newSeconds: args.newDuration?.toString() },
      `ALERT: the timelock delay changed from ${Number(args.oldDuration ?? 0n) / 3600} to ${Number(args.newDuration ?? 0n) / 3600} hours.`);
  }
  return true;
}

function describeCall(names: Map<string, string>, target: Address, data: Hex | undefined, value: bigint | undefined): string {
  const contract = names.get(target.toLowerCase()) ?? target;
  const selector = data && data.length >= 10 ? data.slice(0, 10).toLowerCase() : "";
  const call = KNOWN_SELECTORS[selector] ?? (selector ? `function ${selector}` : "a plain transfer");
  return `${call} on ${contract}${value ? ` sending ${value} wei` : ""}`;
}

async function checkOwnerCode(context: KeeperContext, state: AdminWatchState, owner: Address): Promise<string> {
  const code = (await context.clients.stateClient.getCode({ address: owner })) ?? "0x";
  if (code === "0x") {
    if (state.ownerCode) {
      context.logger.warn({ alert: true, dedupeKey: `owner-code:${owner.toLowerCase()}:cleared` },
        "RESOLVED: the owner address has no code again.");
      state.ownerCode = undefined;
    }
    return "none";
  }
  const delegated = code.length === 2 + 23 * 2 && code.toLowerCase().startsWith("0xef0100");
  const hash = keccak256(code);
  const nowMs = Date.now();
  const same = state.ownerCode?.hash === hash;
  if (!same || nowMs - state.ownerCode!.alertedAtMs >= OWNER_CODE_REMINDER_MS) {
    const dedupeKey = `owner-code:${owner.toLowerCase()}:${hash}`;
    const what = delegated
      ? `an EIP-7702 delegation to ${`0x${code.slice(8)}`}`
      : `contract code (${(code.length - 2) / 2} bytes)`;
    context.logger.error({ alert: true, dedupeKey, owner, codeHash: hash, delegated, reminder: same },
      `ALERT: the protocol owner address ${owner} now has ${what}. The owner must be a plain key with no code: ` +
      "whoever controls that code can act as the owner through the timelock. Treat the owner key as compromised (INCIDENT.md).");
    state.ownerCode = { hash, alertedAtMs: nowMs };
  }
  return delegated ? "delegated" : "code";
}

async function loadCursor(context: KeeperContext): Promise<bigint> {
  const rows = await context.sql<{ meta: { cursor?: string } | null }[]>`select meta from keeper_status where job = 'admin-watch'`;
  const saved = rows?.[0]?.meta?.cursor;
  if (saved && /^\d+$/.test(saved)) return BigInt(saved);
  return BigInt(context.deployment.deployBlock);
}

function contractNames(context: KeeperContext): Map<string, string> {
  const names = new Map<string, string>();
  for (const [name, address] of Object.entries(context.deployment.contracts)) {
    if (typeof address === "string") names.set(address.toLowerCase(), name);
  }
  return names;
}

function nonZero(address: string | undefined): Address | undefined {
  return address && !/^0x0{40}$/i.test(address) ? (address as Address) : undefined;
}
