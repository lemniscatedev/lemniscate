import { encodeFunctionData, parseAbi, type Address, type Hex } from "viem";
import { safeErrorSummary } from "../../log";
import type { KeeperContext } from "../context";

/** LemniscatePaymaster's permissionless registration (review R17, decision 62) and its known-account read. */
export const KERNEL_REGISTER_ABI = parseAbi([
  "function registerKernelAccount(address account, bytes initData, bytes32 salt)",
  "function kernelAccount(address account) view returns (bool)",
]);

/** Accounts per run (each is one transaction). */
const MAX_PER_RUN = 20;
/** Back-off after a failed registration: 10 minutes, doubling, at most a day. */
const BACKOFF_SECONDS = 600;
const MAX_BACKOFF_SECONDS = 86_400;
const HELD_QUEUE = /nonce .* (is held|is unresolved|remains held)|local signer is not configured|existing pending transaction/i;

/** R17 (decision 62): a standard Kernel account that someone deployed through the public factory is unknown to the paymaster,
 * so the API would never sponsor it. The API queues such accounts (kernel_registrations, after checking that the address is the
 * standard setup of the stored owner); this job sends LemniscatePaymaster.registerKernelAccount for each (the contract checks
 * the init data and the CREATE2 address again), marks it done, and backs off one that reverts. The API holds no funded key. */
export function createKernelRegisterJob(context: KeeperContext) {
  return async (): Promise<Record<string, unknown>> => {
    const paymaster = (context.config as { PAYMASTER_ADDRESS?: string }).PAYMASTER_ADDRESS as Address | undefined;
    if (!paymaster) return { idle: true, reason: "PAYMASTER_ADDRESS is not set" };
    const rows = await context.sql<{ account: string; init_data: string; salt: string; attempts: number }[]>`
      select account, init_data, salt, attempts from kernel_registrations
      where done_at is null and next_attempt_at <= now() order by requested_at limit ${MAX_PER_RUN}`;
    if (!rows.length) return { idle: true, registered: 0, alreadyKnown: 0, failed: 0 };
    const known = await context.clients.stateClient.multicall({
      allowFailure: true,
      contracts: rows.map((row) => ({ address: paymaster, abi: KERNEL_REGISTER_ABI, functionName: "kernelAccount", args: [row.account as Address] })) as never,
    }) as { status: "success" | "failure"; result?: unknown }[];
    let registered = 0;
    let alreadyKnown = 0;
    let failed = 0;
    let simulated = false;
    for (const [index, row] of rows.entries()) {
      if (known[index]?.status === "success" && known[index]!.result === true) {
        await context.sql`update kernel_registrations set done_at = now() where account = ${row.account}`;
        alreadyKnown++;
        continue;
      }
      try {
        const result = await context.tx.submit({
          label: "kernel-register", to: paymaster,
          data: encodeFunctionData({ abi: KERNEL_REGISTER_ABI, functionName: "registerKernelAccount",
            args: [row.account as Address, row.init_data as Hex, row.salt as Hex] }),
        });
        simulated ||= result.simulated;
        if (result.simulated) continue;
        await context.sql`update kernel_registrations set done_at = now(), tx_hash = ${result.hash ?? null}, last_error = null
          where account = ${row.account}`;
        registered++;
      } catch (error) {
        const summary = safeErrorSummary(error);
        if (HELD_QUEUE.test(summary.message)) throw error;
        const delay = Math.min(MAX_BACKOFF_SECONDS, BACKOFF_SECONDS * 2 ** Math.min(row.attempts, 10));
        await context.sql`update kernel_registrations set attempts = attempts + 1, last_error = ${summary.message.slice(0, 300)},
          next_attempt_at = now() + ${delay} * interval '1 second' where account = ${row.account}`;
        failed++;
        context.logger.warn({ account: row.account, err: summary }, "registerKernelAccount failed; backing off this account");
      }
    }
    return { registered, alreadyKnown, failed, dryRun: simulated };
  };
}
