import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { inject } from 'vitest';
import { checkInvariants, type InvariantRow, type PgPool } from '@aisleforge/database';
import { defaultDomainConfig, openBalance, type DomainContext, type DomainConfig } from '@aisleforge/domain';
import { newId } from '@aisleforge/shared';

export const databaseUrl = (): string => inject('databaseUrl');

export function makePool(max: number, extra: Partial<pg.PoolConfig> = {}): PgPool {
  return new pg.Pool({
    connectionString: databaseUrl(),
    max,
    connectionTimeoutMillis: 30_000,
    statement_timeout: 30_000,
    lock_timeout: 10_000,
    idle_in_transaction_session_timeout: 30_000,
    ...extra,
  });
}

export const makeCtx = (pool: PgPool, config: Partial<DomainConfig> = {}): DomainContext => ({
  pool,
  config: { ...defaultDomainConfig, ...config },
});

export const SYSTEM_ACTOR = { actorId: null, correlationId: 'test' };

/**
 * Opens exactly `n` connections so a burst test measures contention, not connection setup (audit T1 lesson).
 * All `n` clients are checked out at the same time and only released once every one exists. (The earlier version
 * ran `n` short queries and relied on connection setup being faster than the query; when PostgreSQL backend start-up
 * on Windows took longer, clients were reused and only 36–45 of 50 connections existed — 2026-11-22.)
 */
export async function warmPool(pool: PgPool, n: number): Promise<void> {
  const clients = await Promise.all(Array.from({ length: n }, () => pool.connect()));
  await Promise.all(clients.map((c) => c.query('SELECT 1')));
  for (const c of clients) c.release();
}

export async function resetDatabase(pool: PgPool): Promise<void> {
  const { rows } = await pool.query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'schema_migrations'`,
  );
  if (rows.length)
    await pool.query(`TRUNCATE ${rows.map((r) => `"${r.tablename}"`).join(', ')} RESTART IDENTITY CASCADE`);
}

export async function seedStore(pool: PgPool, id = 1): Promise<number> {
  await pool.query(`INSERT INTO stores (id, code, name) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [
    id,
    `S${id}`,
    `Store ${id}`,
  ]);
  return id;
}

export async function seedProducts(pool: PgPool, skus: string[], zone = 'ambient'): Promise<void> {
  await pool.query(
    `INSERT INTO products (sku, name, temperature_zone, unit_price_cents)
     SELECT s, 'Product ' || s, $2::temperature_zone, 199 FROM unnest($1::text[]) s ON CONFLICT DO NOTHING`,
    [skus, zone],
  );
}

/** Customers with a placeholder hash (auth is not exercised by these tests). */
export async function seedCustomers(pool: PgPool, n: number): Promise<string[]> {
  const ids = Array.from({ length: n }, () => newId());
  await pool.query(
    `INSERT INTO users (id, email, display_name, role, password_hash)
     SELECT id, 'c-' || id || '@test.invalid', 'Customer', 'customer', 'not-a-real-hash' FROM unnest($1::uuid[]) id`,
    [ids],
  );
  return ids;
}

export async function seedStock(
  ctx: DomainContext,
  storeId: number,
  stock: Record<string, number>,
): Promise<void> {
  await seedProducts(ctx.pool, Object.keys(stock));
  for (const [sku, qty] of Object.entries(stock)) {
    await openBalance(ctx, { storeId, sku, onHand: qty, sourceId: `open-${storeId}-${sku}` }, SYSTEM_ACTOR);
  }
}

export async function invariants(only = ['I1', 'I2', 'I3', 'I4']): Promise<InvariantRow[]> {
  const rows = await checkInvariants(databaseUrl());
  return rows.filter((r) => only.includes(r.invariant));
}

export async function deadlockCount(pool: PgPool): Promise<number> {
  const { rows } = await pool.query<{ deadlocks: number }>(
    'SELECT deadlocks FROM pg_stat_database WHERE datname = current_database()',
  );
  return Number(rows[0]?.deadlocks ?? 0);
}

export const pct = (values: number[], p: number): number => {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]! * 100) / 100;
};

export const tally = (xs: (string | number)[]): Record<string, number> =>
  xs.reduce<Record<string, number>>((m, x) => ((m[String(x)] = (m[String(x)] ?? 0) + 1), m), {});

/**
 * Persists measured test evidence under audit/test-results/<phase>/ (never overwrites audit prototype results).
 * Set AISLEFORGE_EVIDENCE_ROOT to send a re-verification run's evidence to its own folder, so the evidence
 * recorded when a phase was completed is kept unchanged.
 */
export function writeEvidence(phase: string, name: string, data: unknown): void {
  const root = process.env.AISLEFORGE_EVIDENCE_ROOT ?? path.join('audit', 'test-results');
  const dir = path.resolve(root, phase);
  mkdirSync(dir, { recursive: true });
  // Never overwrite recorded evidence: a rerun is written next to it with a timestamp suffix.
  const first = path.join(dir, `${name}.json`);
  const target = existsSync(first)
    ? path.join(dir, `${name}.run-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
    : first;
  writeFileSync(
    target,
    JSON.stringify(
      { recordedAt: new Date().toISOString(), databaseKind: inject('databaseKind'), ...(data as object) },
      null,
      2,
    ),
  );
}
