/**
 * Property-based test: random sequences of reserve / cancel / release / expire / pick (incl. short pick) / restock /
 * adjust, executed in small concurrent groups (real interleavings on real PostgreSQL). After every sequence the
 * global invariants I1–I4 must hold. Business rejections (insufficient stock, invalid transition, ...) are
 * expected; any non-business error fails the property. Reproducible: FC_SEED overrides the fixed seed.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  adjustStock,
  cancelOrder,
  confirmPick,
  expireReservation,
  placeOrder,
  releaseReservation,
  restock,
} from '@aisleforge/domain';
import { isAppError } from '@aisleforge/shared';
import {
  invariants,
  makeCtx,
  makePool,
  resetDatabase,
  seedCustomers,
  seedStock,
  seedStore,
  writeEvidence,
} from '../support/db';

const SEED = Number(process.env.FC_SEED ?? 20261121);
const RUNS = Number(process.env.FC_RUNS ?? 100);
const SKUS = ['P-1', 'P-2', 'P-3'] as const;
const pool = makePool(15);
const ctx = makeCtx(pool);

type Cmd =
  | { t: 'place'; cust: number; key: number; lines: { sku: string; qty: number }[] }
  | { t: 'cancel'; order: number }
  | { t: 'release'; res: number }
  | { t: 'expire'; res: number }
  | { t: 'pick'; res: number; frac: number }
  | { t: 'restock'; sku: string; qty: number; src: number }
  | { t: 'adjust'; sku: string; delta: number; src: number };

const skuArb = fc.constantFrom(...SKUS);
const cmdArb: fc.Arbitrary<Cmd> = fc.oneof(
  {
    weight: 4,
    arbitrary: fc.record({
      t: fc.constant('place' as const),
      cust: fc.nat(2),
      key: fc.nat(7),
      lines: fc.uniqueArray(fc.record({ sku: skuArb, qty: fc.integer({ min: 1, max: 3 }) }), {
        selector: (l) => l.sku,
        minLength: 1,
        maxLength: 3,
      }),
    }),
  },
  { weight: 1, arbitrary: fc.record({ t: fc.constant('cancel' as const), order: fc.nat(20) }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant('release' as const), res: fc.nat(40) }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant('expire' as const), res: fc.nat(40) }) },
  {
    weight: 2,
    arbitrary: fc.record({
      t: fc.constant('pick' as const),
      res: fc.nat(40),
      frac: fc.double({ min: 0, max: 1, noNaN: true }),
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      t: fc.constant('restock' as const),
      sku: skuArb,
      qty: fc.integer({ min: 1, max: 4 }),
      src: fc.nat(3),
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      t: fc.constant('adjust' as const),
      sku: skuArb,
      delta: fc.integer({ min: -3, max: 3 }).filter((d) => d !== 0),
      src: fc.nat(3),
    }),
  },
);
const programArb = fc.record({
  opening: fc.tuple(fc.nat(12), fc.nat(12), fc.nat(12)),
  groups: fc.array(fc.array(cmdArb, { minLength: 1, maxLength: 3 }), { minLength: 1, maxLength: 25 }),
});

let runs = 0;
let opsExecuted = 0;
const outcomeCounts: Record<string, number> = {};

beforeAll(async () => {
  await pool.query('SELECT 1');
});
afterAll(async () => {
  writeEvidence('phase1', 'property-inventory', {
    seed: SEED,
    numRuns: RUNS,
    runsExecuted: runs,
    opsExecuted,
    outcomeCounts,
  });
  await pool.end();
});

async function execute(cmd: Cmd, customers: string[], run: number): Promise<string> {
  const actor = { actorId: null, correlationId: `prop-${run}` };
  const pick = async (n: number, table: 'orders' | 'reservations') => {
    const { rows } = await pool.query<{ id: string }>(`SELECT id FROM ${table} ORDER BY created_at, id`);
    return rows.length ? rows[n % rows.length]!.id : null;
  };
  switch (cmd.t) {
    case 'place': {
      const r = await placeOrder(
        ctx,
        {
          principalId: customers[cmd.cust]!,
          idempotencyKey: `prop-key-${cmd.key}`,
          storeId: 1,
          lines: cmd.lines,
        },
        actor,
      );
      return `place:${r.statusCode}${r.replayed ? ':replay' : ''}`;
    }
    case 'cancel': {
      const id = await pick(cmd.order, 'orders');
      if (!id) return 'cancel:none';
      await cancelOrder(ctx, { orderId: id, reason: 'prop' }, actor);
      return 'cancel:ok';
    }
    case 'release': {
      const id = await pick(cmd.res, 'reservations');
      if (!id) return 'release:none';
      return `release:${(await releaseReservation(ctx, { reservationId: id, reason: 'prop' }, actor)).transitioned}`;
    }
    case 'expire': {
      const id = await pick(cmd.res, 'reservations');
      if (!id) return 'expire:none';
      await pool.query(
        `UPDATE reservations SET expires_at = now() - interval '1 second' WHERE id = $1 AND status = 'active'`,
        [id],
      );
      return `expire:${(await expireReservation(ctx, { reservationId: id }, actor)).transitioned}`;
    }
    case 'pick': {
      const id = await pick(cmd.res, 'reservations');
      if (!id) return 'pick:none';
      const q = (await pool.query<{ qty: number }>('SELECT qty FROM reservations WHERE id = $1', [id]))
        .rows[0]!.qty;
      return `pick:${(await confirmPick(ctx, { reservationId: id, pickedQty: Math.floor(cmd.frac * q) }, actor)).transitioned}`;
    }
    case 'restock':
      return `restock:${(await restock(ctx, { storeId: 1, sku: cmd.sku, qty: cmd.qty, sourceId: `grn-${cmd.src}` }, actor)).applied}`;
    case 'adjust':
      return `adjust:${(await adjustStock(ctx, { storeId: 1, sku: cmd.sku, delta: cmd.delta, sourceId: `adj-${cmd.src}`, reason: 'prop' }, actor)).applied}`;
  }
}

describe('property: inventory invariants survive arbitrary concurrent operation sequences', () => {
  it(`holds for ${RUNS} random programs (seed ${SEED})`, async () => {
    await fc.assert(
      fc.asyncProperty(programArb, async ({ opening, groups }) => {
        const run = ++runs;
        await resetDatabase(pool);
        await seedStore(pool, 1);
        await seedStock(ctx, 1, { 'P-1': opening[0], 'P-2': opening[1], 'P-3': opening[2] });
        const customers = await seedCustomers(pool, 3);
        for (const group of groups) {
          const settled = await Promise.allSettled(group.map((c) => execute(c, customers, run)));
          for (const s of settled) {
            opsExecuted++;
            const label =
              s.status === 'fulfilled'
                ? s.value
                : isAppError(s.reason)
                  ? `rejected:${s.reason.code}`
                  : 'UNEXPECTED';
            outcomeCounts[label] = (outcomeCounts[label] ?? 0) + 1;
            if (s.status === 'rejected' && !isAppError(s.reason)) throw s.reason; // non-business error = bug
          }
        }
        const failed = (await invariants()).filter((r) => r.status !== 'PASS');
        if (failed.length) throw new Error(`invariants failed: ${JSON.stringify(failed)}`);
      }),
      { seed: SEED, numRuns: RUNS, endOnFailure: true },
    );
    expect(runs).toBeGreaterThanOrEqual(RUNS);
  });
});
