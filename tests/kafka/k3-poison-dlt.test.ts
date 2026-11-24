/**
 * K3 — Poison messages, bounded retries, dead-letter topic + table, safe replay (runbook E8), against a real broker.
 *
 * Poison messages are produced to the order topic on the SAME KEY as a valid order (so they share its partition and
 * sit in front of it). A persistent but retriable failure is produced for real: an uncommitted pick-task row held by
 * a test transaction makes the consumer hit PostgreSQL lock_timeout on every attempt.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type pg from 'pg';
import { checkInvariants } from '@aisleforge/database';
import { requestDeadLetterReplay } from '@aisleforge/domain';
import { deadLetterTopic, Topics } from '@aisleforge/events';
import { createLogger, newId } from '@aisleforge/shared';
import { createKafka, ensureTopics, APPLICATION_TOPICS, type Worker } from '@aisleforge/worker';
import { bearer, buildApi, login, seedUser, type TestApi } from '../support/api';
import {
  databaseUrl,
  makeCtx,
  makePool,
  resetDatabase,
  seedCustomers,
  seedStock,
  seedStore,
  writeEvidence,
} from '../support/db';
import {
  countRows,
  deleteTopicsWithPrefix,
  kafkaBrokers,
  place,
  produceRaw,
  readTopic,
  seedLayout,
  startWorker,
  uniquePrefix,
  waitFor,
} from '../support/kafka';

const prefix = uniquePrefix('k3');
const ORDERS = prefix + Topics.orders;
const pool = makePool(10);
const ctx = makeCtx(pool);
let worker: Worker | null = null;
let blocker: pg.PoolClient | null = null;
let api: TestApi;
let orderBlocked = '';
let orderAfterPoison = '';
const missingOrder = newId();
const evidence: Record<string, unknown> = {};

const placedEnvelope = (orderId: string, payload: Record<string, unknown>) =>
  JSON.stringify({
    eventId: newId(),
    type: 'order.placed',
    schemaVersion: 1,
    aggregateType: 'order',
    aggregateId: orderId,
    aggregateVersion: 1,
    occurredAt: new Date().toISOString(),
    correlationId: 'k3-poison',
    payload,
  });

beforeAll(async () => {
  await resetDatabase(pool);
  await seedStore(pool, 1);
  await seedStock(ctx, 1, { 'K3-A': 1000, 'K3-B': 1000 });
  await seedLayout(pool, 1, { 'K3-A': { aisle: 1, pos: 5 }, 'K3-B': { aisle: 3, pos: 20 } });
  const [c1, c2] = await seedCustomers(pool, 2);
  await seedUser(pool, { email: 'ops@k3.test', role: 'admin' });
  await seedUser(pool, { email: 'cust@k3.test', role: 'customer' });
  api = buildApi({ orders: pool, sync: pool });

  // Orders committed BEFORE the worker starts: their events are published after the poison messages below.
  orderBlocked = await place(ctx, c1!, 1, [{ sku: 'K3-A', qty: 1 }], 'k3-blocked');
  orderAfterPoison = await place(ctx, c2!, 1, [{ sku: 'K3-B', qty: 2 }], 'k3-after-poison');

  const admin = createKafka(
    { brokers: kafkaBrokers().split(','), clientId: 'k3', deliveryTimeoutMs: 5000, sessionTimeoutMs: 6000 },
    createLogger('k3', { level: 'error' }),
  ).admin();
  await admin.connect();
  await ensureTopics(admin, {
    partitions: 3,
    replicationFactor: 1,
    topics: APPLICATION_TOPICS.map((t) => prefix + t),
  });
  await admin.disconnect();

  const key = orderAfterPoison; // same key ⇒ same partition, ahead of the valid order.placed
  await produceRaw(ORDERS, [
    { key, value: '{"this is": not json' },
    { key, value: JSON.stringify({ eventId: newId(), type: 'order.placed' }) }, // invalid envelope
    {
      key,
      value: JSON.stringify({
        eventId: newId(),
        type: 'order.teleported',
        schemaVersion: 1,
        aggregateType: 'order',
        aggregateId: key,
        aggregateVersion: 1,
        occurredAt: new Date().toISOString(),
        correlationId: null,
        payload: {},
      }),
    }, // unknown type
    { key, value: placedEnvelope(key, { orderId: key, storeId: 1 }) }, // invalid payload (missing fields)
    {
      key,
      value: placedEnvelope(missingOrder, {
        orderId: missingOrder,
        storeId: 1,
        customerId: c1,
        lines: [{ lineId: newId(), lineNo: 1, sku: 'K3-A', qty: 1, reservationId: newId() }],
        reservationExpiresAt: new Date().toISOString(),
      }),
    }, // references an order that does not exist → permanent handler failure
  ]);

  // Persistent retriable failure: hold an uncommitted pick task for orderBlocked.
  blocker = await pool.connect();
  await blocker.query("SET idle_in_transaction_session_timeout = '120s'");
  await blocker.query('BEGIN');
  await blocker.query(
    `INSERT INTO pick_tasks (id, order_id, store_id, route_status, route, source_event_id)
     VALUES ($1, $2, 1, 'unplanned', '{}'::jsonb, $3)`,
    [newId(), orderBlocked, newId()],
  );
  worker = await startWorker(prefix, { PG_LOCK_TIMEOUT_MS: '300', CONSUMER_MAX_ATTEMPTS: '3' });
});

afterAll(async () => {
  if (blocker) {
    await blocker.query('ROLLBACK').catch(() => undefined);
    blocker.release();
  }
  await worker?.stop();
  await pool.end();
  await deleteTopicsWithPrefix(prefix);
  writeEvidence('phase2', 'K3-poison-dlt-replay', evidence);
});

describe('K3 poison messages, dead letters and replay (real Kafka)', () => {
  it('the partition is not stuck: the valid order behind 5 poison messages gets its pick task', async () => {
    await waitFor(
      async () =>
        (await countRows(pool, 'SELECT count(*)::int AS n FROM pick_tasks WHERE order_id = $1', [
          orderAfterPoison,
        ])) === 1,
      { what: 'task for the order behind the poison messages', timeoutMs: 90_000 },
    );
  });

  it('every poison message is dead-lettered once (table + DLT topic), with bounded attempts and a reason', async () => {
    // The worker inserts the row, THEN publishes the DLT copy, THEN stamps dlt_published_at. Waiting only for the
    // row count raced with the last publish under load (official run 2, 2026-11-22), so wait for both.
    await waitFor(
      async () =>
        (await countRows(
          pool,
          'SELECT count(*)::int AS n FROM dead_letters WHERE dlt_published_at IS NOT NULL',
        )) === 6 && (await countRows(pool, 'SELECT count(*)::int AS n FROM dead_letters')) === 6,
      {
        what: '6 dead letters (5 poison + 1 lock-blocked), each copied to the DLT topic',
        timeoutMs: 120_000,
      },
    );
    const { rows } = await pool.query<{
      error_kind: string;
      attempts: number;
      error_message: string;
      dlt_published_at: Date | null;
      event_id: string | null;
    }>(
      'SELECT error_kind, attempts, error_message, dlt_published_at, event_id FROM dead_letters ORDER BY id',
    );
    const kinds = rows.map((r) => r.error_kind).sort();
    expect(kinds).toEqual(
      [
        'handler_failed',
        'handler_failed',
        'invalid_message',
        'invalid_message',
        'invalid_message',
        'unknown_event_type',
      ].sort(),
    );
    expect(rows.every((r) => r.dlt_published_at !== null)).toBe(true);
    const lockBlocked = rows.find((r) => r.error_kind === 'handler_failed' && /lock/i.test(r.error_message));
    const notFound = rows.find(
      (r) => r.error_kind === 'handler_failed' && /does not exist/.test(r.error_message),
    );
    expect(lockBlocked?.attempts).toBe(3); // retriable: CONSUMER_MAX_ATTEMPTS, then dead-lettered
    expect(notFound?.attempts).toBe(1); // permanent: not retried
    const dlt = await readTopic(deadLetterTopic(ORDERS), 6);
    expect(dlt).toHaveLength(6);
    expect(new Set(dlt.map((m) => m.headers['dlt-id'])).size).toBe(6);
    for (const m of dlt) {
      expect(m.headers['dlt-consumer']).toBe('order-workflow');
      expect(m.headers['dlt-error-kind']).toBeTruthy();
      expect(m.headers['dlt-source']).toMatch(new RegExp(`^${ORDERS.replace(/\./g, '\\.')}/\\d+/\\d+$`));
    }
    // Dead-lettered events are NOT recorded as processed (so a replay can still apply them).
    expect(
      await countRows(pool, 'SELECT count(*)::int AS n FROM processed_events WHERE event_id = $1', [
        missingOrder,
      ]),
    ).toBe(0);
    evidence.deadLetters = rows.map((r) => ({
      kind: r.error_kind,
      attempts: r.attempts,
      error: r.error_message,
    }));
    evidence.dltTopicMessages = dlt.length;
  });

  it('admin API: list/inspect are admin-only; replay of a fixed failure applies it exactly once', async () => {
    const admin = await login(api.app, 'ops@k3.test');
    const cust = await login(api.app, 'cust@k3.test');
    expect((await request(api.app).get('/internal/dead-letters').set(bearer(cust))).status).toBe(403);
    const list = await request(api.app).get('/internal/dead-letters?status=dead&limit=10').set(bearer(admin));
    expect(list.status).toBe(200);
    expect(list.body.items).toHaveLength(6);
    const blocked = list.body.items.find(
      (d: { errorKind: string; errorMessage: string }) =>
        d.errorKind === 'handler_failed' && /lock/i.test(d.errorMessage),
    );
    const detail = await request(api.app).get(`/internal/dead-letters/${blocked.id}`).set(bearer(admin));
    expect(detail.body.deadLetter.rawValue).toContain(orderBlocked);
    expect(detail.body.deadLetter.headers['correlation-id']).toBe('k3-blocked');

    // The cause goes away (the lock holder rolls back); the operator requests a replay.
    await blocker!.query('ROLLBACK');
    blocker!.release();
    blocker = null;
    const replay = await request(api.app)
      .post(`/internal/dead-letters/${blocked.id}/replay`)
      .set(bearer(admin));
    expect(replay.status).toBe(202);
    // A second request while one is pending is rejected.
    expect(
      (await request(api.app).post(`/internal/dead-letters/${blocked.id}/replay`).set(bearer(admin))).status,
    ).toBe(409);
    await waitFor(
      async () =>
        (await countRows(pool, 'SELECT count(*)::int AS n FROM pick_tasks WHERE order_id = $1', [
          orderBlocked,
        ])) === 1,
      { what: 'replayed event applied', timeoutMs: 60_000 },
    );
    const st = await pool.query<{ status: string; replay_count: number }>(
      'SELECT status::text AS status, replay_count FROM dead_letters WHERE id = $1',
      [blocked.id],
    );
    expect(st.rows[0]).toEqual({ status: 'replayed', replay_count: 1 });

    // Replaying again is safe: the consumer recognises the event and creates nothing.
    const dupBefore = worker!.consumers[0]!.stats.duplicate;
    await requestDeadLetterReplay(pool, blocked.id, { userId: admin.userId, ip: null });
    await waitFor(async () => worker!.consumers[0]!.stats.duplicate > dupBefore, {
      what: 'duplicate on second replay',
    });
    expect(
      await countRows(pool, 'SELECT count(*)::int AS n FROM pick_tasks WHERE order_id = $1', [orderBlocked]),
    ).toBe(1);
    const audit = await countRows(
      pool,
      "SELECT count(*)::int AS n FROM auth_audit_log WHERE event = 'dead_letter_replay_requested'",
    );
    expect(audit).toBe(2);
    evidence.replay = { firstReplay: 'applied', secondReplay: 'duplicate_skipped', auditRecords: audit };
  });

  it('replaying a still-invalid message dead-letters it again as a new record; discard needs a note', async () => {
    const admin = await login(api.app, 'ops@k3.test');
    const invalid = await pool.query<{ id: number }>(
      "SELECT id FROM dead_letters WHERE error_message LIKE 'invalid JSON%' LIMIT 1",
    );
    const id = invalid.rows[0]!.id;
    expect(
      (await request(api.app).post(`/internal/dead-letters/${id}/replay`).set(bearer(admin))).status,
    ).toBe(202);
    await waitFor(async () => (await countRows(pool, 'SELECT count(*)::int AS n FROM dead_letters')) === 7, {
      what: 'replayed poison dead-lettered again',
      timeoutMs: 60_000,
    });
    const newest = await pool.query<{ headers: Record<string, string>; error_kind: string }>(
      'SELECT headers, error_kind FROM dead_letters ORDER BY id DESC LIMIT 1',
    );
    expect(newest.rows[0]!.headers['replay-of']).toBe(String(id));
    expect(newest.rows[0]!.error_kind).toBe('invalid_message');
    const noNote = await request(api.app)
      .post(`/internal/dead-letters/${id}/discard`)
      .set(bearer(admin))
      .send({});
    expect(noNote.status).toBe(400);
    const ok = await request(api.app)
      .post(`/internal/dead-letters/${id}/discard`)
      .set(bearer(admin))
      .send({ note: 'malformed producer test message; nothing to recover' });
    expect(ok.status).toBe(200);
    expect(ok.body.deadLetter.status).toBe('discarded');
    expect(
      (await request(api.app).post(`/internal/dead-letters/${id}/replay`).set(bearer(admin))).status,
    ).toBe(409);
  });

  it('global invariants I1–I6 hold', async () => {
    const rows = await checkInvariants(databaseUrl(), {
      outboxThreshold: '0 seconds',
      consumerThreshold: '0 seconds',
    });
    evidence.invariants = rows.map((r) => `${r.invariant}:${r.status}`);
    for (const r of rows) expect(r.status, `${r.invariant} ${JSON.stringify(r.sample)}`).toBe('PASS');
  });
});
