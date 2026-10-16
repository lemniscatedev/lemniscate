import { fixed, decimal, divide, multiply, projectNormFactor, priceAtNormFactor } from "../../lib/fixed";
import { emptyCostState } from "./cost-ledger";
import { powerLedgerEvents, replayPowerLedger } from "./power-ledger";
import { vaultCostBasis, vaultLedger } from "./vault-ledger";
import { apiNow } from "../../api/clock";
import type { ApiDependencies, DbRow } from "../../api/types";
import { asRows, dateValue, numberValue } from "../../api/types";

interface PositionRow extends DbRow {
  id: number | string;
  symbol: string;
  token: string;
  balance: string;
}

// Addresses are stored lowercase by the indexer and lowercased by the route
// schema, so queries compare columns directly and can use their indexes.
function normalizeAddress(address: string): string {
  return address.toLowerCase();
}

export { PORTFOLIO_EVENT_LIMIT } from "./power-ledger";

export async function accountPortfolio(deps: ApiDependencies, rawAddress: string) {
  const address = normalizeAddress(rawAddress);
  const positionsResult = await deps.sql`
    select m.id, m.symbol, m.token, b.balance::text
    from balances b join markets m on m.token = b.token
    where b.account = ${address} and b.balance > 0 order by m.id
  `;
  const positions = asRows<PositionRow>(positionsResult);
  const [marketResult, ledger, writerPoolResult, vaultResult, accountStateResult, writerPoolEvents] = await Promise.all([
    deps.sql`
      select m.id, t.ts, t.norm_factor, t.price, t.carry_wad
      from markets m left join lateral (select * from ticks where market_id = m.id order by ts desc limit 1) t on true
      order by m.id
    `,
    powerLedgerEvents(deps, address),
    deps.sql`select balance::text from balances where account = ${address} and token = ${deps.deployment.contracts.vault.toLowerCase()} limit 1`,
    deps.sql`select nav_per_share::text from vault_ticks order by ts desc limit 1`,
    deps.sql`select is_depositor, unlock_time from vault_account_state where account = ${address} limit 1`,
    vaultLedger(deps, address),
  ]);
  const marketRows = asRows<DbRow>(marketResult);
  const marketById = new Map(marketRows.map((row) => [numberValue(row.id), row]));
  const { costs } = replayPowerLedger(ledger.events, address);
  const historyComplete = ledger.historyComplete;

  const now = await apiNow(deps);
  let powerValue = 0n;
  let unrealizedTotal = 0n;
  const realizedTotal = [...costs.values()].reduce((total, state) => total + state.realized, 0n);
  const responsePositions = positions.map((position) => {
    const marketId = numberValue(position.id);
    const rawMarket = marketById.get(marketId);
    const state = costs.get(marketId) ?? emptyCostState();
    const balance = fixed(position.balance);
    const tickTs = dateValue(rawMarket?.ts);
    const norm = rawMarket?.norm_factor as string | undefined;
    const normNow = projectNormFactor(norm ?? "0", rawMarket?.carry_wad as string | undefined ?? "0",
      tickTs ? (now.getTime() - tickTs.getTime()) / 1000 : 0);
    const price = priceAtNormFactor(rawMarket?.price as string | undefined ?? "0", norm ?? "0", normNow);
    const value = multiply(balance, price);
    const avgCost = state.quantity > 0n ? divide(state.cost, state.quantity) : price;
    const costBasis = multiply(balance, avgCost);
    const unrealizedPnl = value - costBasis;
    powerValue += value;
    unrealizedTotal += unrealizedPnl;
    return {
      symbol: position.symbol,
      balance: decimal(balance),
      price: decimal(price),
      value: decimal(value),
      avgCost: decimal(avgCost),
      costBasis: decimal(costBasis),
      unrealizedPnl: decimal(unrealizedPnl),
      realizedPnl: decimal(state.realized),
    };
  });
  const writerPoolShares = fixed(asRows<DbRow>(writerPoolResult)[0]?.balance as string | undefined);
  const navPerShare = fixed(asRows<DbRow>(vaultResult)[0]?.nav_per_share as string | undefined);
  const writerPoolValue = multiply(writerPoolShares, navPerShare);
  const accountState = asRows<DbRow>(accountStateResult)[0];
  return {
    positions: responsePositions,
    writerPool: {
      shares: decimal(writerPoolShares),
      value: decimal(writerPoolValue),
      ...vaultCostBasis(writerPoolEvents, writerPoolShares, writerPoolValue),
      unlockTime: dateValue(accountState?.unlock_time)?.toISOString() ?? null,
      isDepositor: accountState?.is_depositor === true,
    },
    totals: { powerValue: decimal(powerValue), unrealizedPnl: decimal(unrealizedTotal), realizedPnl: decimal(realizedTotal) },
    historyComplete,
  };
}

