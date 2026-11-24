import { withTransaction, type PgClient } from '@aisleforge/database';
import { createEvent, type OutboxEvent } from '@aisleforge/events';
import { AppError } from '@aisleforge/shared';
import type { Actor, DomainContext } from '../context';
import { enqueueEvents } from '../outbox';
import { appendLedger, balanceChangedEvent, type BalanceRow, type LedgerEntry } from './balances';

interface ClosedReservation {
  id: string;
  order_id: string;
  order_line_id: string;
  store_id: number;
  sku: string;
  qty: number;
  version: number;
}

export type CloseOutcome =
  | {
      transitioned: true;
      reservationId: string;
      status: 'released' | 'expired' | 'picked';
      balance: BalanceRow;
    }
  | { transitioned: false; reservationId: string; currentStatus: string | null };

/**
 * Compare-and-set state transition: only the transaction that moves the row out of 'active' may touch the
 * inventory counters. A concurrent expiry job and pick confirmation therefore cannot both decrement `reserved`
 * (audit T7: the read-then-update variant double-applied in 497/500 races).
 */
async function casFromActive(
  c: PgClient,
  reservationId: string,
  to: 'released' | 'expired' | 'picked',
  reason: string,
  requireExpired: boolean,
): Promise<ClosedReservation | null> {
  const res = await c.query<ClosedReservation>(
    `UPDATE reservations
        SET status = $2::reservation_status, version = version + 1, closed_reason = $3, updated_at = now()
      WHERE id = $1 AND status = 'active' ${requireExpired ? 'AND expires_at <= now()' : ''}
      RETURNING id, order_id, order_line_id, store_id, sku, qty, version`,
    [reservationId, to, reason],
  );
  return res.rows[0] ?? null;
}

async function currentStatus(c: PgClient, reservationId: string): Promise<string | null> {
  const r = await c.query<{ status: string }>('SELECT status FROM reservations WHERE id = $1', [
    reservationId,
  ]);
  return r.rows[0]?.status ?? null;
}

function closedEvent(
  r: ClosedReservation,
  status: 'released' | 'expired' | 'picked',
  picked: number,
  short: number,
  correlationId: string | null,
): OutboxEvent {
  return createEvent('reservation.closed', {
    aggregateId: r.id,
    aggregateVersion: r.version,
    partitionKey: r.order_id, // same partition as the order's events
    correlationId,
    payload: {
      reservationId: r.id,
      orderId: r.order_id,
      storeId: r.store_id,
      sku: r.sku,
      qty: r.qty,
      status,
      pickedQty: picked,
      shortQty: short,
    },
  });
}

/** Releases (manual/cancel) or expires (TTL job) a reservation, returning its quantity to `available`. */
export async function closeReservationInTx(
  c: PgClient,
  reservationId: string,
  to: 'released' | 'expired',
  reason: string,
  actor: Actor,
): Promise<CloseOutcome> {
  const r = await casFromActive(c, reservationId, to, reason, to === 'expired');
  if (!r) return { transitioned: false, reservationId, currentStatus: await currentStatus(c, reservationId) };
  const upd = await c.query<BalanceRow>(
    `UPDATE inventory_balances SET reserved = reserved - $3, version = version + 1, updated_at = now()
     WHERE store_id = $1 AND sku = $2 RETURNING store_id, sku, on_hand, reserved, version`,
    [r.store_id, r.sku, r.qty],
  );
  const balance = upd.rows[0];
  if (!balance) throw new AppError('INTERNAL', `Balance missing for reservation ${r.id}`);
  await appendLedger(c, [
    {
      storeId: r.store_id,
      sku: r.sku,
      movement: to === 'expired' ? 'expire' : 'release',
      deltaOnHand: 0,
      deltaReserved: -r.qty,
      sourceType: 'reservation',
      sourceId: r.id,
      reason,
      actorId: actor.actorId,
      correlationId: actor.correlationId,
    },
  ]);
  await enqueueEvents(c, [
    closedEvent(r, to, 0, 0, actor.correlationId),
    balanceChangedEvent(balance, to === 'expired' ? 'expire' : 'release', actor.correlationId),
  ]);
  return { transitioned: true, reservationId, status: to, balance };
}

export async function releaseReservation(
  ctx: DomainContext,
  cmd: { reservationId: string; reason: string },
  actor: Actor,
): Promise<CloseOutcome> {
  return withTransaction(
    ctx.pool,
    { label: 'reservations.release', maxAttempts: ctx.config.PG_TX_MAX_ATTEMPTS, logger: ctx.logger },
    (c) => closeReservationInTx(c, cmd.reservationId, 'released', cmd.reason, actor),
  );
}

export async function expireReservation(
  ctx: DomainContext,
  cmd: { reservationId: string },
  actor: Actor,
): Promise<CloseOutcome> {
  return withTransaction(
    ctx.pool,
    { label: 'reservations.expire', maxAttempts: ctx.config.PG_TX_MAX_ATTEMPTS, logger: ctx.logger },
    (c) => closeReservationInTx(c, cmd.reservationId, 'expired', 'ttl_elapsed', actor),
  );
}

