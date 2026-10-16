import type { ApiDependencies, DbRow } from "../../api/types";
import { apiNow } from "../../api/clock";
import { asRows, dateValue, jsonRecord, textValue } from "../../api/types";

export async function corporateActions(deps: ApiDependencies, symbol?: string) {
  const now = await apiNow(deps);
  const nowIso = now.toISOString();
  const rows = symbol
    ? await deps.sql`
      select id, symbol, kind, status, process_date, effective_at, old_mult::text, new_mult::text,
        verified_continuity, details
      from corp_actions
      where upper(symbol) = ${symbol.toUpperCase()}
        and (process_date >= ${nowIso}::date - 30 or effective_at >= ${nowIso}::timestamptz or lower(status) in ('in_progress', 'processing', 'pending'))
      order by effective_at asc nulls last, process_date asc nulls last, updated_at desc
    `
    : await deps.sql`
      select id, symbol, kind, status, process_date, effective_at, old_mult::text, new_mult::text,
        verified_continuity, details
      from corp_actions
      where process_date >= ${nowIso}::date - 30 or effective_at >= ${nowIso}::timestamptz
        or lower(status) in ('in_progress', 'processing', 'pending')
      order by effective_at asc nulls last, process_date asc nulls last, updated_at desc
    `;
  return asRows<DbRow>(rows).map((row) => ({
    id: textValue(row.id),
    symbol: textValue(row.symbol),
    kind: textValue(row.kind),
    status: textValue(row.status),
    processDate: row.process_date instanceof Date
      ? row.process_date.toISOString().slice(0, 10)
      : row.process_date ? String(row.process_date).slice(0, 10) : null,
    effectiveAt: dateValue(row.effective_at)?.toISOString() ?? null,
    oldMultiplier: row.old_mult === null ? null : textValue(row.old_mult),
    newMultiplier: row.new_mult === null ? null : textValue(row.new_mult),
    verifiedContinuity: typeof row.verified_continuity === "boolean" ? row.verified_continuity : null,
    details: jsonRecord(row.details),
  }));
}
