import type { ChainEvent, IndexerContext } from "../types";
import { asAddress, asBigInt, asNumber, writerPool, power, usdg } from "../units";
import { accountSeen } from "./common";

function marketState(context: IndexerContext, id: number): Record<string, unknown> {
  let state = context.marketStatesById.get(id);
  if (!state) {
    state = {};
    context.marketStatesById.set(id, state);
  }
  return state;
}

function touch(context: IndexerContext, ...addresses: (string | undefined)[]): void {
  for (const address of addresses) {
    if (address && address.toLowerCase() !== "0x0000000000000000000000000000000000000000") {
      context.touchedAccounts.add(address.toLowerCase());
    }
  }
}

async function handleDepositWithdraw(context: IndexerContext, event: ChainEvent): Promise<void> {
  const isDeposit = event.eventName === "Deposit";
  const account = asAddress(event.args.owner);
  const sender = asAddress(event.args.sender);
  const receiver = isDeposit ? account : asAddress(event.args.receiver);
  const result = await context.tx`
    INSERT INTO vault_events (tx_hash, log_index, block, ts, kind, account, sender, receiver, assets, shares)
    VALUES (
      ${event.txHash}, ${event.logIndex}, ${event.blockNumber.toString()}, ${event.ts.toISOString()},
      ${isDeposit ? "deposit" : "withdraw"}, ${account}, ${sender}, ${receiver},
      ${usdg(event.args.assets)}, ${writerPool(event.args.shares)}
    )
    ON CONFLICT (tx_hash, log_index) DO NOTHING
    RETURNING tx_hash
  `;
  if (result.length > 0) context.insertedVaultActionTxs.add(event.txHash);
  await accountSeen(context.tx, event, [account, sender, receiver]);
  touch(context, account, sender, receiver);
  context.snapshotNeeded = true;
  context.hasLemniscateEvents = true;
  context.kinds.add("vault");
}

async function handleHedged(context: IndexerContext, event: ChainEvent): Promise<void> {
  const id = asNumber(event.args.id);
  const isBuy = Boolean(event.args.buy);
  const state = marketState(context, id);
  const amountIn = isBuy ? usdg(event.args.amountIn) : power(event.args.amountIn);
  const amountOut = isBuy ? power(event.args.amountOut) : usdg(event.args.amountOut);
  await context.tx`
    INSERT INTO hedges (tx_hash, log_index, block, ts, market_id, is_buy, amount_in, amount_out, hedge_units_after)
    VALUES (
      ${event.txHash}, ${event.logIndex}, ${event.blockNumber.toString()}, ${event.ts.toISOString()}, ${id}, ${isBuy},
      ${amountIn}, ${amountOut}, ${power(event.args.hedgeUnitsAfter)}
    )
    ON CONFLICT (tx_hash, log_index) DO NOTHING
  `;
  state.hedgeUnits = asBigInt(event.args.hedgeUnitsAfter).toString();
  context.marketIds.add(id);
  context.snapshotNeeded = true;
  context.hasLemniscateEvents = true;
  context.kinds.add("vault");
}

async function handleCashRaised(context: IndexerContext, event: ChainEvent): Promise<void> {
  const id = asNumber(event.args.id);
  const state = marketState(context, id);
  const unitsBefore = asBigInt(state.hedgeUnits);
  const stockSold = asBigInt(event.args.stockSold);
  const unitsAfter = unitsBefore > stockSold ? unitsBefore - stockSold : 0n;
  await context.tx`
    INSERT INTO hedges (tx_hash, log_index, block, ts, market_id, is_buy, amount_in, amount_out, hedge_units_after)
    VALUES (
      ${event.txHash}, ${event.logIndex}, ${event.blockNumber.toString()}, ${event.ts.toISOString()}, ${id}, false,
      ${power(stockSold)}, ${usdg(event.args.usdgOut)}, ${power(unitsAfter)}
    )
    ON CONFLICT (tx_hash, log_index) DO NOTHING
  `;
  state.hedgeUnits = unitsAfter.toString();
  context.marketIds.add(id);
  context.snapshotNeeded = true;
  context.hasLemniscateEvents = true;
  context.kinds.add("vault");
}

export async function handleVaultEvent(context: IndexerContext, event: ChainEvent): Promise<void> {
  if (event.source !== "vault") return;
  context.hasLemniscateEvents = true;
  context.snapshotNeeded = true;

  switch (event.eventName) {
    case "Deposit":
    case "Withdraw":
      await handleDepositWithdraw(context, event);
      return;
    case "Hedged":
      await handleHedged(context, event);
      return;
    case "CashRaised":
      await handleCashRaised(context, event);
      return;
    case "HedgeUnitsSynced": {
      const id = asNumber(event.args.id);
      marketState(context, id).hedgeUnits = asBigInt(event.args.hedgeUnits).toString();
      context.marketIds.add(id);
      context.kinds.add("vault");
      return;
    }
    case "DepositorUpdated": {
      const account = asAddress(event.args.account);
      const allowed = Boolean(event.args.allowed);
      await context.tx`
        INSERT INTO vault_account_state (account, is_depositor, unlock_time, updated_block, updated_at)
        VALUES (${account}, ${allowed}, NULL, ${event.blockNumber.toString()}, ${event.ts.toISOString()})
        ON CONFLICT (account) DO UPDATE SET
          is_depositor = EXCLUDED.is_depositor,
          updated_block = GREATEST(vault_account_state.updated_block, EXCLUDED.updated_block),
          updated_at = GREATEST(vault_account_state.updated_at, EXCLUDED.updated_at)
      `;
      touch(context, account);
      await accountSeen(context.tx, event, [account]);
      context.kinds.add("vault");
      return;
    }
    case "ParamsUpdated": {
      Object.assign(context.vaultConfig, {
        lockSeconds: asNumber(event.args.lockSeconds),
        cashBufferBps: asNumber(event.args.cashBufferBps),
        hedgeRatioBps: asNumber(event.args.hedgeRatioBps),
        rebalanceThresholdBps: asNumber(event.args.rebalanceThresholdBps),
        maxHedgeSlippageBps: asNumber(event.args.maxHedgeSlippageBps),
        minHedgeTradeUsdg: usdg(event.args.minHedgeTradeUsdg),
        maxTotalDeposits: usdg(event.args.maxTotalDeposits),
      });
      // unlockTime uses the current global duration, including older deposits.
      // Refresh holders even though this event has no account argument.
      const holders = await context.tx<{ account: string }[]>`
        SELECT account FROM vault_account_state WHERE unlock_time IS NOT NULL
      `;
      for (const holder of holders) touch(context, holder.account);
      context.kinds.add("config");
      return;
    }
    case "PublicDepositsUpdated":
      context.vaultConfig.publicDeposits = Boolean(event.args.enabled);
      context.kinds.add("config");
      return;
    case "HedgeRouteUpdated":
      context.registryNeeded = true;
      context.marketIds.add(asNumber(event.args.id));
      context.kinds.add("config");
      return;
    case "Transfer":
      // LWP Transfer rows and balances are handled by the shared token ledger.
      return;
    default:
      context.kinds.add("vault");
  }
}
