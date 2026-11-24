import { withTransaction } from '@aisleforge/database';
import { createEvent, type OutboxEvent } from '@aisleforge/events';
import { AppError } from '@aisleforge/shared';
import type { Actor, DomainContext } from '../context';
import { enqueueEvents } from '../outbox';
import {
  appendLedger,
  balanceChangedEvent,
  lockBalancesSorted,
  type BalanceRow,
  type LedgerEntry,
} from '../inventory/balances';

/**
 * Cancels an order that has not finished picking and releases its ACTIVE reservations.
 * Global lock order (ADR-002): reservations (by id) -> inventory balances (by store, sku) -> order row.
 * Pick confirmation follows the same order, so cancel and pick cannot deadlock each other.
 */
export async function cancelOrder(
  ctx: DomainContext,
  cmd: { orderId: string; reason: string },
  actor: Actor,
): Promise<{ orderId: string; released: number; version: number }> {
  return withTransaction(
    ctx.pool,
    { label: 'orders.cancel', maxAttempts: ctx.config.PG_TX_MAX_ATTEMPTS, logger: ctx.logger },
    async (c) => {
      const res = await c.query<{
        id: string;
        order_id: string;
        store_id: number;
        sku: string;
        qty: number;
        version: number;
      }>(
        `UPDATE reservations SET status = 'released', version = version + 1, closed_reason = $2, updated_at = now()
        WHERE id IN (SELECT id FROM reservations WHERE order_id = $1 AND status = 'active' ORDER BY id FOR UPDATE)
        RETURNING id, order_id, store_id, sku, qty, version`,
        [cmd.orderId, `order_cancelled:${cmd.reason}`],
      );
      const released = res.rows;
      const events: OutboxEvent[] = [];
      if (released.length > 0) {
        const storeId = released[0]!.store_id;
        await lockBalancesSorted(
          c,
          storeId,
          released.map((r) => r.sku),
        );
        const upd = await c.query<BalanceRow>(
          `UPDATE inventory_balances b SET reserved = b.reserved - v.qty, version = b.version + 1, updated_at = now()
           FROM unnest($2::text[], $3::int[]) AS v(sku, qty)
          WHERE b.store_id = $1 AND b.sku = v.sku
          RETURNING b.store_id, b.sku, b.on_hand, b.reserved, b.version`,
          [storeId, released.map((r) => r.sku), released.map((r) => r.qty)],
        );
        const ledger: LedgerEntry[] = released.map((r) => ({
          storeId: r.store_id,
          sku: r.sku,
          movement: 'release',
          deltaOnHand: 0,
          deltaReserved: -r.qty,
          sourceType: 'reservation',
          sourceId: r.id,
          reason: 'order_cancelled',
          actorId: actor.actorId,
          correlationId: actor.correlationId,
        }));
        await appendLedger(c, ledger);
        for (const r of released) {
          events.push(
            createEvent('reservation.closed', {
              aggregateId: r.id,
              aggregateVersion: r.version,
              partitionKey: r.order_id,
              correlationId: actor.correlationId,
              payload: {
                reservationId: r.id,
                orderId: r.order_id,
                storeId: r.store_id,
                sku: r.sku,
                qty: r.qty,
                status: 'released',
                pickedQty: 0,
                shortQty: 0,
              },
            }),
          );
        }
        events.push(...upd.rows.map((b) => balanceChangedEvent(b, 'release', actor.correlationId)));
      }

      // Validity is checked last (lock order); failure rolls back the releases above.
      const o = await c.query<{ id: string; store_id: number; version: number }>(
        `UPDATE orders SET status = 'cancelled', version = version + 1, updated_at = now()
        WHERE id = $1 AND status IN ('reserved', 'picking') RETURNING id, store_id, version`,
        [cmd.orderId],
      );
      const order = o.rows[0];
      if (!order) {
        const cur = await c.query<{ status: string }>('SELECT status FROM orders WHERE id = $1', [
          cmd.orderId,
        ]);
        if (!cur.rows[0]) throw new AppError('NOT_FOUND', 'Order not found');
        throw new AppError(
          'INVALID_STATE_TRANSITION',
          `Order cannot be cancelled from status '${cur.rows[0].status}'`,
        );
      }
      events.unshift(
        createEvent('order.cancelled', {
          aggregateId: order.id,
          aggregateVersion: order.version,
          partitionKey: order.id,
          correlationId: actor.correlationId,
          payload: { orderId: order.id, storeId: order.store_id, reason: cmd.reason },
        }),
      );
      await enqueueEvents(c, events);
      return { orderId: order.id, released: released.length, version: order.version };
    },
  );
}
