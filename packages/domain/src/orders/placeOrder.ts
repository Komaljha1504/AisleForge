import { withTransaction, type PgClient } from '@aisleforge/database';
import { createEvent } from '@aisleforge/events';
import { AppError, newId } from '@aisleforge/shared';
import type { Actor, DomainContext } from '../context';
import { enqueueEvents } from '../outbox';
import {
  appendLedger,
  balanceChangedEvent,
  lockBalancesSorted,
  type BalanceRow,
} from '../inventory/balances';
import { normalizeLines, placeOrderRequestHash, type RequestedLine } from './normalize';

export interface PlaceOrderCommand {
  principalId: string;
  idempotencyKey: string;
  storeId: number;
  lines: RequestedLine[];
}

export interface PlaceOrderResult {
  statusCode: number;
  body: Record<string, unknown>;
  /** true when this response was replayed from a previous request with the same key. */
  replayed: boolean;
  orderId: string | null;
}

const OPERATION = 'orders.place';

/**
 * Places an order and reserves all of its lines, all-or-nothing, in ONE PostgreSQL transaction together with the
 * idempotency record, ledger movements and outbox events (ADR-002). No Kafka/Redis/optimizer calls happen here.
 *
 * Lock order inside the transaction:
 *   1. idempotency_keys(principal, key)   — concurrent duplicates queue here, before touching inventory
 *   2. inventory_balances sorted by (store_id, sku) — deadlock-free multi-line reservation (audit T4)
 * Business outcomes (201, 409 insufficient stock, 422 unknown SKU) are recorded against the key so a retry
 * returns exactly the original response. A key reused with a different payload is rejected (422).
 */
