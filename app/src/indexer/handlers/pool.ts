import type { ChainEvent, IndexerContext } from "../types";
import { asBigInt, unixToDate, units, usdg, WAD_DECIMALS } from "../units";
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
    case "Rebalanced":
    case "CashRaised":
    case "HedgeUnitsSynced": {
      const stock = addr(event, "stock");
      const rebalance = event.eventName === "Rebalanced";
      const buy = rebalance && event.args.buy === true;
      // Rebalanced: a buy spends USDG (amountIn) for stock (amountOut); a sell spends stock for USDG.
      const stockAmount = rebalance ? units(buy ? event.args.amountOut : event.args.amountIn, WAD_DECIMALS)
        : event.eventName === "CashRaised" ? units(event.args.stockSold, WAD_DECIMALS) : null;
      const usdgAmount = rebalance ? usdg(buy ? event.args.amountIn : event.args.amountOut)
        : event.eventName === "CashRaised" ? usdg(event.args.usdgOut) : null;
      const unitsAfter = rebalance ? units(event.args.unitsAfter, WAD_DECIMALS)
        : event.eventName === "HedgeUnitsSynced" ? units(event.args.units, WAD_DECIMALS) : null;
      await context.tx`
        INSERT INTO pool_hedge_events (tx_hash, log_index, block, ts, kind, stock, side, stock_amount, usdg_amount, units_after)
        VALUES (
          ${event.txHash}, ${event.logIndex}, ${event.blockNumber.toString()}, ${iso(event.ts)},
          ${rebalance ? "rebalance" : event.eventName === "CashRaised" ? "cash_raised" : "units_synced"}, ${stock},
          ${rebalance ? (buy ? "buy" : "sell") : event.eventName === "CashRaised" ? "sell" : null},
          ${stockAmount}, ${usdgAmount}, ${unitsAfter}
        )
        ON CONFLICT (tx_hash, log_index) DO NOTHING
      `;
      context.snapshotNeeded = true;
      context.kinds.add("hedge");
      return;
    }
    case "WithdrawalQueued": {
      // Review F12(c): a ticket left unclaimed past CLAIM_WINDOW is re-queued by its next claim, which emits this
      // event again for the same ticket with a new claimable time.
      const owner = addr(event, "owner");
      await context.tx`
        INSERT INTO withdrawals (owner, ticket, shares, claimable_at, queued_at, queued_block, queued_tx, queued_log)
        VALUES (
          ${owner}, ${asBigInt(event.args.ticket).toString()}, ${units(event.args.shares, shareDecimals)},
          ${iso(unixToDate(event.args.claimableAt))}, ${iso(event.ts)}, ${event.blockNumber.toString()}, ${event.txHash}, ${event.logIndex}
        )
        ON CONFLICT (owner, ticket) DO UPDATE SET claimable_at = EXCLUDED.claimable_at
          WHERE withdrawals.status = 'queued'
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
