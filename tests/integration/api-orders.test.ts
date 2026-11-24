/** HTTP-level order flow, idempotency headers, pagination, correlation propagation, health probes, diagnostics. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import pg from 'pg';
import { bearer, buildApi, login, seedUser, type Session, type TestApi } from '../support/api';
import {
  databaseUrl,
  invariants,
  makeCtx,
  makePool,
  resetDatabase,
  seedStock,
  seedStore,
} from '../support/db';

const pool = makePool(10);
const pools = { orders: pool, sync: pool };
let api: TestApi;
let cust: Session;
let admin: Session;

beforeAll(async () => {
  await resetDatabase(pool);
  await seedStore(pool, 1);
  await seedStock(makeCtx(pool), 1, { 'SKU-A': 50, 'SKU-B': 2 });
  await seedUser(pool, { email: 'carol@cust.test', role: 'customer' });
  await seedUser(pool, { email: 'root@hq.test', role: 'admin' });
  api = buildApi(pools);
  cust = await login(api.app, 'carol@cust.test');
  admin = await login(api.app, 'root@hq.test');
});
afterAll(async () => {
  await pool.end();
});

const place = (key: string | null, body: unknown, extra: Record<string, string> = {}) => {
  const t = request(api.app).post('/api/v1/orders').set(bearer(cust)).set(extra);
  return (key ? t.set('Idempotency-Key', key) : t).send(body as object);
};

describe('POST /api/v1/orders', () => {
  it('requires a well-formed Idempotency-Key', async () => {
    expect((await place(null, { storeId: 1, lines: [{ sku: 'SKU-A', qty: 1 }] })).status).toBe(400);
    expect((await place('short', { storeId: 1, lines: [{ sku: 'SKU-A', qty: 1 }] })).status).toBe(400);
  });

  it('creates the order (201 + Location) and replays the identical response for a retry', async () => {
    const body = { storeId: 1, lines: [{ sku: 'SKU-A', qty: 2 }] };
    const first = await place('http-order-0001', body);
    expect(first.status).toBe(201);
    expect(first.headers['idempotent-replayed']).toBe('false');
    expect(first.headers.location).toBe(`/api/v1/orders/${first.body.orderId}`);
    const retry = await place('http-order-0001', body);
    expect(retry.status).toBe(201);
    expect(retry.headers['idempotent-replayed']).toBe('true');
    expect(retry.body).toEqual(first.body);
    expect((await place('http-order-0001', { storeId: 1, lines: [{ sku: 'SKU-A', qty: 3 }] })).status).toBe(
      422,
    );
  });

  it('returns 409 with shortages when stock is insufficient', async () => {
    const res = await place('http-order-0002', { storeId: 1, lines: [{ sku: 'SKU-B', qty: 5 }] });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatchObject({
      code: 'INSUFFICIENT_STOCK',
      details: { shortages: [{ sku: 'SKU-B', requested: 5, available: 2 }] },
    });
  });

  it('propagates the correlation id from the HTTP request into the order row and its outbox events', async () => {
    const res = await place(
      'http-order-0003',
      { storeId: 1, lines: [{ sku: 'SKU-A', qty: 1 }] },
      { 'X-Correlation-Id': 'corr-test-12345' },
    );
    expect(res.status).toBe(201);
    expect(res.headers['x-correlation-id']).toBe('corr-test-12345');
    const o = await pool.query('SELECT correlation_id FROM orders WHERE id = $1', [res.body.orderId]);
    expect(o.rows[0].correlation_id).toBe('corr-test-12345');
    const ev = await pool.query(
      `SELECT DISTINCT correlation_id FROM outbox WHERE payload->>'orderId' = $1 OR aggregate_id = $1`,
      [res.body.orderId],
    );
    expect(ev.rows.map((r) => r.correlation_id)).toEqual(['corr-test-12345']);
    const ledger = await pool.query(
      `SELECT DISTINCT correlation_id FROM inventory_ledger WHERE movement = 'reserve' AND correlation_id = 'corr-test-12345'`,
    );
    expect(ledger.rowCount).toBe(1);
  });

  it('ignores malformed correlation ids (log-injection guard) and generates one', async () => {
    const res = await place(
      'http-order-0004',
      { storeId: 1, lines: [{ sku: 'SKU-A', qty: 1 }] },
      { 'X-Correlation-Id': 'bad value <script>' },
    );
    expect(res.status).toBe(201);
    expect(res.headers['x-correlation-id']).not.toContain('bad');
  });
});

describe('GET /api/v1/orders pagination', () => {
  it('pages with an opaque keyset cursor without duplicates or gaps', async () => {
    for (let i = 0; i < 5; i++)
      await place(`page-order-000${i}`, { storeId: 1, lines: [{ sku: 'SKU-A', qty: 1 }] });
    const total = (await pool.query('SELECT count(*)::int AS n FROM orders')).rows[0].n;
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const res: request.Response = await request(api.app)
        .get(`/api/v1/orders?limit=2${cursor ? `&cursor=${cursor}` : ''}`)
        .set(bearer(cust));
      expect(res.status).toBe(200);
      seen.push(...res.body.items.map((o: { id: string }) => o.id));
      cursor = res.body.nextCursor;
    } while (cursor);
    expect(seen).toHaveLength(total);
    expect(new Set(seen).size).toBe(total);
  });
});

describe('health and diagnostics', () => {
  it('liveness and readiness are up with a healthy database', async () => {
    expect((await request(api.app).get('/health/live')).status).toBe(200);
    const ready = await request(api.app).get('/health/ready');
    expect(ready.status).toBe(200);
    expect(ready.body.checks.postgres).toBe('ok');
  });

  it('liveness does NOT depend on PostgreSQL; readiness reports it unavailable', async () => {
    const dead = new pg.Pool({
      connectionString: databaseUrl().replace(/:\d+\//, ':1/'),
      connectionTimeoutMillis: 300,
      max: 1,
    });
    const broken = buildApi({ orders: dead, sync: dead });
    expect((await request(broken.app).get('/health/live')).status).toBe(200);
    expect((await request(broken.app).get('/health/ready')).status).toBe(503);
    await dead.end();
  });

  it('/internal/status reports pools, transaction stats and outbox backlog for admins only', async () => {
    const res = await request(api.app).get('/internal/status').set(bearer(admin));
    expect(res.status).toBe(200);
    expect(res.body.postgres.pools[0]).toMatchObject({ name: 'orders', max: 10 });
    expect(res.body.outbox.unpublished).toBeGreaterThan(0); // no publisher runs in this test
    // Kafka state comes from worker snapshots (Phase 2); no worker runs in this test, so there are none.
    expect(res.body.workers).toEqual([]);
    expect((await request(api.app).get('/internal/status').set(bearer(cust))).status).toBe(403);
  });

  it('invariants hold after the HTTP flows', async () => {
    for (const r of await invariants()) expect(r.status, r.invariant).toBe('PASS');
  });
});
