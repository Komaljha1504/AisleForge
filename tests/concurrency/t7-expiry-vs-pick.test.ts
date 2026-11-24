/**
 * T7 — the reservation TTL sweep races a picker confirming the same reservation. In the audit prototype the
 * read-then-update variant double-applied in 497/500 races. Exactly one compare-and-set transition may win.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { confirmPick, expireReservation, placeOrder } from '@aisleforge/domain';
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

const TRIALS = 300;
const pool = makePool(40);
const ctx = makeCtx(pool);
const actor = { actorId: null, correlationId: 't7' };

beforeAll(async () => {
  await resetDatabase(pool);
  await seedStore(pool, 1);
  await seedStock(ctx, 1, Object.fromEntries(Array.from({ length: TRIALS }, (_, i) => [`T7-${i}`, 10])));
  await warmPool(pool, 40);
});
afterAll(async () => {
  await pool.end();
});

describe('T7 expiry vs pick confirmation', () => {
  it(`${TRIALS} races: exactly one transition wins each, never a double decrement`, async () => {
    const [customer] = await seedCustomers(pool, 1);
    const reservationIds: string[] = [];
    for (let i = 0; i < TRIALS; i++) {
      const r = await placeOrder(
        ctx,
        {
          principalId: customer!,
          idempotencyKey: `t7-order-${i}`,
          storeId: 1,
          lines: [{ sku: `T7-${i}`, qty: 2 }],
        },
        actor,
      );
      const res = await pool.query<{ id: string }>('SELECT id FROM reservations WHERE order_id = $1', [
        r.orderId,
      ]);
      reservationIds.push(res.rows[0]!.id);
    }
    // Every reservation is already due for expiry, so both operations are individually valid.
    await pool.query(`UPDATE reservations SET expires_at = now() - interval '1 second'`);

    const winners: string[] = [];
    const anomalies: unknown[] = [];
    const BATCH = 10; // 10 races in flight at once (20 concurrent transactions)
    for (let b = 0; b < TRIALS; b += BATCH) {
      await Promise.all(
        reservationIds.slice(b, b + BATCH).map(async (reservationId, j) => {
          const i = b + j;
          const [exp, pick] = await Promise.all([
            expireReservation(ctx, { reservationId }, actor),
            confirmPick(ctx, { reservationId, pickedQty: 2 }, actor),
          ]);
          const wins = Number(exp.transitioned) + Number(pick.transitioned);
          const bal = (
            await pool.query<{ on_hand: number; reserved: number }>(
              `SELECT on_hand, reserved FROM inventory_balances WHERE sku = $1`,
              [`T7-${i}`],
            )
          ).rows[0]!;
          const expected = exp.transitioned ? { on_hand: 10, reserved: 0 } : { on_hand: 8, reserved: 0 };
          if (wins !== 1 || bal.on_hand !== expected.on_hand || bal.reserved !== 0)
            anomalies.push({ i, wins, bal });
          winners.push(exp.transitioned ? 'expire' : pick.transitioned ? 'pick' : 'none');
        }),
      );
    }
    const inv = await invariants();
    writeEvidence('phase1', 'T7-expiry-vs-pick', {
      trials: TRIALS,
      winners: tally(winners),
      anomalies: anomalies.length,
      sample: anomalies.slice(0, 5),
      invariants: inv.map((r) => `${r.invariant}:${r.status}`),
    });

    expect(anomalies).toEqual([]);
    // Sensitivity: both interleavings actually occurred, so the race was exercised in both directions.
    expect(tally(winners).expire ?? 0).toBeGreaterThan(0);
    expect(tally(winners).pick ?? 0).toBeGreaterThan(0);
    for (const r of inv) expect(r.status, r.invariant).toBe('PASS');
  });
});