/**
 * Confirms a pick. `pickedQty` may be less than the reserved qty: the remainder is a SHORT PICK (units the system
 * believed were on the shelf but were not found). Both parts leave `reserved` and `on_hand`; the short part is
 * recorded separately (movement 'short_pick') so it can drive a recount. See ADR-002 §Short picks.
 */
export async function confirmPickInTx(
  c: PgClient,
  cmd: { reservationId: string; pickedQty: number },
  actor: Actor,
): Promise<CloseOutcome & { pickedQty?: number; shortQty?: number }> {
  const r = await casFromActive(c, cmd.reservationId, 'picked', 'picked', false);
  if (!r)
    return {
      transitioned: false,
      reservationId: cmd.reservationId,
      currentStatus: await currentStatus(c, cmd.reservationId),
    };
  if (!Number.isInteger(cmd.pickedQty) || cmd.pickedQty < 0 || cmd.pickedQty > r.qty) {
    throw new AppError('VALIDATION_FAILED', `pickedQty must be an integer in [0, ${r.qty}]`);
  }
  const picked = cmd.pickedQty;
  const short = r.qty - picked;
  const upd = await c.query<BalanceRow>(
    `UPDATE inventory_balances SET on_hand = on_hand - $3, reserved = reserved - $3, version = version + 1, updated_at = now()
     WHERE store_id = $1 AND sku = $2 RETURNING store_id, sku, on_hand, reserved, version`,
    [r.store_id, r.sku, r.qty],
  );
  const balance = upd.rows[0];
  if (!balance) throw new AppError('INTERNAL', `Balance missing for reservation ${r.id}`);
  const ledger: LedgerEntry[] = [];
  const base = {
    storeId: r.store_id,
    sku: r.sku,
    sourceType: 'reservation',
    sourceId: r.id,
    actorId: actor.actorId,
    correlationId: actor.correlationId,
  };
  if (picked > 0) ledger.push({ ...base, movement: 'pick', deltaOnHand: -picked, deltaReserved: -picked });
  if (short > 0)
    ledger.push({
      ...base,
      movement: 'short_pick',
      deltaOnHand: -short,
      deltaReserved: -short,
      reason: 'not_found_at_location',
    });
  await appendLedger(c, ledger);
  await c.query('UPDATE order_lines SET picked_qty = $2, short_qty = $3 WHERE id = $1', [
    r.order_line_id,
    picked,
    short,
  ]);
  const events = [
    closedEvent(r, 'picked', picked, short, actor.correlationId),
    balanceChangedEvent(balance, short > 0 ? 'short_pick' : 'pick', actor.correlationId),
  ];
  const orderEvent = await advanceOrderIfFullyPicked(c, r.order_id, actor);
  if (orderEvent) events.push(orderEvent);
  await enqueueEvents(c, events);
  return {
    transitioned: true,
    reservationId: r.id,
    status: 'picked',
    balance,
    pickedQty: picked,
    shortQty: short,
  };
}

export async function confirmPick(
  ctx: DomainContext,
  cmd: { reservationId: string; pickedQty: number },
  actor: Actor,
) {
  return withTransaction(
    ctx.pool,
    { label: 'reservations.pick', maxAttempts: ctx.config.PG_TX_MAX_ATTEMPTS, logger: ctx.logger },
    (c) => confirmPickInTx(c, cmd, actor),
  );
}

/** When no reservation of the order is still active and at least one was picked, the order becomes 'picked'. */
export async function advanceOrderIfFullyPicked(
  c: PgClient,
  orderId: string,
  actor: Actor,
): Promise<OutboxEvent | null> {
  const res = await c.query<{ id: string; store_id: number; version: number; short_lines: number }>(
    `UPDATE orders o SET status = 'picked', version = version + 1, updated_at = now()
      WHERE o.id = $1 AND o.status IN ('reserved', 'picking')
        AND NOT EXISTS (SELECT 1 FROM reservations r WHERE r.order_id = o.id AND r.status = 'active')
      RETURNING o.id, o.store_id, o.version,
        (SELECT count(*) FROM order_lines l WHERE l.order_id = o.id AND l.short_qty > 0)::int AS short_lines`,
    [orderId],
  );
  const o = res.rows[0];
  if (!o) return null;
  return createEvent('order.picked', {
    aggregateId: o.id,
    aggregateVersion: o.version,
    partitionKey: o.id,
    correlationId: actor.correlationId,
    payload: { orderId: o.id, storeId: o.store_id, shortLines: o.short_lines },
  });
}

/**
 * TTL sweep, run by the worker. Each reservation is expired in its own short transaction (no long-held locks,
 * no full-table UPDATE). Safe to run concurrently with pick confirmation and with other sweepers.
 */
export async function expireDueReservations(
  ctx: DomainContext,
  opts: { limit: number },
  actor: Actor,
): Promise<{ scanned: number; expired: number }> {
  const due = await ctx.pool.query<{ id: string }>(
    `SELECT id FROM reservations WHERE status = 'active' AND expires_at <= now() ORDER BY expires_at LIMIT $1`,
    [opts.limit],
  );
  let expired = 0;
  for (const { id } of due.rows) {
    const out = await expireReservation(ctx, { reservationId: id }, actor);
    if (out.transitioned) expired++;
  }
  return { scanned: due.rows.length, expired };
}
