import type { PgClient } from '@aisleforge/database';
import { createEvent, type OutboxEvent } from '@aisleforge/events';

export interface BalanceRow {
  store_id: number;
  sku: string;
  on_hand: number;
  reserved: number;
  version: number;
}

/** Deterministic global lock order for inventory rows: (store_id, sku) ascending, byte-wise. */
export const compareBalanceKey = (
  a: { storeId: number; sku: string },
  b: { storeId: number; sku: string },
): number => a.storeId - b.storeId || (a.sku < b.sku ? -1 : a.sku > b.sku ? 1 : 0);

/**
 * Locks balance rows in (store_id, sku) order. PostgreSQL applies ORDER BY before the locking clause, so rows are
 * locked in sorted order; every multi-row inventory write in the codebase goes through here (ADR-002, audit T4).
 * FOR NO KEY UPDATE is the same lock an UPDATE takes and does not conflict with FK KEY SHARE locks.
 * `COLLATE "C"` makes the database order match the byte-wise order used in application code.
 */
export async function lockBalancesSorted(
  client: PgClient,
  storeId: number,
  skus: string[],
): Promise<Map<string, BalanceRow>> {
  const { rows } = await client.query<BalanceRow>(
    `SELECT store_id, sku, on_hand, reserved, version FROM inventory_balances
     WHERE store_id = $1 AND sku = ANY($2::text[])
     ORDER BY store_id, sku COLLATE "C"
     FOR NO KEY UPDATE`,
    [storeId, skus],
  );
  return new Map(rows.map((r) => [r.sku, r]));
}

export type Movement =
  'opening' | 'restock' | 'reserve' | 'release' | 'expire' | 'pick' | 'short_pick' | 'adjust';

export interface LedgerEntry {
  storeId: number;
  sku: string;
  movement: Movement;
  deltaOnHand: number;
  deltaReserved: number;
  sourceType: string;
  sourceId: string;
  reason?: string | null;
  actorId: string | null;
  correlationId: string | null;
}

/** Appends ledger rows in one round trip. Returns how many were inserted (conflicts = already applied). */
export async function appendLedger(
  client: PgClient,
  entries: LedgerEntry[],
  onConflictDoNothing = false,
): Promise<number> {
  if (entries.length === 0) return 0;
  const res = await client.query(
    `INSERT INTO inventory_ledger (store_id, sku, movement, delta_on_hand, delta_reserved, source_type, source_id,
                                   reason, actor_id, correlation_id)
     SELECT * FROM unnest($1::int[], $2::text[], $3::ledger_movement[], $4::int[], $5::int[], $6::text[], $7::text[],
                          $8::text[], $9::uuid[], $10::text[])
     ${onConflictDoNothing ? 'ON CONFLICT ON CONSTRAINT ledger_source_unique DO NOTHING' : ''}`,
    [
      entries.map((e) => e.storeId),
      entries.map((e) => e.sku),
      entries.map((e) => e.movement),
      entries.map((e) => e.deltaOnHand),
      entries.map((e) => e.deltaReserved),
      entries.map((e) => e.sourceType),
      entries.map((e) => e.sourceId),
      entries.map((e) => e.reason ?? null),
      entries.map((e) => e.actorId),
      entries.map((e) => e.correlationId),
    ],
  );
  return res.rowCount ?? 0;
}

export function balanceChangedEvent(
  b: BalanceRow,
  movement: Movement,
  correlationId: string | null,
): OutboxEvent {
  const aggregateId = `${b.store_id}:${b.sku}`;
  return createEvent('inventory.balance_changed', {
    aggregateId,
    aggregateVersion: b.version,
    partitionKey: aggregateId,
    correlationId,
    payload: {
      storeId: b.store_id,
      sku: b.sku,
      onHand: b.on_hand,
      reserved: b.reserved,
      available: b.on_hand - b.reserved,
      movement,
    },
  });
}
