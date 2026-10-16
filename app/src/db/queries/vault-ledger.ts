import type { ApiDependencies, DbRow } from "../../api/types";
import { asRows } from "../../api/types";
import { decimal, fixed, multiply, ratioPercent } from "../../lib/fixed";
import { addAtCost, emptyCostState, removeAtAverageCost } from "./cost-ledger";

export const VAULT_EVENT_LIMIT = 5_000;

export interface VaultLedgerEvent extends DbRow {
  kind: "deposit" | "withdraw" | "transfer_in" | "transfer_out";
  shares: string;
  assets: string;
  nav_per_share: string | null;
}

/** Rows arrive oldest first after a bounded newest-first query. */
export function vaultCostBasis(rows: VaultLedgerEvent[], shares: bigint, value: bigint) {
  const state = emptyCostState();
  let historyComplete = rows.length <= VAULT_EVENT_LIMIT;
  for (const event of rows.slice(-VAULT_EVENT_LIMIT)) {
    const quantity = fixed(event.shares);
    if (event.kind === "deposit") {
      addAtCost(state, quantity, fixed(event.assets));
    } else if (event.kind === "transfer_in") {
      if (quantity > 0n && event.nav_per_share === null) historyComplete = false;
      addAtCost(state, quantity, multiply(quantity, fixed(event.nav_per_share)));
    } else {
      if (quantity > state.quantity) historyComplete = false;
      removeAtAverageCost(state, quantity);
    }
  }
  if (state.quantity !== shares) historyComplete = false;
  const cost = shares > 0n ? state.cost : 0n;
  const change = value - cost;
  return {
    costBasis: decimal(cost),
    change: decimal(change),
    changePct: cost > 0n ? ratioPercent(change, cost) : null,
    historyComplete,
  };
}

export async function vaultLedger(deps: ApiDependencies, address: string): Promise<VaultLedgerEvent[]> {
  const rows = await deps.sql`
    select * from (
      select * from (
        select kind, shares::text, assets::text, null::text as nav_per_share, block, log_index
        from vault_events where account = ${address}
        order by block desc, log_index desc limit ${VAULT_EVENT_LIMIT + 1}
      ) vault_rows
      union all
      select * from (
        select case when to_addr = ${address} then 'transfer_in' else 'transfer_out' end as kind,
          amount::text as shares, '0'::text as assets,
          (select nav_per_share::text from vault_ticks
            where vault_ticks.block <= transfers.block and vault_ticks.ts <= transfers.ts
            order by vault_ticks.block desc, vault_ticks.ts desc limit 1) as nav_per_share,
          block, log_index
        from transfers where market_id is null and token = ${deps.deployment.contracts.vault.toLowerCase()}
          and (from_addr = ${address} or to_addr = ${address}) and from_addr <> to_addr
        order by block desc, log_index desc limit ${VAULT_EVENT_LIMIT + 1}
      ) transfer_rows
      order by block desc, log_index desc limit ${VAULT_EVENT_LIMIT + 1}
    ) ledger order by block, log_index
  `;
  return asRows<VaultLedgerEvent>(rows);
}
