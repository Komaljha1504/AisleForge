/**
 * Load-test data for the k6 profiles (audit runbook profiles A–D): stores with layouts, a product catalogue of the
 * profile's size with bin locations, opening balances WITH their 'opening' ledger rows (set-based, so invariant I3
 * holds), one customer account per simulated customer and one picker account per simulated employee (fixes the
 * template's "single principal" defect). Idempotent per profile.
 *
 *   DATABASE_URL=... LOAD_PROFILE=B SEED_PASSWORD=... pnpm tsx tools/seed/load-seed.ts
 */
import pg from 'pg';
import { hashPassword } from '@aisleforge/domain';

export const LOAD_PROFILES = {
  A: { employees: 10, products: 500, stores: 1, customers: 50 },
  B: { employees: 50, products: 5000, stores: 2, customers: 200 },
  C: { employees: 200, products: 20000, stores: 5, customers: 500 },
  D: { employees: 500, products: 50000, stores: 10, customers: 1000 },
} as const;
export type LoadProfile = keyof typeof LOAD_PROFILES;

export async function loadSeed(databaseUrl: string, profile: LoadProfile, password: string): Promise<void> {
  const P = LOAD_PROFILES[profile];
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 2 });
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query(
      `INSERT INTO stores (id, code, name) SELECT s, 'LS' || s, 'Load store ' || s FROM generate_series(1, $1) s
       ON CONFLICT (id) DO NOTHING`,
      [P.stores],
    );
    await c.query(
      `INSERT INTO store_layouts (store_id, layout)
       SELECT s, jsonb_build_object('id', 'load-' || s, 'aisles', 20, 'aisleLength', 60, 'aisleSpacing', 3,
              'crossAisles', jsonb_build_array(0, 30, 60), 'entry', jsonb_build_object('aisle', 0, 'pos', 0),
              'exit', jsonb_build_object('aisle', 0, 'pos', 0))
         FROM generate_series(1, $1) s ON CONFLICT (store_id) DO NOTHING`,
      [P.stores],
    );
    // SKU numbering: LOAD-000001 … ; the first 1% are the "hot" SKUs the k6 script concentrates on.
    await c.query(
      `INSERT INTO products (sku, name, temperature_zone, unit_price_cents)
       SELECT 'LOAD-' || lpad(i::text, 6, '0'), 'Load product ' || i,
              (CASE WHEN i % 20 = 0 THEN 'frozen' WHEN i % 10 = 0 THEN 'chilled' ELSE 'ambient' END)::temperature_zone,
              100 + (i % 900)
         FROM generate_series(1, $1) i ON CONFLICT (sku) DO NOTHING`,
      [P.products],
    );
    await c.query(
      `INSERT INTO sku_locations (store_id, sku, aisle, pos)
       SELECT s, 'LOAD-' || lpad(i::text, 6, '0'), (i * 7 + s) % 20, (i * 13) % 61
         FROM generate_series(1, $1) s, generate_series(1, $2) i ON CONFLICT DO NOTHING`,
      [P.stores, P.products],
    );
    // Hot SKUs get large stock (they must not run out in seconds); the rest a normal amount.
    await c.query(
      `WITH b AS (
         INSERT INTO inventory_balances (store_id, sku, on_hand)
         SELECT s, 'LOAD-' || lpad(i::text, 6, '0'), CASE WHEN i <= greatest(1, $2 / 100) THEN 100000 ELSE 2000 END
           FROM generate_series(1, $1) s, generate_series(1, $2) i
         ON CONFLICT (store_id, sku) DO NOTHING
         RETURNING store_id, sku, on_hand)
       INSERT INTO inventory_ledger (store_id, sku, movement, delta_on_hand, delta_reserved, source_type, source_id, correlation_id)
       SELECT store_id, sku, 'opening', on_hand, 0, 'load_seed', 'load-open-' || store_id || '-' || sku, 'load-seed' FROM b`,
      [P.stores, P.products],
    );
    const hash = await hashPassword(password);
    await c.query(
      `INSERT INTO users (id, email, display_name, role, store_id, password_hash)
       SELECT gen_random_uuid(), 'load-customer-' || i || '@load.aisleforge.test', 'Load customer ' || i, 'customer', NULL, $2
         FROM generate_series(1, $1) i ON CONFLICT (email) DO NOTHING`,
      [P.customers, hash],
    );
    await c.query(
      `INSERT INTO users (id, email, display_name, role, store_id, password_hash)
       SELECT gen_random_uuid(), 'load-picker-' || i || '@load.aisleforge.test', 'Load picker ' || i, 'picker',
              1 + ((i - 1) % $2), $3
         FROM generate_series(1, $1) i ON CONFLICT (email) DO NOTHING`,
      [P.employees, P.stores, hash],
    );
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
    await pool.end();
  }
}

if (/[\\/]load-seed\.(ts|mjs)$/.test(process.argv[1] ?? '')) {
  const url = process.env.DATABASE_URL;
  const profile = (process.env.LOAD_PROFILE ?? 'A') as LoadProfile;
  const password = process.env.SEED_PASSWORD;
  if (!url || !password || !(profile in LOAD_PROFILES)) {
    console.error('DATABASE_URL, SEED_PASSWORD and LOAD_PROFILE (A|B|C|D) are required');
    process.exit(2);
  }
  const t0 = Date.now();
  await loadSeed(url, profile, password);
  console.log(JSON.stringify({ profile, seededMs: Date.now() - t0, ...LOAD_PROFILES[profile] }));
}
