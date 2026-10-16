import type { ChainEvent, IndexerContext } from "../types";
import { asAddress, asBigInt, units, ZERO_ADDRESS, OPTION_TOKEN_DECIMALS } from "../units";
import { accountSeen, iso } from "./common";

/** Records an option-token or pool-share Transfer (mints and burns included). Balances are recomputed from the
 * transfers table at the end of the batch, so a replay or a rollback can never double count. */
export async function handleTransferEvent(context: IndexerContext, event: ChainEvent): Promise<void> {
  if (event.eventName !== "Transfer") return;
  if (event.source !== "token" && event.source !== "pool") return;
  const token = event.address;
  const from = asAddress(event.args.from);
  const to = asAddress(event.args.to);
  const decimals = event.source === "pool" ? context.deployment.poolShareDecimals : OPTION_TOKEN_DECIMALS;
  const seriesId = event.source === "token" ? (context.seriesByToken.get(token)?.id ?? null) : null;
  await context.tx`
    INSERT INTO transfers (tx_hash, log_index, block, ts, series_id, token, from_addr, to_addr, amount)
    VALUES (
      ${event.txHash}, ${event.logIndex}, ${event.blockNumber.toString()}, ${iso(event.ts)}, ${seriesId},
      ${token}, ${from}, ${to}, ${units(asBigInt(event.args.value), decimals)}
    )
    ON CONFLICT (tx_hash, log_index) DO NOTHING
  `;
  await accountSeen(context.tx, event, [from, to]);
  for (const account of [from, to]) {
    if (account !== ZERO_ADDRESS) context.touchedBalances.set(`${token}:${account}`, { token, account });
  }
  if (event.source === "pool") context.snapshotNeeded = true;
  context.kinds.add("transfer");
}

/** balances(token, account) = sum of transfers in - sum of transfers out, for every touched pair. */
export async function applyBalances(context: Pick<IndexerContext, "tx" | "touchedBalances">): Promise<void> {
  const pairs = [...context.touchedBalances.values()];
  if (pairs.length === 0) return;
  await recomputeBalances(context.tx, pairs);
  context.touchedBalances.clear();
}

export async function recomputeBalances(
  tx: IndexerContext["tx"],
  pairs: readonly { token: string; account: string }[],
): Promise<void> {
  // Mints and burns have the zero address on one side; it never holds a balance.
  const real = pairs.filter((pair) => pair.account !== ZERO_ADDRESS);
  if (real.length === 0) return;
  const tokens = real.map((pair) => pair.token);
  const accounts = real.map((pair) => pair.account);
  await tx`
    INSERT INTO balances (token, account, balance, updated_block, updated_at)
    SELECT p.token, p.account,
      COALESCE((SELECT SUM(amount) FROM transfers t WHERE t.token = p.token AND t.to_addr = p.account), 0)
        - COALESCE((SELECT SUM(amount) FROM transfers t WHERE t.token = p.token AND t.from_addr = p.account), 0),
      COALESCE((SELECT MAX(block) FROM transfers t WHERE t.token = p.token AND (t.to_addr = p.account OR t.from_addr = p.account)), 0),
      NOW()
    FROM unnest(${tokens}::text[], ${accounts}::text[]) AS p(token, account)
    ON CONFLICT (token, account) DO UPDATE SET
      balance = EXCLUDED.balance,
      updated_block = EXCLUDED.updated_block,
      updated_at = NOW()
  `;
}
