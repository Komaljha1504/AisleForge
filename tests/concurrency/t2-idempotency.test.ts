/** T2 — 100 concurrent duplicate submissions with one (principal, Idempotency-Key). */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { placeOrder } from '@aisleforge/domain';
import {
  invariants,
  makeCtx,
  makePool,
  resetDatabase,
  seedCustomers,
  seedStock,
  seedStore,
  tally,
  warmPool,
  writeEvidence,
} from '../support/db';

const pool = makePool(50);
const ctx = makeCtx(pool);
let customer: string;

beforeAll(async () => {
  await resetDatabase(pool);
  await seedStore(pool, 1);
  await seedStock(ctx, 1, { 'SKU-A': 1000, 'SKU-B': 1000 });
  customer = (await seedCustomers(pool, 1))[0]!;
  await warmPool(pool, 50);
});
afterAll(async () => {
  await pool.end();
});

describe('T2 idempotency under concurrency', () => {
  it('100 concurrent identical requests create exactly one order and all callers get the original response', async () => {
    const key = 'order-key-0001';
    // Same logical request; half the callers send lines in a different order (must hash identically).
    const linesA = [
      { sku: 'SKU-A', qty: 2 },
      { sku: 'SKU-B', qty: 1 },
    ];
    const linesB = [
      { sku: 'SKU-B', qty: 1 },
      { sku: 'SKU-A', qty: 2 },
    ];
    const results = await Promise.all(
      Array.from({ length: 100 }, (_, i) =>
        placeOrder(
          ctx,
          { principalId: customer!, idempotencyKey: key, storeId: 1, lines: i % 2 ? linesA : linesB },
          { actorId: customer!, correlationId: `t2-${i}` },
        ),
      ),
    );
    const orderIds = new Set(results.map((r) => r.orderId));
    const counts = (
      await pool.query(
        `SELECT (SELECT count(*)::int FROM orders) AS orders, (SELECT count(*)::int FROM reservations) AS reservations,
              (SELECT count(*)::int FROM outbox WHERE event_type = 'order.placed') AS order_events,
              (SELECT reserved FROM inventory_balances WHERE sku = 'SKU-A') AS reserved_a`,
      )
    ).rows[0];
    const inv = await invariants();
    writeEvidence('phase1', 'T2-idempotency', {
      concurrentRequests: 100,
      statusCodes: tally(results.map((r) => r.statusCode)),
      replayed: tally(results.map((r) => String(r.replayed))),
      distinctOrderIds: orderIds.size,
      db: counts,
      invariants: inv.map((r) => `${r.invariant}:${r.status}`),
    });

    expect(results.every((r) => r.statusCode === 201)).toBe(true);
    expect(orderIds.size).toBe(1);
    expect(results.filter((r) => !r.replayed)).toHaveLength(1);
    expect(counts).toEqual({ orders: 1, reservations: 2, order_events: 1, reserved_a: 2 });
    for (const r of inv) expect(r.status, r.invariant).toBe('PASS');
  });

  it('the same key with a different payload is rejected, concurrently and after the fact', async () => {
    const key = 'order-key-0002';
    const settled = await Promise.allSettled(
      Array.from({ length: 20 }, (_, i) =>
        placeOrder(
          ctx,
          {
            principalId: customer!,
            idempotencyKey: key,
            storeId: 1,
            lines: [{ sku: 'SKU-A', qty: i % 2 ? 1 : 3 }],
          },
          { actorId: null, correlationId: null },
        ),
      ),
    );
    const ok = settled.filter((s) => s.status === 'fulfilled');
    const rejected = settled.filter((s): s is PromiseRejectedResult => s.status === 'rejected');
    // Whichever payload won the key, every request with the other payload is rejected; same-payload ones replay.
    expect(ok.length).toBe(10);
    expect(rejected.length).toBe(10);
    expect(rejected.every((r) => (r.reason as { code?: string }).code === 'IDEMPOTENCY_KEY_REUSED')).toBe(
      true,
    );
    expect(
      (await pool.query(`SELECT count(*)::int AS n FROM idempotency_keys WHERE idempotency_key = $1`, [key]))
        .rows[0].n,
    ).toBe(1);
  });
});
