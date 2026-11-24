import { withTransaction } from '@aisleforge/database';
import { AppError, pgErrorCode } from '@aisleforge/shared';
import type { Actor, DomainContext } from '../context';
import { enqueueEvents } from '../outbox';
import { appendLedger, balanceChangedEvent, type BalanceRow } from './balances';

/** Creates a balance with its opening ledger movement (the ledger must reproduce every balance — I3). */
export async function openBalance(
  ctx: DomainContext,
  cmd: { storeId: number; sku: string; onHand: number; sourceId: string },
  actor: Actor,
): Promise<BalanceRow> {
  if (!Number.isInteger(cmd.onHand) || cmd.onHand < 0)
    throw new AppError('VALIDATION_FAILED', 'onHand must be a non-negative integer');
  return withTransaction(
    ctx.pool,
    { label: 'inventory.open', maxAttempts: ctx.config.PG_TX_MAX_ATTEMPTS, logger: ctx.logger },
    async (c) => {
      const ins = await c.query<BalanceRow>(
        `INSERT INTO inventory_balances (store_id, sku, on_hand, reserved, version) VALUES ($1, $2, $3, 0, 1)
       ON CONFLICT DO NOTHING RETURNING store_id, sku, on_hand, reserved, version`,
        [cmd.storeId, cmd.sku, cmd.onHand],
      );
      const row = ins.rows[0];
      if (!row)
        throw new AppError('CONFLICT', `Balance already exists for store ${cmd.storeId} / ${cmd.sku}`);
      await appendLedger(c, [
        {
          storeId: cmd.storeId,
          sku: cmd.sku,
          movement: 'opening',
          deltaOnHand: cmd.onHand,
          deltaReserved: 0,
          sourceType: 'opening',
          sourceId: cmd.sourceId,
          actorId: actor.actorId,
          correlationId: actor.correlationId,
        },
      ]);
      await enqueueEvents(c, [balanceChangedEvent(row, 'opening', actor.correlationId)]);
      return row;
    },
  );
}

/**
 * Adds stock. Idempotent per `sourceId` (e.g. a goods-receipt id): the ledger insert is the dedupe point, and the
 * balance is only touched if the ledger row was new.
 */
export async function restock(
  ctx: DomainContext,
  cmd: { storeId: number; sku: string; qty: number; sourceId: string; reason?: string },
  actor: Actor,
): Promise<{ applied: boolean; balance: BalanceRow | null }> {
  if (!Number.isInteger(cmd.qty) || cmd.qty <= 0)
    throw new AppError('VALIDATION_FAILED', 'qty must be a positive integer');
  return withTransaction(
    ctx.pool,
    { label: 'inventory.restock', maxAttempts: ctx.config.PG_TX_MAX_ATTEMPTS, logger: ctx.logger },
    async (c) => {
      const inserted = await ledgerOrNotFound(cmd, () =>
        appendLedger(
          c,
          [
            {
              storeId: cmd.storeId,
              sku: cmd.sku,
              movement: 'restock',
              deltaOnHand: cmd.qty,
              deltaReserved: 0,
              sourceType: 'restock',
              sourceId: cmd.sourceId,
              reason: cmd.reason ?? null,
              actorId: actor.actorId,
              correlationId: actor.correlationId,
            },
          ],
          true,
        ),
      );
      if (inserted === 0) return { applied: false, balance: null };
      const upd = await c.query<BalanceRow>(
        `UPDATE inventory_balances SET on_hand = on_hand + $3, version = version + 1, updated_at = now()
       WHERE store_id = $1 AND sku = $2 RETURNING store_id, sku, on_hand, reserved, version`,
        [cmd.storeId, cmd.sku, cmd.qty],
      );
      const row = upd.rows[0];
      if (!row) throw new AppError('NOT_FOUND', `No balance for store ${cmd.storeId} / ${cmd.sku}`);
      await enqueueEvents(c, [balanceChangedEvent(row, 'restock', actor.correlationId)]);
      return { applied: true, balance: row };
    },
  );
}

/**
 * Manual on-hand correction (damage, found stock, reconciled cycle count). Guarded so on_hand can never drop below
 * what is already reserved: that would silently invalidate promises made to customers. Such a case requires an
 * explicit reallocation decision instead (ADJUSTMENT_BELOW_RESERVED).
 */
export async function adjustStock(
  ctx: DomainContext,
  cmd: { storeId: number; sku: string; delta: number; sourceId: string; reason: string },
  actor: Actor,
): Promise<{ applied: boolean; balance: BalanceRow | null }> {
  if (!Number.isInteger(cmd.delta) || cmd.delta === 0)
    throw new AppError('VALIDATION_FAILED', 'delta must be a non-zero integer');
  return withTransaction(
    ctx.pool,
    { label: 'inventory.adjust', maxAttempts: ctx.config.PG_TX_MAX_ATTEMPTS, logger: ctx.logger },
    async (c) => {
      const inserted = await ledgerOrNotFound(cmd, () =>
        appendLedger(
          c,
          [
            {
              storeId: cmd.storeId,
              sku: cmd.sku,
              movement: 'adjust',
              deltaOnHand: cmd.delta,
              deltaReserved: 0,
              sourceType: 'adjustment',
              sourceId: cmd.sourceId,
              reason: cmd.reason,
              actorId: actor.actorId,
              correlationId: actor.correlationId,
            },
          ],
          true,
        ),
      );
      if (inserted === 0) return { applied: false, balance: null };
      const upd = await c.query<BalanceRow>(
        `UPDATE inventory_balances SET on_hand = on_hand + $3, version = version + 1, updated_at = now()
       WHERE store_id = $1 AND sku = $2 AND on_hand + $3 >= reserved
       RETURNING store_id, sku, on_hand, reserved, version`,
        [cmd.storeId, cmd.sku, cmd.delta],
      );
      const row = upd.rows[0];
      if (!row) {
        // Rolls back the ledger row too (whole transaction).
        throw new AppError(
          'ADJUSTMENT_BELOW_RESERVED',
          'Adjustment would drop on_hand below reserved quantity',
          {
            details: { storeId: cmd.storeId, sku: cmd.sku, delta: cmd.delta },
          },
        );
      }
      await enqueueEvents(c, [balanceChangedEvent(row, 'adjust', actor.correlationId)]);
      return { applied: true, balance: row };
    },
  );
}

/** The ledger has a FK to the balance: a missing balance surfaces as 23503, translated to a typed NOT_FOUND. */
async function ledgerOrNotFound(
  cmd: { storeId: number; sku: string },
  fn: () => Promise<number>,
): Promise<number> {
  try {
    return await fn();
  } catch (e) {
    if (pgErrorCode(e) === '23503')
      throw new AppError('NOT_FOUND', `No balance for store ${cmd.storeId} / ${cmd.sku}`, { cause: e });
    throw e;
  }
}
