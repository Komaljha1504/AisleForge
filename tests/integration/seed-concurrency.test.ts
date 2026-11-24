/**
 * Regression for the first kind deployment: every replica's migrate initContainer seeds the demo data at the same
 * time. The unlocked check-then-insert raced ("Balance already exists for store 1 / MILK-1L") and crash-looped pods.
 * Concurrent seeders must all succeed and produce exactly one opening balance (and one opening ledger row) per SKU.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedDemo } from '../../tools/seed/seed';
import { databaseUrl, invariants, makePool, resetDatabase, writeEvidence } from '../support/db';

const pool = makePool(4);
beforeAll(async () => resetDatabase(pool));
afterAll(async () => {
  await resetDatabase(pool);
  await pool.end();
});

describe('demo seed under concurrency (Kubernetes initContainers)', () => {
  it('concurrent seeders (6 per round, 5 rounds) all succeed and create each balance exactly once', async () => {
    const ROUNDS = 5;
    const SEEDERS = 6;
    const rounds: { rejected: string[]; balances: number; duplicates: number; openingLedgerRows: number }[] =
      [];
    for (let r = 0; r < ROUNDS; r++) {
      await resetDatabase(pool);
      const results = await Promise.allSettled(
        Array.from({ length: SEEDERS }, () => seedDemo(databaseUrl(), { password: 'concurrent-seed-pw-1' })),
      );
      const balances = await pool.query<{ n: string; dup: string }>(
        `SELECT count(*) AS n, count(*) - count(DISTINCT (store_id, sku)) AS dup FROM inventory_balances`,
      );
      const ledger = await pool.query<{ n: string }>(
        `SELECT count(*) AS n FROM inventory_ledger WHERE source_id LIKE 'seed-open-%'`,
      );
      rounds.push({
        rejected: results
          .filter((x) => x.status === 'rejected')
          .map((x) => String((x as PromiseRejectedResult).reason)),
        balances: Number(balances.rows[0]!.n),
        duplicates: Number(balances.rows[0]!.dup),
        openingLedgerRows: Number(ledger.rows[0]!.n),
      });
    }
    const users = await pool.query<{ n: string }>(`SELECT count(*) AS n FROM users`);
    const inv = await invariants(['I1', 'I2', 'I3', 'I4']);
    writeEvidence('phase9', 'seed-concurrency', {
      rounds: ROUNDS,
      seedersPerRound: SEEDERS,
      results: rounds,
      invariants: inv,
    });
    expect(rounds.flatMap((x) => x.rejected)).toEqual([]);
    for (const x of rounds) {
      expect(x.balances).toBe(24); // 2 stores × 12 SKUs
      expect(x.duplicates).toBe(0);
      expect(x.openingLedgerRows).toBe(24);
    }
    expect(Number(users.rows[0]!.n)).toBe(5);
    expect(inv.filter((r) => r.status !== 'PASS')).toEqual([]);
  });

  it('a second, sequential run is a no-op', async () => {
    await seedDemo(databaseUrl(), { password: 'concurrent-seed-pw-1' });
    const { rows } = await pool.query<{ n: string }>(`SELECT count(*) AS n FROM inventory_balances`);
    expect(Number(rows[0]!.n)).toBe(24);
  });
});
