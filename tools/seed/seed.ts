/**
 * Demo / test data: stores with warehouse layouts and bin locations, a product catalogue (ambient, chilled, frozen),
 * opening stock (through the domain, so the ledger is correct), and one account per role.
 * Idempotent and safe to run concurrently (serialized by an advisory lock: on Kubernetes every replica's migrate
 * initContainer seeds at the same time, and the unlocked check-then-insert crash-looped on kind). Passwords come from SEED_PASSWORD (never hard-coded for real deployments).
 *
 *   DATABASE_URL=... SEED_PASSWORD=... pnpm seed
 */
import pg from 'pg';
import { defaultDomainConfig, hashPassword, openBalance } from '@aisleforge/domain';
import { newId } from '@aisleforge/shared';

export interface SeedAccounts {
  customer: string;
  picker: string;
  picker2: string;
  supervisor: string;
  admin: string;
}

export const DEMO_ACCOUNTS: SeedAccounts = {
  customer: 'customer@demo.aisleforge.test',
  picker: 'picker@demo.aisleforge.test',
  picker2: 'picker2@demo.aisleforge.test',
  supervisor: 'supervisor@demo.aisleforge.test',
  admin: 'admin@demo.aisleforge.test',
};

const PRODUCTS: [
  sku: string,
  name: string,
  zone: 'ambient' | 'chilled' | 'frozen',
  cents: number,
  aisle: number,
  pos: number,
][] = [
  ['MILK-1L', 'Whole milk 1 L', 'chilled', 129, 4, 6],
  ['YOGURT-500', 'Greek yogurt 500 g', 'chilled', 349, 4, 14],
  ['PEAS-FRZ', 'Frozen garden peas 1 kg', 'frozen', 279, 5, 4],
  ['PIZZA-FRZ', 'Stone-baked pizza', 'frozen', 499, 5, 18],
  ['RICE-2KG', 'Basmati rice 2 kg', 'ambient', 599, 1, 22],
  ['PASTA-500', 'Penne pasta 500 g', 'ambient', 149, 1, 9],
  ['OLIVE-OIL', 'Olive oil 750 ml', 'ambient', 899, 2, 17],
  ['COFFEE-250', 'Ground coffee 250 g', 'ambient', 649, 2, 5],
  ['TOMATO-CAN', 'Chopped tomatoes 400 g', 'ambient', 99, 3, 12],
  ['BREAD-WHT', 'White sandwich loaf', 'ambient', 189, 0, 25],
  ['APPLE-6', 'Apples (6 pack)', 'ambient', 299, 0, 8],
  ['SOAP-LIQ', 'Liquid hand soap', 'ambient', 249, 3, 27],
];

/** Arbitrary constant, distinct from the migration lock. */
const SEED_LOCK_KEY = 7_411_003;

const LAYOUT = {
  aisles: 6,
  aisleLength: 30,
  aisleSpacing: 3,
  crossAisles: [0, 15, 30],
  entry: { aisle: 0, pos: 0 },
  exit: { aisle: 0, pos: 0 },
};

export async function seedDemo(
  databaseUrl: string,
  opts: { password: string; stores?: number[]; stockPerSku?: number },
): Promise<SeedAccounts> {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 4 });
  const stores = opts.stores ?? [1, 2];
  // Session-level advisory lock on a dedicated connection; released explicitly (and by PostgreSQL if we die).
  const lock = await pool.connect().catch(async (e: unknown) => {
    await pool.end();
    throw e;
  });
  try {
    await lock.query('SELECT pg_advisory_lock($1)', [SEED_LOCK_KEY]);
    for (const s of stores) {
      await pool.query(
        `INSERT INTO stores (id, code, name) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING`,
        [s, `ST${s}`, s === 1 ? 'Riverside Market' : s === 2 ? 'Hilltop Express' : `Store ${s}`],
      );
      await pool.query(
        `INSERT INTO store_layouts (store_id, layout) VALUES ($1, $2::jsonb) ON CONFLICT (store_id) DO NOTHING`,
        [s, JSON.stringify({ id: `store-${s}`, ...LAYOUT })],
      );
    }
    for (const [sku, name, zone, cents] of PRODUCTS)
      await pool.query(
        `INSERT INTO products (sku, name, temperature_zone, unit_price_cents) VALUES ($1, $2, $3::temperature_zone, $4)
         ON CONFLICT (sku) DO NOTHING`,
        [sku, name, zone, cents],
      );
    const ctx = { pool, config: defaultDomainConfig };
    for (const s of stores)
      for (const [sku, , , , aisle, pos] of PRODUCTS) {
        await pool.query(
          `INSERT INTO sku_locations (store_id, sku, aisle, pos) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
          [s, sku, aisle, pos],
        );
        const exists = await pool.query('SELECT 1 FROM inventory_balances WHERE store_id = $1 AND sku = $2', [
          s,
          sku,
        ]);
        if (!exists.rowCount)
          await openBalance(
            ctx,
            { storeId: s, sku, onHand: opts.stockPerSku ?? 500, sourceId: `seed-open-${s}-${sku}` },
            { actorId: null, correlationId: 'seed' },
          );
      }
    const hash = await hashPassword(opts.password);
    const users: [email: string, name: string, role: string, store: number | null][] = [
      [DEMO_ACCOUNTS.customer, 'Casey Customer', 'customer', null],
      [DEMO_ACCOUNTS.picker, 'Priya Picker', 'picker', 1],
      [DEMO_ACCOUNTS.picker2, 'Pat Picker', 'picker', 1],
      [DEMO_ACCOUNTS.supervisor, 'Sam Supervisor', 'supervisor', 1],
      [DEMO_ACCOUNTS.admin, 'Alex Admin', 'admin', null],
    ];
    for (const [email, name, role, store] of users)
      await pool.query(
        `INSERT INTO users (id, email, display_name, role, store_id, password_hash)
         VALUES ($1, $2, $3, $4::user_role, $5, $6) ON CONFLICT (email) DO NOTHING`,
        [newId(), email, name, role, store, hash],
      );
    return DEMO_ACCOUNTS;
  } finally {
    await lock.query('SELECT pg_advisory_unlock($1)', [SEED_LOCK_KEY]).catch(() => undefined);
    lock.release();
    await pool.end();
  }
}

// CLI only when THIS file is the entry point. (Comparing import.meta.url is wrong once bundled: every module in a
// bundle shares the bundle's URL, which made init-db.mjs seed before migrating — found in the Compose run.)
if (/[\\/]seed\.ts$/.test(process.argv[1] ?? '')) {
  const url = process.env.DATABASE_URL;
  const password = process.env.SEED_PASSWORD;
  if (!url || !password || password.length < 12) {
    console.error('DATABASE_URL and SEED_PASSWORD (>= 12 characters) are required');
    process.exit(2);
  }
  const accounts = await seedDemo(url, { password });
  console.log('seeded demo data; accounts:', accounts);
}