export async function placeOrder(
  ctx: DomainContext,
  cmd: PlaceOrderCommand,
  actor: Actor,
): Promise<PlaceOrderResult> {
  const lines = normalizeLines(cmd.lines, {
    maxLines: ctx.config.MAX_ORDER_LINES,
    maxQty: ctx.config.MAX_LINE_QTY,
  });
  const requestHash = placeOrderRequestHash(cmd.storeId, lines);

  return withTransaction(
    ctx.pool,
    { label: 'orders.place', maxAttempts: ctx.config.PG_TX_MAX_ATTEMPTS, logger: ctx.logger },
    async (c) => {
      // 1. Claim the idempotency key (placeholder row, replaced before COMMIT; invisible to others until then).
      const claim = await c.query(
        `INSERT INTO idempotency_keys (principal_id, idempotency_key, operation, request_hash, status_code, response_body)
       VALUES ($1, $2, $3, $4, 102, '{}'::jsonb)
       ON CONFLICT (principal_id, idempotency_key) DO NOTHING`,
        [cmd.principalId, cmd.idempotencyKey, OPERATION, requestHash],
      );
      if (claim.rowCount === 0) return replay(c, cmd, requestHash);

      // 2. Everything below is undone (except the key claim) if the order cannot be fully reserved.
      await c.query('SAVEPOINT reserve_lines');
      const orderId = newId();
      const locked = await lockBalancesSorted(
        c,
        cmd.storeId,
        lines.map((l) => l.sku),
      );

      const unknown = lines.filter((l) => !locked.has(l.sku)).map((l) => l.sku);
      if (unknown.length > 0) {
        await c.query('ROLLBACK TO SAVEPOINT reserve_lines');
        return record(
          c,
          cmd,
          422,
          {
            error: {
              code: 'UNKNOWN_SKU',
              message: 'Some SKUs are not stocked in this store',
              details: { skus: unknown },
            },
          },
          null,
        );
      }

      // Guarded conditional UPDATE is the authority for availability; the locked snapshot only explains failures.
      const upd = await c.query<BalanceRow>(
        `UPDATE inventory_balances b
          SET reserved = b.reserved + v.qty, version = b.version + 1, updated_at = now()
         FROM unnest($2::text[], $3::int[]) AS v(sku, qty)
        WHERE b.store_id = $1 AND b.sku = v.sku AND (b.on_hand - b.reserved) >= v.qty
        RETURNING b.store_id, b.sku, b.on_hand, b.reserved, b.version`,
        [cmd.storeId, lines.map((l) => l.sku), lines.map((l) => l.qty)],
      );
      if (upd.rowCount !== lines.length) {
        const reservedSkus = new Set(upd.rows.map((r) => r.sku));
        const shortages = lines
          .filter((l) => !reservedSkus.has(l.sku))
          .map((l) => {
            const b = locked.get(l.sku);
            return { sku: l.sku, requested: l.qty, available: b ? b.on_hand - b.reserved : 0 };
          });
        await c.query('ROLLBACK TO SAVEPOINT reserve_lines');
        return record(
          c,
          cmd,
          409,
          {
            error: {
              code: 'INSUFFICIENT_STOCK',
              message: 'Insufficient stock for one or more lines',
              details: { shortages },
            },
          },
          null,
        );
      }

      // 3. Order, lines, reservations, ledger, outbox — batched to keep the row-lock hold time short.
      const expiresAt = new Date(Date.now() + ctx.config.RESERVATION_TTL_MINUTES * 60_000);
      const lineRows = lines.map((l) => ({ ...l, lineId: newId(), reservationId: newId() }));
      await c.query(
        `INSERT INTO orders (id, store_id, customer_id, status, version, correlation_id) VALUES ($1, $2, $3, 'reserved', 1, $4)`,
        [orderId, cmd.storeId, cmd.principalId, actor.correlationId],
      );
      await c.query(
        `INSERT INTO order_lines (id, order_id, line_no, sku, qty)
       SELECT id, $1, line_no, sku, qty FROM unnest($2::uuid[], $3::smallint[], $4::text[], $5::int[]) AS t(id, line_no, sku, qty)`,
        [
          orderId,
          lineRows.map((l) => l.lineId),
          lineRows.map((l) => l.lineNo),
          lineRows.map((l) => l.sku),
          lineRows.map((l) => l.qty),
        ],
      );
      await c.query(
        `INSERT INTO reservations (id, order_id, order_line_id, store_id, sku, qty, expires_at)
       SELECT id, $1, line_id, $2, sku, qty, $3 FROM unnest($4::uuid[], $5::uuid[], $6::text[], $7::int[]) AS t(id, line_id, sku, qty)`,
        [
          orderId,
          cmd.storeId,
          expiresAt,
          lineRows.map((l) => l.reservationId),
          lineRows.map((l) => l.lineId),
          lineRows.map((l) => l.sku),
          lineRows.map((l) => l.qty),
        ],
      );
      await appendLedger(
        c,
        lineRows.map((l) => ({
          storeId: cmd.storeId,
          sku: l.sku,
          movement: 'reserve' as const,
          deltaOnHand: 0,
          deltaReserved: l.qty,
          sourceType: 'reservation',
          sourceId: l.reservationId,
          actorId: actor.actorId,
          correlationId: actor.correlationId,
        })),
      );
      const responseLines = [...lineRows]
        .sort((a, b) => a.lineNo - b.lineNo)
        .map((l) => ({
          lineId: l.lineId,
          lineNo: l.lineNo,
          sku: l.sku,
          qty: l.qty,
          reservationId: l.reservationId,
        }));
      await enqueueEvents(c, [
        createEvent('order.placed', {
          aggregateId: orderId,
          aggregateVersion: 1,
          partitionKey: orderId,
          correlationId: actor.correlationId,
          payload: {
            orderId,
            storeId: cmd.storeId,
            customerId: cmd.principalId,
            lines: responseLines,
            reservationExpiresAt: expiresAt.toISOString(),
          },
        }),
        ...upd.rows.map((b) => balanceChangedEvent(b, 'reserve', actor.correlationId)),
      ]);

      const body = {
        orderId,
        storeId: cmd.storeId,
        status: 'reserved',
        lines: responseLines,
        reservationExpiresAt: expiresAt.toISOString(),
      };
      return record(c, cmd, 201, body, orderId);
    },
  );
}

async function record(
  c: PgClient,
  cmd: PlaceOrderCommand,
  statusCode: number,
  body: Record<string, unknown>,
  orderId: string | null,
): Promise<PlaceOrderResult> {
  await c.query(
    `UPDATE idempotency_keys SET status_code = $3, response_body = $4, resource_id = $5
      WHERE principal_id = $1 AND idempotency_key = $2`,
    [cmd.principalId, cmd.idempotencyKey, statusCode, JSON.stringify(body), orderId],
  );
  return { statusCode, body, replayed: false, orderId };
}

async function replay(c: PgClient, cmd: PlaceOrderCommand, requestHash: string): Promise<PlaceOrderResult> {
  // The conflicting row is committed (ON CONFLICT waited for the other transaction), so this read is final.
  const { rows } = await c.query<{
    operation: string;
    request_hash: string;
    status_code: number;
    response_body: Record<string, unknown>;
    resource_id: string | null;
  }>(
    `SELECT operation, request_hash, status_code, response_body, resource_id FROM idempotency_keys
      WHERE principal_id = $1 AND idempotency_key = $2`,
    [cmd.principalId, cmd.idempotencyKey],
  );
  const prior = rows[0];
  if (!prior) throw new AppError('INTERNAL', 'Idempotency record vanished during replay');
  if (prior.operation !== OPERATION || prior.request_hash !== requestHash) {
    throw new AppError('IDEMPOTENCY_KEY_REUSED', 'Idempotency-Key was already used with a different request');
  }
  return {
    statusCode: prior.status_code,
    body: prior.response_body,
    replayed: true,
    orderId: prior.resource_id,
  };
}
