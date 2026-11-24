/**
 * T4 — concurrent multi-line orders over a small set of hot SKUs. The audit prototype collapsed to 0.4 orders/s with
 * 172 deadlocks when lines were locked in request order. AisleForge's placeOrder() locks in (store_id, sku) order.
 *
 * Includes a NEGATIVE CONTROL: the same harness locking in arbitrary order must observe deadlocks, proving the
 * test is capable of detecting the failure it guards against.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getTxStats, resetTxStats } from '@aisleforge/database';
import { placeOrder } from '@aisleforge/domain';
import {
  deadlockCount,
  invariants,
  makeCtx,
  makePool,
  pct,
  resetDatabase,
  seedCustomers,
  seedStock,
  seedStore,
  tally,
  warmPool,
  writeEvidence,
} from '../support/db';

const HOT = 20;
const skus = Array.from({ length: HOT }, (_, i) => `HOT-${String(i).padStart(2, '0')}`);
const pool = makePool(50);
const ctx = makeCtx(pool);
let customers: string[];

function randomLines(rng: () => number, n = 5) {
  const set = new Set<string>();
  while (set.size < n) set.add(skus[Math.floor(rng() * HOT)]!);
  return [...set].map((sku) => ({ sku, qty: 1 })); // deliberately NOT sorted: the domain must sort
}
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

beforeAll(async () => {
  await resetDatabase(pool);
  await seedStore(pool, 1);
  await seedStock(ctx, 1, Object.fromEntries(skus.map((s) => [s, 1_000_000])));
  customers = await seedCustomers(pool, 100);
  await warmPool(pool, 50);
});
afterAll(async () => {
  await pool.end();
});

describe('T4 multi-line deadlock prevention', () => {
  it('1000 orders × 5 lines over 20 hot SKUs at concurrency 100: zero deadlocks, all committed', async () => {
    const rng = mulberry32(4242);
    const orders = Array.from({ length: 1000 }, () => randomLines(rng));
    resetTxStats();
    const before = await deadlockCount(pool);
    const lat: number[] = [];
    const codes: number[] = [];
    let next = 0;
    const t0 = performance.now();
    await Promise.all(
      Array.from({ length: 100 }, async (_, w) => {
        while (next < orders.length) {
          const i = next++;
          const s = performance.now();
          const r = await placeOrder(
            ctx,
            {
              principalId: customers[w]!,
              idempotencyKey: `t4-order-${String(i).padStart(4, '0')}`,
              storeId: 1,
              lines: orders[i]!,
            },
            { actorId: null, correlationId: `t4-${i}` },
          );
          lat.push(performance.now() - s);
          codes.push(r.statusCode);
        }
      }),
    );
    const sec = (performance.now() - t0) / 1000;
    const deadlocks = (await deadlockCount(pool)) - before;
    const stats = getTxStats()['orders.place'];
    const inv = await invariants();
    writeEvidence('phase1', 'T4-sorted-lock-order', {
      orders: 1000,
      linesPerOrder: 5,
      hotSkus: HOT,
      concurrency: 100,
      poolMax: 50,
      outcomes: tally(codes),
      deadlocksDetected: deadlocks,
      transientRetries: stats?.retries ?? {},
      committedOrdersPerSec: Math.round((codes.filter((c) => c === 201).length / sec) * 10) / 10,
      latencyMs: { p50: pct(lat, 50), p95: pct(lat, 95), p99: pct(lat, 99), max: pct(lat, 100) },
      invariants: inv.map((r) => `${r.invariant}:${r.status}`),
    });

    expect(deadlocks).toBe(0);
    expect(stats?.retries['40P01'] ?? 0).toBe(0);
    expect(tally(codes)).toEqual({ 201: 1000 });
    for (const r of inv) expect(r.status, r.invariant).toBe('PASS');
  });

  it('NEGATIVE CONTROL: arbitrary lock order with the same harness does deadlock', async () => {
    const rng = mulberry32(99);
    const before = await deadlockCount(pool);
    let next = 0;
    const N = 150;
    const outcomes: string[] = [];
    const deadline = performance.now() + 45_000;
    await Promise.all(
      Array.from({ length: 40 }, async () => {
        while (next < N && performance.now() < deadline) {
          next++;
          const lines = randomLines(rng);
          const c = await pool.connect();
          try {
            await c.query('BEGIN');
            for (const l of lines) {
              await c.query(
                `UPDATE inventory_balances SET reserved = reserved + 1 WHERE store_id = 1 AND sku = $1 AND on_hand - reserved >= 1`,
                [l.sku],
              );
            }
            await c.query('ROLLBACK'); // control only: leave no state behind
            outcomes.push('ok');
          } catch (e) {
            await c.query('ROLLBACK');
            outcomes.push((e as { code?: string }).code ?? 'error');
          } finally {
            c.release();
          }
        }
      }),
    );
    const deadlocks = (await deadlockCount(pool)) - before;
    writeEvidence('phase1', 'T4-negative-control-arbitrary-order', {
      attempted: outcomes.length,
      outcomes: tally(outcomes),
      deadlocksDetected: deadlocks,
    });
    expect(deadlocks).toBeGreaterThan(0);
  });
});
