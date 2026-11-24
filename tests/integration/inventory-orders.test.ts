import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  adjustStock,
  cancelOrder,
  confirmPick,
  expireDueReservations,
  expireReservation,
  placeOrder,
  releaseReservation,
  restock,
} from '@aisleforge/domain';
import { AppError } from '@aisleforge/shared';
import {
  invariants,
  makeCtx,
  makePool,
  resetDatabase,
  seedCustomers,
  seedStock,
  seedStore,
  SYSTEM_ACTOR,
} from '../support/db';

const pool = makePool(10);
const ctx = makeCtx(pool);
let customer: string;
let k = 0;
const key = () => `test-key-${++k}-${Date.now()}`;

beforeAll(async () => {
  await pool.query('SELECT 1');
});
afterAll(async () => {
  await pool.end();
});
beforeEach(async () => {
  await resetDatabase(pool);
  await seedStore(pool, 1);
  customer = (await seedCustomers(pool, 1))[0]!;
  await seedStock(ctx, 1, { 'SKU-A': 10, 'SKU-B': 5, 'SKU-C': 0 });
});

const order = (lines: { sku: string; qty: number }[], idem = key()) =>
  placeOrder(ctx, { principalId: customer!, idempotencyKey: idem, storeId: 1, lines }, SYSTEM_ACTOR);

async function balance(sku: string) {
  const { rows } = await pool.query<{ on_hand: number; reserved: number }>(
    'SELECT on_hand, reserved FROM inventory_balances WHERE store_id = 1 AND sku = $1',
    [sku],
  );
  return rows[0]!;
}
async function expectInvariantsHold() {
  for (const r of await invariants())
    expect(r, `${r.invariant}: ${JSON.stringify(r.sample)}`).toMatchObject({ status: 'PASS' });
}

describe('order placement', () => {
  it('reserves all lines atomically and records ledger + outbox in the same transaction', async () => {
    const r = await order([
      { sku: 'SKU-A', qty: 3 },
      { sku: 'SKU-B', qty: 2 },
    ]);
    expect(r.statusCode).toBe(201);
    expect(await balance('SKU-A')).toEqual({ on_hand: 10, reserved: 3 });
    expect(await balance('SKU-B')).toEqual({ on_hand: 5, reserved: 2 });
    const ledger = await pool.query(
      `SELECT movement, count(*)::int AS n FROM inventory_ledger GROUP BY 1 ORDER BY 1`,
    );
    expect(ledger.rows).toEqual([
      { movement: 'opening', n: 3 },
      { movement: 'reserve', n: 2 },
    ]);
    const outbox = await pool.query(
      `SELECT event_type, count(*)::int AS n FROM outbox WHERE event_type <> 'inventory.balance_changed' OR payload->>'movement' = 'reserve' GROUP BY 1 ORDER BY 1`,
    );
    expect(outbox.rows).toEqual([
      { event_type: 'inventory.balance_changed', n: 2 },
      { event_type: 'order.placed', n: 1 },
    ]);
    await expectInvariantsHold();
  });

  it('is all-or-nothing: one short line reserves nothing and returns 409 with shortages', async () => {
    const r = await order([
      { sku: 'SKU-A', qty: 3 },
      { sku: 'SKU-B', qty: 6 },
    ]);
    expect(r.statusCode).toBe(409);
    expect(r.body).toMatchObject({
      error: {
        code: 'INSUFFICIENT_STOCK',
        details: { shortages: [{ sku: 'SKU-B', requested: 6, available: 5 }] },
      },
    });
    expect(await balance('SKU-A')).toEqual({ on_hand: 10, reserved: 0 });
    expect((await pool.query('SELECT count(*)::int AS n FROM orders')).rows[0].n).toBe(0);
    expect(
      (await pool.query('SELECT count(*)::int AS n FROM outbox WHERE event_type = $1', ['order.placed']))
        .rows[0].n,
    ).toBe(0);
    await expectInvariantsHold();
  });

  it('returns 422 UNKNOWN_SKU for SKUs not stocked in the store', async () => {
    const r = await order([
      { sku: 'SKU-A', qty: 1 },
      { sku: 'NOPE', qty: 1 },
    ]);
    expect(r.statusCode).toBe(422);
    expect(r.body).toMatchObject({ error: { code: 'UNKNOWN_SKU', details: { skus: ['NOPE'] } } });
  });

  it('replays a recorded business failure for the same key (no re-evaluation after restock)', async () => {
    const idem = key();
    const first = await order([{ sku: 'SKU-C', qty: 1 }], idem);
    expect(first.statusCode).toBe(409);
    await restock(ctx, { storeId: 1, sku: 'SKU-C', qty: 5, sourceId: 'grn-1' }, SYSTEM_ACTOR);
    const again = await order([{ sku: 'SKU-C', qty: 1 }], idem);
    expect(again).toMatchObject({ statusCode: 409, replayed: true });
    const fresh = await order([{ sku: 'SKU-C', qty: 1 }]);
    expect(fresh.statusCode).toBe(201);
  });

  it('rejects an idempotency key reused with a different payload', async () => {
    const idem = key();
    await order([{ sku: 'SKU-A', qty: 1 }], idem);
    await expect(order([{ sku: 'SKU-A', qty: 2 }], idem)).rejects.toMatchObject({
      code: 'IDEMPOTENCY_KEY_REUSED',
    });
  });

  it('scopes idempotency keys to the principal', async () => {
    const [other] = await seedCustomers(pool, 1);
    const idem = key();
    const a = await order([{ sku: 'SKU-A', qty: 1 }], idem);
    const b = await placeOrder(
      ctx,
      { principalId: other!, idempotencyKey: idem, storeId: 1, lines: [{ sku: 'SKU-A', qty: 1 }] },
      SYSTEM_ACTOR,
    );
    expect(a.statusCode).toBe(201);
    expect(b).toMatchObject({ statusCode: 201, replayed: false });
    expect(b.orderId).not.toEqual(a.orderId);
  });
});

