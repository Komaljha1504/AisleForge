import type { PgPool } from '@aisleforge/database';
import { AppError, isUuid } from '@aisleforge/shared';
import type { Principal } from '../identity/authorization';

/**
 * Object-level authorization is part of the query (OWASP API1 / BOLA): a principal can only ever SELECT rows in its
 * scope. Customers: their own orders. Pickers/supervisors: their store's orders. Admins: all.
 * Out-of-scope rows are indistinguishable from non-existent ones (404, no enumeration).
 */
const scopeSql = (role: number, user: number, store: number): string => `(
  $${role}::text = 'admin'
  OR ($${role}::text = 'customer' AND o.customer_id = $${user}::uuid)
  OR ($${role}::text IN ('picker', 'supervisor') AND o.store_id = $${store}::int)
)`;

export interface OrderView {
  id: string;
  storeId: number;
  customerId: string;
  status: string;
  version: number;
  createdAt: string;
  lines: {
    lineNo: number;
    sku: string;
    qty: number;
    pickedQty: number;
    shortQty: number;
    reservationStatus: string | null;
  }[];
}

export async function getOrderForPrincipal(
  pool: PgPool,
  p: Principal,
  orderId: string,
): Promise<OrderView | null> {
  const { rows } = await pool.query<{
    id: string;
    store_id: number;
    customer_id: string;
    status: string;
    version: number;
    created_at: Date;
    lines: OrderView['lines'];
  }>(
    `SELECT o.id, o.store_id, o.customer_id, o.status, o.version, o.created_at,
            COALESCE((SELECT jsonb_agg(jsonb_build_object('lineNo', l.line_no, 'sku', l.sku, 'qty', l.qty,
                        'pickedQty', l.picked_qty, 'shortQty', l.short_qty, 'reservationStatus', r.status) ORDER BY l.line_no)
                      FROM order_lines l LEFT JOIN reservations r ON r.order_line_id = l.id
                     WHERE l.order_id = o.id), '[]'::jsonb) AS lines
       FROM orders o
      WHERE o.id = $1 AND ${scopeSql(2, 3, 4)}`,
    [orderId, p.role, p.userId, p.storeId],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    id: r.id,
    storeId: r.store_id,
    customerId: r.customer_id,
    status: r.status,
    version: r.version,
    createdAt: r.created_at.toISOString(),
    lines: r.lines,
  };
}

/** Keyset pagination (created_at DESC, id DESC) — stable under concurrent inserts, no OFFSET scans. */
export async function listOrdersForPrincipal(
  pool: PgPool,
  p: Principal,
  opts: { limit: number; cursor?: string | undefined },
): Promise<{ items: Omit<OrderView, 'lines'>[]; nextCursor: string | null }> {
  let after: { t: string; id: string } | null = null;
  if (opts.cursor) {
    try {
      after = JSON.parse(Buffer.from(opts.cursor, 'base64url').toString('utf8')) as { t: string; id: string };
      const validTime =
        typeof after?.t === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/.test(after.t);
      if (!validTime || typeof after?.id !== 'string' || !isUuid(after.id)) throw new Error('bad cursor');
    } catch (e) {
      throw new AppError('VALIDATION_FAILED', 'Invalid cursor', { cause: e });
    }
  }
  const { rows } = await pool.query<{
    id: string;
    store_id: number;
    customer_id: string;
    status: string;
    version: number;
    created_at: Date;
  }>(
    `SELECT o.id, o.store_id, o.customer_id, o.status, o.version, o.created_at FROM orders o
      WHERE ${scopeSql(1, 2, 3)}
        AND ($4::timestamptz IS NULL OR (o.created_at, o.id) < ($4::timestamptz, $5::uuid))
      ORDER BY o.created_at DESC, o.id DESC LIMIT $6`,
    [p.role, p.userId, p.storeId, after?.t ?? null, after?.id ?? null, opts.limit + 1],
  );
  const page = rows.slice(0, opts.limit);
  const last = page[page.length - 1];
  return {
    items: page.map((r) => ({
      id: r.id,
      storeId: r.store_id,
      customerId: r.customer_id,
      status: r.status,
      version: r.version,
      createdAt: r.created_at.toISOString(),
    })),
    nextCursor:
      rows.length > opts.limit && last
        ? Buffer.from(JSON.stringify({ t: last.created_at.toISOString(), id: last.id })).toString('base64url')
        : null,
  };
}

export async function getBalance(pool: PgPool, storeId: number, sku: string) {
  const { rows } = await pool.query<{
    store_id: number;
    sku: string;
    on_hand: number;
    reserved: number;
    version: number;
    updated_at: Date;
  }>(
    'SELECT store_id, sku, on_hand, reserved, version, updated_at FROM inventory_balances WHERE store_id = $1 AND sku = $2',
    [storeId, sku],
  );
  const b = rows[0];
  return b
    ? {
        storeId: b.store_id,
        sku: b.sku,
        onHand: b.on_hand,
        reserved: b.reserved,
        available: b.on_hand - b.reserved,
        version: b.version,
        updatedAt: b.updated_at.toISOString(),
      }
    : null;
}
