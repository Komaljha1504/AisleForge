/**
 * Phase 3 — RBAC, store-level isolation (BOLA), function-level authorization, privilege escalation and mass assignment.
 * Every case goes through the real HTTP application, real tokens and real PostgreSQL.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { bearer, buildApi, login, seedUser, type Session, type TestApi } from '../support/api';
import {
  invariants,
  makeCtx,
  makePool,
  resetDatabase,
  seedStock,
  seedStore,
  writeEvidence,
} from '../support/db';

const pool = makePool(10);
const pools = { orders: pool, sync: pool };
let api: TestApi;
const S: Record<string, Session> = {};
let ids: Record<string, string> = {};
let orderStore1 = '';
const matrixResults: { case: string; role: string; expected: number; actual: number }[] = [];

beforeAll(async () => {
  await resetDatabase(pool);
  await seedStore(pool, 1);
  await seedStore(pool, 2);
  const ctx = makeCtx(pool);
  await seedStock(ctx, 1, { 'SKU-A': 100 });
  await seedStock(ctx, 2, { 'SKU-A': 100 });
  ids = {
    admin: await seedUser(pool, { email: 'admin@hq.test', role: 'admin' }),
    sup1: await seedUser(pool, { email: 'sup@store1.test', role: 'supervisor', storeId: 1 }),
    pick1: await seedUser(pool, { email: 'pick@store1.test', role: 'picker', storeId: 1 }),
    sup2: await seedUser(pool, { email: 'sup@store2.test', role: 'supervisor', storeId: 2 }),
    pick2: await seedUser(pool, { email: 'pick@store2.test', role: 'picker', storeId: 2 }),
    cust1: await seedUser(pool, { email: 'alice@cust.test', role: 'customer' }),
    cust2: await seedUser(pool, { email: 'bob@cust.test', role: 'customer' }),
  };
  api = buildApi(pools);
  for (const [k, email] of Object.entries({
    admin: 'admin@hq.test',
    sup1: 'sup@store1.test',
    pick1: 'pick@store1.test',
    sup2: 'sup@store2.test',
    pick2: 'pick@store2.test',
    cust1: 'alice@cust.test',
    cust2: 'bob@cust.test',
  }))
    S[k] = await login(api.app, email);
  const placed = await request(api.app)
    .post('/api/v1/orders')
    .set(bearer(S.cust1!))
    .set('Idempotency-Key', 'authz-order-0001')
    .send({ storeId: 1, lines: [{ sku: 'SKU-A', qty: 1 }] });
  expect(placed.status).toBe(201);
  orderStore1 = placed.body.orderId;
});
afterAll(async () => {
  writeEvidence('phase3', 'authorization-matrix', { cases: matrixResults.length, results: matrixResults });
  await pool.end();
});

type Req = (who: Session | null, n: number) => request.Test;
let seq = 0;
const cases: { name: string; make: Req; expect: Record<string, number> }[] = [
  {
    name: 'GET store-1 inventory',
    make: (s) => withAuth(request(api.app).get('/api/v1/stores/1/inventory/SKU-A'), s),
    expect: { anon: 401, cust1: 403, pick1: 200, sup1: 200, pick2: 403, sup2: 403, admin: 200 },
  },
  {
    name: 'POST store-1 inventory adjustment',
    make: (s) =>
      withAuth(request(api.app).post('/api/v1/stores/1/inventory/SKU-A/adjustments'), s).send({
        delta: 1,
        reason: 'found',
        sourceId: `adj-${++seq}`,
      }),
    expect: { anon: 401, cust1: 403, pick1: 403, sup1: 201, pick2: 403, sup2: 403, admin: 201 },
  },
  {
    name: 'POST store-1 restock',
    make: (s) =>
      withAuth(request(api.app).post('/api/v1/stores/1/inventory/SKU-A/restocks'), s).send({
        qty: 1,
        sourceId: `grn-${++seq}`,
      }),
    expect: { anon: 401, cust1: 403, pick1: 403, sup1: 201, pick2: 403, sup2: 403, admin: 201 },
  },
  {
    name: 'POST place order',
    make: (s) =>
      withAuth(request(api.app).post('/api/v1/orders'), s)
        .set('Idempotency-Key', `matrix-order-${++seq}`)
        .send({ storeId: 1, lines: [{ sku: 'SKU-A', qty: 1 }] }),
    expect: { anon: 401, cust1: 201, pick1: 403, sup1: 403, pick2: 403, sup2: 403, admin: 403 },
  },
  {
    name: 'GET store-1 order',
    make: (s) => withAuth(request(api.app).get(`/api/v1/orders/${orderStore1}`), s),
    expect: { anon: 401, cust1: 200, cust2: 404, pick1: 200, sup1: 200, pick2: 404, sup2: 404, admin: 200 },
  },
  {
    name: 'POST admin create user',
    make: (s) =>
      withAuth(request(api.app).post('/api/v1/admin/users'), s).send({
        email: `new${++seq}@x.test`,
        password: 'long-enough-password-1',
        displayName: 'N',
        role: 'picker',
        storeId: 1,
      }),
    expect: { anon: 401, cust1: 403, pick1: 403, sup1: 403, sup2: 403, admin: 201 },
  },
  {
    name: 'GET /internal/status',
    make: (s) => withAuth(request(api.app).get('/internal/status'), s),
    expect: { anon: 401, cust1: 403, pick1: 403, sup1: 403, admin: 200 },
  },
];
function withAuth(t: request.Test, s: Session | null): request.Test {
  return s ? t.set(bearer(s)) : t;
}

describe('RBAC × store matrix', () => {
  for (const c of cases) {
    for (const [who, status] of Object.entries(c.expect)) {
      it(`${c.name} as ${who} → ${status}`, async () => {
        const res = await c.make(who === 'anon' ? null : S[who]!, 0);
        matrixResults.push({ case: c.name, role: who, expected: status, actual: res.status });
        expect(res.status, JSON.stringify(res.body)).toBe(status);
      });
    }
  }
});

describe('store isolation (BOLA)', () => {
  it('store-1 supervisor cannot modify store-2 inventory, and the balance is unchanged', async () => {
    const before = (
      await pool.query(`SELECT on_hand FROM inventory_balances WHERE store_id = 2 AND sku = 'SKU-A'`)
    ).rows[0].on_hand;
    const res = await request(api.app)
      .post('/api/v1/stores/2/inventory/SKU-A/adjustments')
      .set(bearer(S.sup1!))
      .send({ delta: -50, reason: 'attack', sourceId: 'bola-1' });
    expect(res.status).toBe(403);
    const after = (
      await pool.query(`SELECT on_hand FROM inventory_balances WHERE store_id = 2 AND sku = 'SKU-A'`)
    ).rows[0].on_hand;
    expect(after).toBe(before);
  });

  it('order listings are scoped: other customers and other stores see nothing', async () => {
    const ids2 = async (s: Session) =>
      (await request(api.app).get('/api/v1/orders?limit=100').set(bearer(s))).body.items.map(
        (o: { id: string }) => o.id,
      );
    expect(await ids2(S.cust1!)).toContain(orderStore1);
    expect(await ids2(S.cust2!)).not.toContain(orderStore1);
    expect(await ids2(S.pick2!)).not.toContain(orderStore1);
    expect(await ids2(S.pick1!)).toContain(orderStore1);
  });

  it('another customer / another store cannot cancel an order (404, nothing changes)', async () => {
    expect(
      (await request(api.app).post(`/api/v1/orders/${orderStore1}/cancel`).set(bearer(S.cust2!)).send({}))
        .status,
    ).toBe(404);
    expect(
      (await request(api.app).post(`/api/v1/orders/${orderStore1}/cancel`).set(bearer(S.sup2!)).send({}))
        .status,
    ).toBe(404);
    expect(
      (await request(api.app).post(`/api/v1/orders/${orderStore1}/cancel`).set(bearer(S.pick1!)).send({}))
        .status,
    ).toBe(403);
    const status = (await pool.query('SELECT status FROM orders WHERE id = $1', [orderStore1])).rows[0]
      .status;
    expect(status).toBe('reserved');
  });

  it('a storeId in the request body cannot redirect a staff action to another store', async () => {
    // Store scope comes from the URL + token; extra body fields are rejected outright.
    const res = await request(api.app)
      .post('/api/v1/stores/1/inventory/SKU-A/restocks')
      .set(bearer(S.sup1!))
      .send({ qty: 5, sourceId: 'grn-body', storeId: 2 });
    expect(res.status).toBe(400);
  });
});

describe('privilege escalation and mass assignment', () => {
  it('a picker cannot change their own role or store via /me', async () => {
    expect(
      (await request(api.app).patch('/api/v1/me').set(bearer(S.pick1!)).send({ role: 'admin' })).status,
    ).toBe(400);
    expect(
      (
        await request(api.app)
          .patch('/api/v1/me')
          .set(bearer(S.pick1!))
          .send({ displayName: 'x', storeId: 2 })
      ).status,
    ).toBe(400);
    const ok = await request(api.app).patch('/api/v1/me').set(bearer(S.pick1!)).send({ displayName: 'Pat' });
    expect(ok.status).toBe(200);
    expect(ok.body.user).toMatchObject({ role: 'picker', storeId: 1, displayName: 'Pat' });
  });

  it('a picker or supervisor cannot use the admin role endpoint (including on themselves)', async () => {
    expect(
      (
        await request(api.app)
          .patch(`/api/v1/admin/users/${ids.pick1}/role`)
          .set(bearer(S.pick1!))
          .send({ role: 'admin', storeId: null })
      ).status,
    ).toBe(403);
    expect(
      (
        await request(api.app)
          .patch(`/api/v1/admin/users/${ids.pick1}/role`)
          .set(bearer(S.sup1!))
          .send({ role: 'supervisor', storeId: 1 })
      ).status,
    ).toBe(403);
    const role = (await pool.query('SELECT role FROM users WHERE id = $1', [ids.pick1])).rows[0].role;
    expect(role).toBe('picker');
  });

  it('an admin cannot change their own role; inconsistent role/store assignments are rejected', async () => {
    expect(
      (
        await request(api.app)
          .patch(`/api/v1/admin/users/${ids.admin}/role`)
          .set(bearer(S.admin!))
          .send({ role: 'customer', storeId: null })
      ).status,
    ).toBe(403);
    const bad = await request(api.app).post('/api/v1/admin/users').set(bearer(S.admin!)).send({
      email: 'orphan@x.test',
      password: 'long-enough-password-1',
      displayName: 'O',
      role: 'picker',
      storeId: null,
    });
    expect(bad.status).toBe(400);
  });

  it('an order body cannot set the customer (it always comes from the token)', async () => {
    const res = await request(api.app)
      .post('/api/v1/orders')
      .set(bearer(S.cust1!))
      .set('Idempotency-Key', 'mass-assign-01')
      .send({ storeId: 1, customerId: ids.cust2, lines: [{ sku: 'SKU-A', qty: 1 }] });
    expect(res.status).toBe(400);
  });
});

describe('injection probes are rejected by validation before reaching SQL', () => {
  it.each([
    ["/api/v1/orders/' OR '1'='1"],
    ['/api/v1/orders/1;DROP TABLE orders'],
    ["/api/v1/stores/1/inventory/SKU-A';--"],
    ['/api/v1/stores/1 OR 1=1/inventory/SKU-A'],
  ])('GET %s → 400', async (path) => {
    const res = await request(api.app).get(encodeURI(path)).set(bearer(S.admin!));
    expect(res.status).toBe(400);
  });

  it('a forged pagination cursor is rejected', async () => {
    const cursor = Buffer.from(JSON.stringify({ t: "2020-01-01'; DROP TABLE orders;--", id: 'x' })).toString(
      'base64url',
    );
    expect((await request(api.app).get(`/api/v1/orders?cursor=${cursor}`).set(bearer(S.admin!))).status).toBe(
      400,
    );
    expect((await pool.query('SELECT count(*)::int AS n FROM orders')).rows[0].n).toBeGreaterThan(0);
  });

  it('inventory invariants hold after the whole authorization suite', async () => {
    for (const r of await invariants()) expect(r.status, r.invariant).toBe('PASS');
  });
});
