import type { Address } from "viem";
import { Erc20Abi } from "../../abi";
import type { KeeperContext } from "../context";

/** $LMNS holder perks: reads the $LMNS balance of every wallet that asked for its holder level within the last day (the
 * API's holder_watch rows), stalest first, and stores it in holder_balances for the API (which never reads the chain).
 * Idle until LMNS_TOKEN_ADDRESS is set on token day. Read-only: it never sends a transaction. */
export const WATCH_WINDOW_HOURS = 24;
const CONCURRENCY = 8;

export type BalanceReader = (token: Address, wallet: Address, blockNumber: bigint) => Promise<bigint>;

export function createHoldersJob(context: KeeperContext, readBalance?: BalanceReader) {
  const read: BalanceReader = readBalance ?? (async (token, wallet, blockNumber) => await context.clients.stateClient.readContract({
    address: token, abi: Erc20Abi, functionName: "balanceOf", args: [wallet], blockNumber,
  }) as bigint);
  return async (): Promise<Record<string, unknown>> => {
    const token = context.config.LMNS_TOKEN_ADDRESS.toLowerCase();
    if (!token) return { idle: true, reason: "LMNS_TOKEN_ADDRESS is not set (token day)" };
    const ttl = context.config.HOLDER_BALANCE_TTL_SECONDS;
    const due = await context.sql<{ address: string }[]>`
      select w.address from holder_watch w
      left join holder_balances b on b.address = w.address
      where w.requested_at > now() - make_interval(hours => ${WATCH_WINDOW_HOURS})
        and (b.address is null or b.token <> ${token} or b.updated_at < now() - make_interval(secs => ${ttl}))
      order by b.updated_at asc nulls first
      limit ${context.config.HOLDER_SYNC_MAX_WALLETS}`;
    if (due.length === 0) return { idle: true, reason: "no wallet due" };
    const blockNumber = await context.clients.stateClient.getBlockNumber();
    let updated = 0;
    let failed = 0;
    for (let i = 0; i < due.length; i += CONCURRENCY) {
      const batch = due.slice(i, i + CONCURRENCY);
      const results = await Promise.allSettled(batch.map((row) => read(token as Address, row.address as Address, blockNumber)));
      for (const [index, result] of results.entries()) {
        if (result.status === "rejected") { failed++; continue; }
        await context.sql`
          insert into holder_balances (address, token, balance, block_number, updated_at)
          values (${batch[index]!.address}, ${token}, ${result.value.toString()}, ${blockNumber.toString()}, now())
          on conflict (address) do update set token = excluded.token, balance = excluded.balance,
            block_number = excluded.block_number, updated_at = excluded.updated_at`;
        updated++;
      }
    }
    await context.sql`delete from holder_watch where requested_at < now() - make_interval(hours => ${WATCH_WINDOW_HOURS * 7})`;
    if (failed > 0 && updated === 0) throw new Error(`holders: every balance read failed (${failed})`);
    return { idle: false, updated, failed, blockNumber: blockNumber.toString() };
  };
}