interface ActivityRow extends DbRow {
  kind: "buy" | "sell" | "deposit" | "withdraw" | "transfer_in" | "transfer_out";
  symbol: string;
  usdg: string | null;
  tokens: string | null;
  price: string | null;
  ts: Date | string;
  tx_hash: string;
  log_index: number | string;
}

interface ActivityCursor { ts: string; txHash: string; logIndex: number }

function decodeCursor(cursor: string | undefined): ActivityCursor | null {
  if (!cursor) return null;
  try {
    const raw = Buffer.from(cursor, "base64url").toString("utf8");
    const [ts, txHash, logIndex] = raw.split("|");
    if (!ts || !txHash || !logIndex || !/^0x[0-9a-f]{64}$/i.test(txHash) || !/^\d+$/.test(logIndex) || !dateValue(ts)) return null;
    return { ts, txHash, logIndex: Number(logIndex) };
  } catch {
    return null;
  }
}

function encodeCursor(row: ActivityRow): string {
  return Buffer.from(`${dateValue(row.ts)?.toISOString() ?? String(row.ts)}|${row.tx_hash}|${row.log_index}`, "utf8").toString("base64url");
}

export async function accountActivity(
  deps: ApiDependencies,
  rawAddress: string,
  type: "all" | "trades" | "vault",
  cursorValue: string | undefined,
  limit: number,
) {
  const address = normalizeAddress(rawAddress);
  const cursor = decodeCursor(cursorValue);
  if (cursorValue && !cursor) throw Object.assign(new Error("Invalid activity cursor"), { status: 400, apiError: "BAD_REQUEST" });
  const params: Array<string | number> = [address, type];
  let cursorClause = "";
  if (cursor) {
    params.push(cursor.ts, cursor.txHash, cursor.logIndex);
    cursorClause = "and (activity.ts, activity.tx_hash, activity.log_index) < ($3::timestamptz, $4::text, $5::int)";
  }
  params.push(limit + 1);
  const limitPlaceholder = `$${params.length}`;
  const query = `with activity as (
    select case when t.side = 'buy' then 'buy' else 'sell' end::text as kind,
      m.symbol, t.usdg::text as usdg, t.tokens::text as tokens, t.price::text as price,
      t.ts, t.tx_hash, t.log_index
    from trades t join markets m on m.id = t.market_id
    where t.account = $1 or t.recipient = $1
    union all
    select case when x.to_addr = $1 then 'transfer_in' else 'transfer_out' end::text,
      coalesce(m.symbol, 'LWP'), null::text, x.amount::text,
      (select price::text from ticks where ticks.market_id = x.market_id and ticks.block <= x.block order by ticks.block desc, ticks.ts desc limit 1),
      x.ts, x.tx_hash, x.log_index
    from transfers x left join markets m on m.id = x.market_id
    where x.from_addr = $1 or x.to_addr = $1
    union all
    select case when lower(v.kind) = 'deposit' then 'deposit' else 'withdraw' end::text,
      'LWP', v.assets::text, v.shares::text,
      case when v.shares > 0 then (v.assets / v.shares)::text else null end,
      v.ts, v.tx_hash, v.log_index
    from vault_events v where v.account = $1
  )
  select activity.* from activity
  where ($2 = 'all'
    or ($2 = 'trades' and activity.kind in ('buy', 'sell', 'transfer_in', 'transfer_out') and activity.symbol <> 'LWP')
    or ($2 = 'vault' and activity.symbol = 'LWP'))
    ${cursorClause}
  order by activity.ts desc, activity.tx_hash desc, activity.log_index desc
  limit ${limitPlaceholder}`;
  const result = await deps.sql.unsafe(query, params);
  const allItems = asRows<ActivityRow>(result);
  const hasMore = allItems.length > limit;
  const page = allItems.slice(0, limit);
  return {
    items: page.map((row) => ({
      id: `${row.tx_hash}:${row.log_index}`,
      kind: row.kind,
      symbol: row.symbol,
      usdg: row.usdg,
      tokens: row.tokens,
      price: row.price,
      ts: dateValue(row.ts)?.toISOString() ?? String(row.ts),
      txHash: row.tx_hash,
    })),
    nextCursor: hasMore && page.length > 0 ? encodeCursor(page[page.length - 1]!) : null,
  };
}
