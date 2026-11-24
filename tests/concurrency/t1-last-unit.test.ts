/**
 * T1 — last-unit race, ported from audit/prototypes/inventory-concurrency (where the naive read-then-write design
 * oversold 10 units as 465). Here the REAL AisleForge placeOrder() path is exercised.
 */
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

const POOL = 50;
const pool = makePool(POOL);
const ctx = makeCtx(pool);
const evidence: unknown[] = [];

beforeAll(async () => {
  await resetDatabase(pool);
});
afterAll(async () => {
  writeEvidence('phase1', 'T1-last-unit', { poolMax: POOL, runs: evidence });
  await pool.end();
});

describe('T1 last-unit race through placeOrder()', () => {
  it.each([
    { stock: 1, attempts: 200 },
    { stock: 10, attempts: 200 },
    { stock: 10, attempts: 500 },
  ])(
    'stock=$stock attempts=$attempts → exactly `stock` orders succeed, no oversell',
    async ({ stock, attempts }) => {
      await resetDatabase(pool);
      await seedStore(pool, 1);
      await seedStock(ctx, 1, { 'SKU-LAST': stock });
      const customers = await seedCustomers(pool, attempts);

      await warmPool(pool, POOL);
      expect(pool.totalCount).toBe(POOL); // the race window is real: all connections exist before the burst

      let peakWaiting = 0;
      const sampler = setInterval(() => (peakWaiting = Math.max(peakWaiting, pool.waitingCount)), 1);
      const t0 = performance.now();
      const results = await Promise.all(
        customers.map((c, i) =>
          placeOrder(
            ctx,
            {
              principalId: c,
              idempotencyKey: `t1-${stock}-${attempts}-${i}`,
              storeId: 1,
              lines: [{ sku: 'SKU-LAST', qty: 1 }],
            },
            { actorId: c, correlationId: `t1-${i}` },
          ),
        ),
      );
      const elapsedMs = performance.now() - t0;
      clearInterval(sampler);

      const outcomes = tally(results.map((r) => r.statusCode));
      const { rows } = await pool.query<{ reserved: number; on_hand: number; reservations: number }>(
        `SELECT b.reserved, b.on_hand, (SELECT count(*)::int FROM reservations) AS reservations FROM inventory_balances b`,
      );
      const inv = await invariants();
      evidence.push({
        stock,
        attempts,
        outcomes,
        final: rows[0],
        peakPoolWaiting: peakWaiting,
        elapsedMs: Math.round(elapsedMs),
        invariants: inv.map((r) => `${r.invariant}:${r.status}`),
      });

      expect(outcomes).toEqual({ 201: stock, 409: attempts - stock });
      expect(rows[0]).toEqual({ reserved: stock, on_hand: stock, reservations: stock });
      expect(peakWaiting).toBeGreaterThan(0); // requests genuinely contended for connections
      for (const r of inv) expect(r.status, r.invariant).toBe('PASS');
    },
  );
});