describe('reservation state machine', () => {
  async function oneReservation(qty = 2) {
    const r = await order([{ sku: 'SKU-A', qty }]);
    const res = await pool.query<{ id: string }>('SELECT id FROM reservations WHERE order_id = $1', [
      r.orderId,
    ]);
    return { orderId: r.orderId!, reservationId: res.rows[0]!.id };
  }

  it('release returns quantity to available exactly once', async () => {
    const { reservationId } = await oneReservation();
    const a = await releaseReservation(ctx, { reservationId, reason: 'manual' }, SYSTEM_ACTOR);
    const b = await releaseReservation(ctx, { reservationId, reason: 'manual' }, SYSTEM_ACTOR);
    expect(a.transitioned).toBe(true);
    expect(b).toMatchObject({ transitioned: false, currentStatus: 'released' });
    expect(await balance('SKU-A')).toEqual({ on_hand: 10, reserved: 0 });
    await expectInvariantsHold();
  });

  it('expiry only applies once expires_at has passed', async () => {
    const { reservationId } = await oneReservation();
    expect((await expireReservation(ctx, { reservationId }, SYSTEM_ACTOR)).transitioned).toBe(false);
    await pool.query(`UPDATE reservations SET expires_at = now() - interval '1 second' WHERE id = $1`, [
      reservationId,
    ]);
    const sweep = await expireDueReservations(ctx, { limit: 10 }, SYSTEM_ACTOR);
    expect(sweep).toEqual({ scanned: 1, expired: 1 });
    expect(await balance('SKU-A')).toEqual({ on_hand: 10, reserved: 0 });
    await expectInvariantsHold();
  });

  it('full pick decrements on_hand and reserved and moves the order to picked', async () => {
    const { orderId, reservationId } = await oneReservation(2);
    const out = await confirmPick(ctx, { reservationId, pickedQty: 2 }, SYSTEM_ACTOR);
    expect(out).toMatchObject({ transitioned: true, pickedQty: 2, shortQty: 0 });
    expect(await balance('SKU-A')).toEqual({ on_hand: 8, reserved: 0 });
    expect((await pool.query('SELECT status FROM orders WHERE id = $1', [orderId])).rows[0].status).toBe(
      'picked',
    );
    await expectInvariantsHold();
  });

  it('short pick is first-class: recorded separately and removed from on_hand pending recount', async () => {
    const { reservationId } = await oneReservation(3);
    const out = await confirmPick(ctx, { reservationId, pickedQty: 1 }, SYSTEM_ACTOR);
    expect(out).toMatchObject({ pickedQty: 1, shortQty: 2 });
    expect(await balance('SKU-A')).toEqual({ on_hand: 7, reserved: 0 });
    const mv = await pool.query(
      `SELECT movement, delta_on_hand FROM inventory_ledger WHERE source_id = $1 ORDER BY movement::text`,
      [reservationId],
    );
    expect(mv.rows).toEqual([
      { movement: 'pick', delta_on_hand: -1 },
      { movement: 'reserve', delta_on_hand: 0 },
      { movement: 'short_pick', delta_on_hand: -2 },
    ]);
    await expectInvariantsHold();
  });

  it('rejects pickedQty outside [0, qty] without changing state', async () => {
    const { reservationId } = await oneReservation(2);
    await expect(confirmPick(ctx, { reservationId, pickedQty: 3 }, SYSTEM_ACTOR)).rejects.toBeInstanceOf(
      AppError,
    );
    expect(await balance('SKU-A')).toEqual({ on_hand: 10, reserved: 2 });
  });

  it('cancel releases active reservations; cancelled orders cannot be cancelled again', async () => {
    const r = await order([
      { sku: 'SKU-A', qty: 2 },
      { sku: 'SKU-B', qty: 1 },
    ]);
    const c = await cancelOrder(ctx, { orderId: r.orderId!, reason: 'customer_request' }, SYSTEM_ACTOR);
    expect(c.released).toBe(2);
    expect(await balance('SKU-A')).toEqual({ on_hand: 10, reserved: 0 });
    await expect(
      cancelOrder(ctx, { orderId: r.orderId!, reason: 'again' }, SYSTEM_ACTOR),
    ).rejects.toMatchObject({ code: 'INVALID_STATE_TRANSITION' });
    await expectInvariantsHold();
  });
});

