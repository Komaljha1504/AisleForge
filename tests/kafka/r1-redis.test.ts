/**
 * R1 — Redis integration (Phase 7) against a REAL Redis (docker compose up -d redis) and real Kafka/PostgreSQL:
 * shared rate limits and login throttle across two API instances (with the no-Redis negative control),
 * event-driven catalog invalidation through the real worker, Redis never deciding a reservation, and an outage
 * (`docker compose stop redis`) with bounded latency, fallbacks and recovery (runbook E4).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { checkInvariants } from '@aisleforge/database';
import { newId } from '@aisleforge/shared';
import type { Worker } from '@aisleforge/worker';
import { bearer, buildApi, login, PASSWORD, seedUser, type TestApi } from '../support/api';
import {
  databaseUrl,
  makeCtx,
  makePool,
  resetDatabase,
  seedStock,
  seedStore,
  writeEvidence,
} from '../support/db';
import {
  compose,
  countRows,
  deleteTopicsWithPrefix,
  startWorker,
  uniquePrefix,
  waitFor,
} from '../support/kafka';

const REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';
const prefix = uniquePrefix('r1');
const pool = makePool(10);
const ctx = makeCtx(pool);
const pools = { orders: pool, sync: pool };
let apiA: TestApi;
let apiB: TestApi;
let worker: Worker | null = null;
let redisStopped = false;
const evidence: Record<string, unknown> = {};
const ips = { attacker: '203.0.113.50', user: '198.51.100.9' };

const withRedis = (extra: Record<string, string> = {}) =>
  buildApi(pools, {
    REDIS_URL,
    TRUST_PROXY: 'true',
    LOGIN_IP_MAX_ATTEMPTS: '6',
    LOGIN_IP_WINDOW_SECONDS: '300',
    ...extra,
  });
const closeRedis = async (a: TestApi | undefined) =>
  (a?.app as { aisleforge?: { redis?: { close(): Promise<void> } } })?.aisleforge?.redis?.close();

async function flushRedis(): Promise<void> {
  compose(['exec', '-T', 'redis', 'redis-cli', 'FLUSHALL']);
}

beforeAll(async () => {
  compose(['up', '-d', 'redis']);
  await waitFor(async () => compose(['exec', '-T', 'redis', 'redis-cli', 'ping']).includes('PONG'), {
    what: 'Redis reachable (docker compose up -d redis)',
    timeoutMs: 60_000,
  });
  await flushRedis();
  await resetDatabase(pool);
  await seedStore(pool, 1);
  await seedStock(ctx, 1, { 'R1-A': 50, 'R1-B': 5 });
  await seedUser(pool, { email: 'victim@r1.test', role: 'customer' });
  await seedUser(pool, { email: 'shopper@r1.test', role: 'customer' });
  await seedUser(pool, { email: 'ops@r1.test', role: 'admin' });
  await seedUser(pool, { email: 'sup@r1.test', role: 'supervisor', storeId: 1 });
  apiA = withRedis();
  apiB = withRedis();
  // Shared semantics need both instances CONNECTED: while a client is still connecting, the guard deliberately uses
  // the in-process fallback (Redis is optional), so a hit taken then is not in the shared count.
  const connected = (a: TestApi) =>
    (a.app as { aisleforge?: { redis?: { connected: boolean } } }).aisleforge?.redis?.connected === true;
  await waitFor(async () => connected(apiA) && connected(apiB), {
    what: 'both API instances connected to Redis',
    timeoutMs: 15_000,
  });
});

afterAll(async () => {
  if (redisStopped) compose(['start', 'redis']);
  await worker?.stop();
  await closeRedis(apiA);
  await closeRedis(apiB);
  await pool.end();
  await deleteTopicsWithPrefix(prefix);
  writeEvidence('phase7', 'R1-redis', evidence);
});

const attempt = (api: TestApi, email: string, password: string, ip: string) =>
  request(api.app).post('/api/v1/auth/login').set('X-Forwarded-For', ip).send({ email, password });

describe('R1 Redis: shared limits, catalog cache, never authoritative, outage', () => {
  it('per-IP login limit is shared by two API instances (negative control: without Redis each instance allows its own budget)', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 8; i++)
      statuses.push(
        (await attempt(i % 2 ? apiB : apiA, `nobody${i}@r1.test`, `wrong-${i}-password`, '192.0.2.10'))
          .status,
      ); // distinct accounts: only the per-IP limit applies
    expect(statuses.slice(0, 6).every((s) => s === 401)).toBe(true);
    expect(statuses.slice(6)).toEqual([429, 429]); // the 7th attempt is refused even though each instance saw ≤ 4
    // Negative control: two in-process instances (no Redis) together allow twice the budget.
    const c1 = buildApi(pools, { TRUST_PROXY: 'true', LOGIN_IP_MAX_ATTEMPTS: '6' });
    const c2 = buildApi(pools, { TRUST_PROXY: 'true', LOGIN_IP_MAX_ATTEMPTS: '6' });
    const control: number[] = [];
    for (let i = 0; i < 12; i++)
      control.push(
        (await attempt(i % 2 ? c2 : c1, `other${i}@r1.test`, `wrong-${i}-password`, '192.0.2.11')).status,
      );
    expect(control.filter((s) => s === 401)).toHaveLength(12);
    evidence.sharedIpLimit = { withRedis: statuses, withoutRedisTwoInstances: control };
  });

  it('login throttle state is shared: a source locked on instance A is refused by B; the real user is unaffected; admin unlock clears it everywhere', async () => {
    // Own instances with a normal per-IP limit, so only the (account, source) throttle is exercised here
    // (test 1's IP limit of 6 would otherwise refuse the attacker IP's attempt after the unlock).
    const t1 = withRedis({ LOGIN_IP_MAX_ATTEMPTS: '1000' });
    const t2 = withRedis({ LOGIN_IP_MAX_ATTEMPTS: '1000' });
    const ready = (a: TestApi) =>
      (a.app as { aisleforge?: { redis?: { connected: boolean } } }).aisleforge?.redis?.connected === true;
    await waitFor(async () => ready(t1) && ready(t2), { what: 'throttle-test instances connected to Redis' });
    const [apiA, apiB] = [t1, t2];
    for (let i = 0; i < 5; i++)
      expect((await attempt(apiA, 'victim@r1.test', `guess-${i}-password`, ips.attacker)).status).toBe(401);
    const onB = await attempt(apiB, 'victim@r1.test', PASSWORD, ips.attacker);
    expect(onB.status).toBe(429); // lock created via A, enforced by B
    const realUser = await attempt(apiB, 'victim@r1.test', PASSWORD, ips.user);
    if (realUser.status !== 200)
      evidence.realUserRefusal = (
        await pool.query(
          `SELECT detail FROM auth_audit_log WHERE event = 'login_rate_limited' ORDER BY id DESC LIMIT 1`,
        )
      ).rows[0];
    expect(realUser.status, JSON.stringify(evidence.realUserRefusal)).toBe(200);
    const admin = await login(apiB.app, 'ops@r1.test');
    const id = (await pool.query<{ id: string }>(`SELECT id FROM users WHERE email = 'victim@r1.test'`))
      .rows[0]!.id;
    expect(
      (
        await request(apiB.app)
          .post(`/api/v1/admin/users/${id}/unlock-login`)
          .set(bearer(admin))
          .set('X-Forwarded-For', '10.0.0.2')
      ).status,
    ).toBe(204);
    expect((await attempt(apiA, 'victim@r1.test', PASSWORD, ips.attacker)).status).toBe(200);
    evidence.sharedThrottle = { lockedViaA_refusedOnB: onB.status, adminUnlockClearedShared: true };
    await closeRedis(t1);
    await closeRedis(t2);
  });

  it('catalog: cache hit, then event-driven invalidation through the real worker (outbox → Kafka → catalog-cache consumer)', async () => {
    worker = await startWorker(prefix, { REDIS_URL });
    const shopper = await login(apiA.app, 'shopper@r1.test');
    const get = () => request(apiA.app).get('/api/v1/stores/1/catalog').set(bearer(shopper));
    const first = await get();
    expect(first.headers['x-cache']).toBe('MISS');
    const second = await get();
    expect(second.headers['x-cache']).toBe('HIT');
    expect(second.body.items).toEqual(first.body.items);
    const sup = await login(apiA.app, 'sup@r1.test');
    await request(apiA.app)
      .post('/api/v1/stores/1/inventory/R1-A/restocks')
      .set(bearer(sup))
      .send({ qty: 7, sourceId: `r1-${newId()}` })
      .expect(201);
    const fresh = await waitFor(
      async () => {
        const r = await get();
        const a = (r.body.items as { sku: string; available: number }[]).find((x) => x.sku === 'R1-A');
        return a?.available === 57 ? r : null;
      },
      {
        what: 'catalog shows the restock (invalidated by the worker, not by TTL alone)',
        timeoutMs: 30_000,
        intervalMs: 300,
      },
    );
    expect(fresh.headers['x-cache']).toBe('MISS');
    const status = await request(apiA.app)
      .get('/internal/status')
      .set(bearer(await login(apiA.app, 'ops@r1.test')));
    evidence.catalog = {
      first: 'MISS',
      second: 'HIT',
      afterRestock: 'MISS with new value',
      redisStatus: status.body.redis,
    };
    expect(status.body.redis.connected).toBe(true);
  });

  it('Redis never decides a reservation: a stale cached catalog does not let an order through', async () => {
    const shopper = await login(apiA.app, 'shopper@r1.test');
    const cached = await request(apiA.app).get('/api/v1/stores/1/catalog').set(bearer(shopper)); // warms the cache
    expect(
      (cached.body.items as { sku: string; available: number }[]).find((x) => x.sku === 'R1-B')!.available,
    ).toBe(5);
    // Stock disappears in PostgreSQL (adjustment) — the cached page still says 5 until invalidated/expired.
    const sup = await login(apiA.app, 'sup@r1.test');
    await request(apiA.app)
      .post('/api/v1/stores/1/inventory/R1-B/adjustments')
      .set(bearer(sup))
      .send({ delta: -5, reason: 'damaged', sourceId: `r1-${newId()}` })
      .expect(201);
    const order = await request(apiA.app)
      .post('/api/v1/orders')
      .set(bearer(shopper))
      .set('Idempotency-Key', `r1-${newId()}`)
      .send({ storeId: 1, lines: [{ sku: 'R1-B', qty: 1 }] });
    expect(order.status).toBe(409); // PostgreSQL's guarded update decides, whatever the cache says
    expect(order.body.error.code).toBe('INSUFFICIENT_STOCK');
    evidence.neverAuthoritative = { cachedAvailable: 5, databaseAvailable: 0, orderStatus: order.status };
  });

  it('outage (E4): with Redis stopped, login and catalog keep working within bounded latency; recovery after restart', async () => {
    compose(['stop', 'redis']);
    redisStopped = true;
    const timings: number[] = [];
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now();
      statuses.push(
        (await attempt(i % 2 ? apiB : apiA, 'shopper@r1.test', PASSWORD, `198.51.100.${30 + i}`)).status,
      );
      timings.push(performance.now() - t0);
    }
    expect(statuses.every((s) => s === 200)).toBe(true); // fallback: in-process limiter + throttle
    const shopper = await login(apiA.app, 'shopper@r1.test');
    const t1 = performance.now();
    const cat = await request(apiA.app).get('/api/v1/stores/1/catalog').set(bearer(shopper));
    const catalogMs = performance.now() - t1;
    expect(cat.status).toBe(200);
    expect(cat.headers['x-cache']).toBe('MISS'); // served from PostgreSQL
    // The worker keeps processing inventory events; catalog invalidation is skipped, nothing is dead-lettered.
    const sup = await login(apiA.app, 'sup@r1.test');
    await request(apiA.app)
      .post('/api/v1/stores/1/inventory/R1-A/restocks')
      .set(bearer(sup))
      .send({ qty: 1, sourceId: `r1-${newId()}` })
      .expect(201);
    await waitFor(
      async () =>
        (await countRows(pool, 'SELECT count(*)::int AS n FROM outbox WHERE published_at IS NULL')) === 0,
      { what: 'outbox drained during the Redis outage' },
    );
    await new Promise((r) => setTimeout(r, 3000));
    expect(await countRows(pool, 'SELECT count(*)::int AS n FROM dead_letters')).toBe(0);
    const status = await request(apiA.app)
      .get('/internal/status')
      .set(bearer(await login(apiA.app, 'ops@r1.test')));
    expect(status.body.redis.connected).toBe(false);

    compose(['start', 'redis']);
    redisStopped = false;
    const tRecover = Date.now();
    await waitFor(
      async () => {
        const r1 = await request(apiA.app).get('/api/v1/stores/1/catalog').set(bearer(shopper));
        const r2 = await request(apiA.app).get('/api/v1/stores/1/catalog').set(bearer(shopper));
        return r1.status === 200 && r2.headers['x-cache'] === 'HIT';
      },
      { what: 'Redis used again after restart', timeoutMs: 60_000, intervalMs: 500 },
    );
    evidence.outage = {
      loginStatuses: statuses,
      loginMs: timings.map((t) => Math.round(t)),
      catalogMsDuringOutage: Math.round(catalogMs),
      deadLettersDuringOutage: 0,
      redisStatusDuringOutage: {
        connected: status.body.redis.connected,
        fallbacks: status.body.redis.stats?.fallbacks,
      },
      recoveredAfterMs: Date.now() - tRecover,
    };
    expect(Math.max(...timings)).toBeLessThan(2000); // bounded: no request waits on a dead Redis
  });

  it('invariants I1–I7 hold', async () => {
    await waitFor(
      async () =>
        (await countRows(pool, 'SELECT count(*)::int AS n FROM outbox WHERE published_at IS NULL')) === 0,
      { what: 'outbox drained' },
    );
    const rows = await checkInvariants(databaseUrl(), {
      outboxThreshold: '0 seconds',
      consumerThreshold: '0 seconds',
    });
    evidence.invariants = rows.map((r) => `${r.invariant}:${r.status}`);
    for (const r of rows) expect(r.status, `${r.invariant} ${JSON.stringify(r.sample)}`).toBe('PASS');
  });
});
