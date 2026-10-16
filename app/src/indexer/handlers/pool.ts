import type { ChainEvent, IndexerContext } from "../types";
import { asBigInt, unixToDate, units, usdg } from "../units";
import { accountSeen, addr, iso } from "./common";

export async function handlePoolEvent(context: IndexerContext, event: ChainEvent): Promise<void> {
  const shareDecimals = context.deployment.poolShareDecimals;
  switch (event.eventName) {
    case "HedgeEquityPosted":
      await context.tx`
        INSERT INTO hedge_equity_posts (tx_hash, log_index, block, ts, equity_usdg, as_of, ref)
        VALUES (
          ${event.txHash}, ${event.logIndex}, ${event.blockNumber.toString()}, ${iso(event.ts)},
          ${usdg(event.args.equityUsdg)}, ${iso(unixToDate(event.args.asOf))}, ${String(event.args.ref).toLowerCase()}
        )
        ON CONFLICT (tx_hash, log_index) DO NOTHING
      `;
      context.snapshotNeeded = true;
      context.kinds.add("hedge");
      return;
    case "WithdrawalQueued": {
      const owner = addr(event, "owner");
      await context.tx`
        INSERT INTO withdrawals (owner, ticket, shares, claimable_at, queued_at, queued_block, queued_tx, queued_log)
        VALUES (
          ${owner}, ${asBigInt(event.args.ticket).toString()}, ${units(event.args.shares, shareDecimals)},
          ${iso(unixToDate(event.args.claimableAt))}, ${iso(event.ts)}, ${event.blockNumber.toString()}, ${event.txHash}, ${event.logIndex}
        )
        ON CONFLICT (owner, ticket) DO NOTHING
      `;
      await accountSeen(context.tx, event, [owner]);
      context.snapshotNeeded = true;
      context.kinds.add("pool");
      return;
    }
    case "WithdrawalClaimed": {
      const owner = addr(event, "owner");
      await context.tx`
        UPDATE withdrawals SET
          status = 'claimed', claimed_at = ${iso(event.ts)}, claimed_block = ${event.blockNumber.toString()},
          claimed_tx = ${event.txHash}, claimed_log = ${event.logIndex}, usdg = ${usdg(event.args.usdg)}
        WHERE owner = ${owner} AND ticket = ${asBigInt(event.args.ticket).toString()} AND status = 'queued'
      `;
      await accountSeen(context.tx, event, [owner]);
      context.snapshotNeeded = true;
      context.kinds.add("pool");
      return;
    }
    case "Deposit":
    case "Withdraw": {
      const deposit = event.eventName === "Deposit";
      const account = addr(event, "owner");
      const sender = addr(event, "sender");
      const receiver = deposit ? account : addr(event, "receiver");
      await context.tx`
        INSERT INTO pool_events (tx_hash, log_index, block, ts, kind, account, sender, receiver, assets, shares)
        VALUES (
          ${event.txHash}, ${event.logIndex}, ${event.blockNumber.toString()}, ${iso(event.ts)},
          ${deposit ? "deposit" : "withdraw"}, ${account}, ${sender}, ${receiver},
          ${usdg(event.args.assets)}, ${units(event.args.shares, shareDecimals)}
        )
        ON CONFLICT (tx_hash, log_index) DO NOTHING
      `;
      await accountSeen(context.tx, event, [account, sender, receiver]);
      context.snapshotNeeded = true;
      context.kinds.add("pool");
      return;
    }
    default:
      return;
  }
}
