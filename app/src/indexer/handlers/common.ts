import type { TransactionSql } from "postgres";
import type { ChainEvent } from "../types";
import { asAddress, ZERO_ADDRESS } from "../units";

export function arg(event: ChainEvent, key: string, fallback?: unknown): unknown {
  return event.args[key] ?? fallback;
}

export function argString(event: ChainEvent, key: string, fallback = ""): string {
  const value = arg(event, key);
  return typeof value === "string" ? value : fallback;
}

export function argBoolean(event: ChainEvent, key: string): boolean {
  return Boolean(arg(event, key));
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
      VALUES (${address}, ${event.blockNumber.toString()}, ${event.ts.toISOString()}, ${event.blockNumber.toString()}, ${event.ts.toISOString()})
      ON CONFLICT (address) DO UPDATE SET
        first_seen_block = LEAST(account_metadata.first_seen_block, EXCLUDED.first_seen_block),
        first_seen_at = LEAST(account_metadata.first_seen_at, EXCLUDED.first_seen_at),
        last_seen_block = GREATEST(account_metadata.last_seen_block, EXCLUDED.last_seen_block),
        last_activity_at = GREATEST(account_metadata.last_activity_at, EXCLUDED.last_activity_at)
    `;
  }
}

export function eventMarket(event: ChainEvent): number {
  return event.marketId ?? Number(event.args.id ?? 0);
}

export function nullableAddress(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const address = asAddress(value);
  return address === ZERO_ADDRESS ? null : address;
}
