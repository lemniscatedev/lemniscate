import type { TransactionSql } from "postgres";
import type { ChainEvent } from "../types";
import { asAddress, ZERO_ADDRESS } from "../units";

export function arg(event: ChainEvent, key: string, fallback?: unknown): unknown {
  return event.args[key] ?? fallback;
}

export function addr(event: ChainEvent, key: string): string {
  return asAddress(arg(event, key, ZERO_ADDRESS));
}

export function id32(event: ChainEvent, key: string): string {
  return String(arg(event, key, "")).toLowerCase();
}

export function iso(date: Date): string {
  return date.toISOString();
}

export async function accountSeen(
  tx: TransactionSql,
  event: ChainEvent,
  addresses: readonly (string | undefined)[],
): Promise<void> {
  const unique = new Set(
    addresses
      .filter((address): address is string => Boolean(address))
      .map((address) => address.toLowerCase())
      .filter((address) => address !== ZERO_ADDRESS),
  );
  for (const address of unique) {
    await tx`
      INSERT INTO account_metadata (address, first_seen_block, first_seen_at, last_seen_block, last_activity_at)
      VALUES (${address}, ${event.blockNumber.toString()}, ${iso(event.ts)}, ${event.blockNumber.toString()}, ${iso(event.ts)})
      ON CONFLICT (address) DO UPDATE SET
        first_seen_block = LEAST(account_metadata.first_seen_block, EXCLUDED.first_seen_block),
        first_seen_at = LEAST(account_metadata.first_seen_at, EXCLUDED.first_seen_at),
        last_seen_block = GREATEST(account_metadata.last_seen_block, EXCLUDED.last_seen_block),
        last_activity_at = GREATEST(account_metadata.last_activity_at, EXCLUDED.last_activity_at)
    `;
  }
}
