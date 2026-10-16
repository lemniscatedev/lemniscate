import type { ChainEvent, IndexerContext } from "../types";
import { asAddress, asBigInt, asNumber, power, usdg, wad } from "../units";
import { accountSeen, eventMarket } from "./common";

function marketState(context: IndexerContext, id: number): Record<string, unknown> {
  let state = context.marketStatesById.get(id);
  if (!state) {
    state = {};
    context.marketStatesById.set(id, state);
  }
  return state;
}

async function handleTrade(context: IndexerContext, event: ChainEvent): Promise<void> {
  const buy = event.eventName === "Bought";
  const marketId = eventMarket(event);
  const account = asAddress(event.args[buy ? "buyer" : "seller"]);
  const recipient = asAddress(event.args.recipient);
  const row = buy
    ? await context.tx`
        INSERT INTO trades (tx_hash, log_index, block, ts, market_id, account, recipient, side, usdg, fee, tokens, price, "index", norm_factor)
        VALUES (
          ${event.txHash}, ${event.logIndex}, ${event.blockNumber.toString()}, ${event.ts.toISOString()}, ${marketId},
          ${account}, ${recipient}, 'buy', ${usdg(event.args.usdgIn)}, ${usdg(event.args.fee)},
          ${power(event.args.tokensOut)}, ${wad(event.args.price)}, ${wad(event.args.index)}, ${wad(event.args.normFactor)}
        )
        ON CONFLICT (tx_hash, log_index) DO NOTHING
        RETURNING tx_hash
      `
    : await context.tx`
        INSERT INTO trades (tx_hash, log_index, block, ts, market_id, account, recipient, side, usdg, fee, tokens, price, "index", norm_factor)
        VALUES (
          ${event.txHash}, ${event.logIndex}, ${event.blockNumber.toString()}, ${event.ts.toISOString()}, ${marketId},
          ${account}, ${recipient}, 'sell', ${usdg(event.args.usdgOut)}, ${usdg(event.args.fee)},
          ${power(event.args.tokensIn)}, ${wad(event.args.price)}, ${wad(event.args.index)}, ${wad(event.args.normFactor)}
        )
        ON CONFLICT (tx_hash, log_index) DO NOTHING
        RETURNING tx_hash
      `;
  if (row.length > 0) context.insertedTradeTxs.add(event.txHash);
  await accountSeen(context.tx, event, [account, recipient]);
  context.marketIds.add(marketId);
  context.kinds.add("trade");
}

export async function handleEngineEvent(context: IndexerContext, event: ChainEvent): Promise<void> {
  if (event.source !== "engine") return;
  context.hasLemniscateEvents = true;
  context.snapshotNeeded = true;
  const marketId = eventMarket(event);

  switch (event.eventName) {
    case "Bought":
    case "Sold":
      await handleTrade(context, event);
      return;
    case "RegimeChanged": {
      const fromRegime = asNumber(event.args.from);
      const toRegime = asNumber(event.args.to);
      await context.tx`
        INSERT INTO regime_log (tx_hash, log_index, market_id, ts, from_regime, to_regime, block)
        VALUES (${event.txHash}, ${event.logIndex}, ${marketId}, ${event.ts.toISOString()}, ${fromRegime}, ${toRegime}, ${event.blockNumber.toString()})
        ON CONFLICT (tx_hash, log_index) DO NOTHING
      `;
      marketState(context, marketId).regime = toRegime;
      context.marketIds.add(marketId);
      context.kinds.add("regime");
      return;
    }
    case "BaseCarryUpdated": {
      await context.tx`
        INSERT INTO carry_updates (tx_hash, log_index, market_id, ts, base_carry_wad)
        VALUES (${event.txHash}, ${event.logIndex}, ${marketId}, ${event.ts.toISOString()}, ${wad(event.args.wad)})
        ON CONFLICT (tx_hash, log_index) DO NOTHING
      `;
      marketState(context, marketId).baseCarryWad = asBigInt(event.args.wad).toString();
      marketState(context, marketId).baseCarryUpdatedAt = Math.floor(event.ts.getTime() / 1_000).toString();
      context.marketIds.add(marketId);
      context.kinds.add("carry");
      return;
    }
    case "Accrued": {
      const state = marketState(context, marketId);
      state.normFactor = asBigInt(event.args.normFactor).toString();
      state.regime = asNumber(event.args.regime);
      state.lastAccrual = Math.floor(event.ts.getTime() / 1_000).toString();
      context.marketIds.add(marketId);
      context.kinds.add("regime");
      return;
    }
    case "BuysPaused":
      marketState(context, marketId).buysPaused = Boolean(event.args.paused);
      context.marketIds.add(marketId);
      context.kinds.add("config");
      return;
    case "GlobalBuysPaused":
      context.globalConfig.globalBuysPaused = Boolean(event.args.paused);
      context.kinds.add("config");
      return;
    case "GlobalConfigUpdated":
      context.globalConfig.maxGlobalExposureBps = asNumber(event.args.maxGlobalExposureBps);
      context.globalConfig.protocolFeeShareBps = asNumber(event.args.protocolFeeShareBps);
      context.globalConfig.treasury = asAddress(event.args.treasury);
      context.globalConfig.sequencerFeed = asAddress(event.args.sequencerFeed);
      context.kinds.add("config");
      return;
    case "MarketListed":
    case "MarketConfigUpdated":
      context.registryNeeded = true;
      context.marketIds.add(marketId);
      context.kinds.add("config");
      return;
    default:
      context.kinds.add("config");
  }
}
