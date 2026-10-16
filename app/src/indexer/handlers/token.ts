import type { ChainEvent, IndexerContext } from "../types";
import { asAddress, asBigInt, writerPool, power, ZERO_ADDRESS } from "../units";
import { accountSeen } from "./common";

export interface TokenTransferDelta {
  readonly event: ChainEvent;
  readonly token: string;
  readonly from: string;
  readonly to: string;
  readonly amount: bigint;
  readonly decimals: number;
  readonly marketId: number | null;
  readonly eligible: boolean;
}

function touch(context: IndexerContext, ...addresses: string[]): void {
  for (const address of addresses) {
    if (address !== ZERO_ADDRESS) context.touchedAccounts.add(address);
  }
}

export async function handleTokenEvent(
  context: IndexerContext,
  event: ChainEvent,
): Promise<TokenTransferDelta | undefined> {
  if (event.eventName !== "Transfer" || (event.source !== "token" && event.source !== "vault")) {
    return undefined;
  }

  const token = event.address;
  const from = asAddress(event.args.from);
  const to = asAddress(event.args.to);
  const amount = asBigInt(event.args.value);
  const isWriterPool = event.source === "vault";
  const isMintOrBurn = from === ZERO_ADDRESS || to === ZERO_ADDRESS;
  const marketId = isWriterPool ? null : (context.tokenToMarket.get(token) ?? null);
  const decimals = isWriterPool ? 12 : 18;
  let eligible = false;

  if (!isMintOrBurn) {
    const inserted = await context.tx`
      INSERT INTO transfers (tx_hash, log_index, block, ts, market_id, token, from_addr, to_addr, amount)
      VALUES (
        ${event.txHash}, ${event.logIndex}, ${event.blockNumber.toString()}, ${event.ts.toISOString()}, ${marketId},
        ${token}, ${from}, ${to}, ${isWriterPool ? writerPool(amount) : power(amount)}
      )
      ON CONFLICT (tx_hash, log_index) DO NOTHING
      RETURNING tx_hash
    `;
    eligible = inserted.length > 0;

  } else if (!isWriterPool) {
    eligible = context.insertedTradeTxs.has(event.txHash);
  } else {
    eligible = context.insertedVaultActionTxs.has(event.txHash);
  }

  await accountSeen(context.tx, event, [from, to]);
  // Only vault-share holders need per-account vault state (depositor flag,
  // unlock time) read at snapshot time; power-token balances come from events.
  // Tracking every power-token recipient let dust transfers inflate snapshots.
  if (isWriterPool) touch(context, from, to);
  context.hasLemniscateEvents = true;
  if (isWriterPool) context.snapshotNeeded = true;
  context.kinds.add("transfer");
  const market = marketId === null ? undefined : marketId;
  if (market !== undefined) context.marketIds.add(market);

  return { event, token, from, to, amount, decimals, marketId, eligible };
}

export async function applyBalanceDeltas(
  context: IndexerContext,
  transfers: readonly TokenTransferDelta[],
): Promise<void> {
  const balances = new Map<string, { token: string; account: string; amount: bigint; decimals: number; block: bigint }>();
  for (const transfer of transfers) {
    if (!transfer.eligible) continue;
    const delta = (account: string, amount: bigint) => {
      if (account === ZERO_ADDRESS || amount === 0n) return;
      const key = `${transfer.token}:${account}`;
      const existing = balances.get(key);
      if (existing) {
        existing.amount += amount;
        if (transfer.event.blockNumber > existing.block) existing.block = transfer.event.blockNumber;
      } else {
        balances.set(key, {
          token: transfer.token,
          account,
          amount,
          decimals: transfer.decimals,
          block: transfer.event.blockNumber,
        });
      }
    };
    delta(transfer.from, -transfer.amount);
    delta(transfer.to, transfer.amount);
  }

  for (const balance of balances.values()) {
    await context.tx`
      INSERT INTO balances (token, account, balance, updated_block, updated_at)
      VALUES (
        ${balance.token}, ${balance.account}, ${balance.decimals === 12 ? writerPool(balance.amount) : power(balance.amount)},
        ${balance.block.toString()}, NOW()
      )
      ON CONFLICT (token, account) DO UPDATE SET
        balance = balances.balance + EXCLUDED.balance,
        updated_block = GREATEST(balances.updated_block, EXCLUDED.updated_block),
        updated_at = NOW()
    `;
  }
}