describe('stock movements', () => {
  it('restock is idempotent per source id', async () => {
    const a = await restock(ctx, { storeId: 1, sku: 'SKU-B', qty: 4, sourceId: 'grn-7' }, SYSTEM_ACTOR);
    const b = await restock(ctx, { storeId: 1, sku: 'SKU-B', qty: 4, sourceId: 'grn-7' }, SYSTEM_ACTOR);
    expect([a.applied, b.applied]).toEqual([true, false]);
    expect(await balance('SKU-B')).toEqual({ on_hand: 9, reserved: 0 });
    await expectInvariantsHold();
  });

  it('restock/adjust of a balance that does not exist is a typed NOT_FOUND, not a raw SQL error', async () => {
    await expect(
      restock(ctx, { storeId: 1, sku: 'SKU-ZZZ', qty: 1, sourceId: 'grn-x' }, SYSTEM_ACTOR),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      adjustStock(
        ctx,
        { storeId: 1, sku: 'SKU-ZZZ', delta: 1, sourceId: 'adj-x', reason: 'x' },
        SYSTEM_ACTOR,
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('adjustment cannot drop on_hand below reserved', async () => {
    await order([{ sku: 'SKU-B', qty: 4 }]);
    await expect(
      adjustStock(
        ctx,
        { storeId: 1, sku: 'SKU-B', delta: -2, sourceId: 'adj-1', reason: 'damaged' },
        SYSTEM_ACTOR,
      ),
    ).rejects.toMatchObject({ code: 'ADJUSTMENT_BELOW_RESERVED' });
    const ok = await adjustStock(
      ctx,
      { storeId: 1, sku: 'SKU-B', delta: -1, sourceId: 'adj-2', reason: 'damaged' },
      SYSTEM_ACTOR,
    );
    expect(ok.applied).toBe(true);
    expect(await balance('SKU-B')).toEqual({ on_hand: 4, reserved: 4 });
    await expectInvariantsHold();
  });
});

describe('database-level defences (last line, independent of application code)', () => {
  it('CHECK constraint rejects over-reservation even from raw SQL', async () => {
    await expect(
      pool.query(`UPDATE inventory_balances SET reserved = on_hand + 1 WHERE sku = 'SKU-A'`),
    ).rejects.toMatchObject({ code: '23514' });
  });
  it('ledger is append-only', async () => {
    await expect(pool.query(`UPDATE inventory_ledger SET delta_on_hand = 999`)).rejects.toMatchObject({
      code: '23001',
    });
    await expect(pool.query(`DELETE FROM inventory_ledger`)).rejects.toMatchObject({ code: '23001' });
  });
  it('ledger movement shape is enforced', async () => {
    await expect(
      pool.query(
        `INSERT INTO inventory_ledger (store_id, sku, movement, delta_on_hand, delta_reserved, source_type, source_id)
       VALUES (1, 'SKU-A', 'reserve', -1, 1, 'x', 'y')`,
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });
});
