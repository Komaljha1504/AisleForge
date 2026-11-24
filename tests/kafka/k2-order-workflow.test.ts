/**
 * K2 — Order → pick-task workflow end to end against a real Kafka broker:
 * domain transaction → outbox → publisher (leader) → Kafka → order-workflow consumer → pick task (+ route).
 * Also: correlation-id propagation, offsets committed only after DB commit (lag returns to 0), redelivery after a
 * publisher crash between broker ack and outbox mark (duplicates skipped, effects unchanged), stale events,
 * per-key ordering of placed/cancelled, routing fallback/infeasible/unplanned, invariants I1–I6.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkInvariants } from '@aisleforge/database';
import { cancelOrder } from '@aisleforge/domain';
import { Topics } from '@aisleforge/events';
import { newId } from '@aisleforge/shared';
import type { Worker } from '@aisleforge/worker';
import {
  databaseUrl,
  makeCtx,
  makePool,
  resetDatabase,
  seedCustomers,
  seedProducts,
  seedStock,
  seedStore,
  writeEvidence,
} from '../support/db';
import {
  countRows,
  deleteTopicsWithPrefix,
  place,
  produceRaw,
  seedLayout,
  startWorker,
  uniquePrefix,
  waitFor,
} from '../support/kafka';

const prefix = uniquePrefix('k2');
const pool = makePool(10);
const ctx = makeCtx(pool);
let worker: Worker | null = null;
let customers: string[] = [];
const evidence: Record<string, unknown> = {};
const AMBIENT = ['K2-A', 'K2-B', 'K2-C', 'K2-D'];
const FROZEN = ['K2-F1'];

beforeAll(async () => {
  await resetDatabase(pool);
  for (const s of [1, 2, 3]) await seedStore(pool, s);
  await seedProducts(pool, FROZEN, 'frozen');
  for (const s of [1, 2, 3])
    await seedStock(ctx, s, Object.fromEntries([...AMBIENT, ...FROZEN].map((k) => [k, 10_000])));
  await seedLayout(pool, 1, {
    'K2-A': { aisle: 1, pos: 10 },
    'K2-B': { aisle: 2, pos: 25 },
    'K2-C': { aisle: 4, pos: 5 },
    'K2-D': { aisle: 5, pos: 18 },
    'K2-F1': { aisle: 3, pos: 12 },
  });
  // Store 3: a cold-chain policy that cannot be met (frozen item 40+ m from hand-off, limit 5 m).
  await seedLayout(pool, 3, { 'K2-A': { aisle: 1, pos: 2 }, 'K2-F1': { aisle: 5, pos: 28 } });
  const l3 = await pool.query<{ layout: Record<string, unknown> }>(
    'SELECT layout FROM store_layouts WHERE store_id = 3',
  );
  await pool.query('UPDATE store_layouts SET layout = $1::jsonb WHERE store_id = 3', [
    JSON.stringify({ ...l3.rows[0]!.layout, exposureLimits: [{ zone: 'frozen', maxMeters: 5 }] }),
  ]);
  customers = await seedCustomers(pool, 20);
  worker = await startWorker(prefix);
});

afterAll(async () => {
  await worker?.stop();
  await pool.end();
  await deleteTopicsWithPrefix(prefix);
  writeEvidence('phase2', 'K2-order-workflow', evidence);
});

const tasks = () => countRows(pool, 'SELECT count(*)::int AS n FROM pick_tasks');
const lagZero = async () => {
  const s = (await worker!.status()) as { kafka: { lag: Record<string, { lag: number }[]> } };
  const parts = Object.values(s.kafka.lag).flat();
  return parts.length > 0 && parts.every((p) => p.lag === 0);
};

describe('K2 order → pick task workflow (real Kafka)', () => {
  it('turns placed orders into pick tasks with feasible routes and propagates the correlation id', async () => {
    const t0 = Date.now();
    const placed: { orderId: string; corr: string; lines: number }[] = [];
    for (let i = 0; i < 30; i++) {
      const lines = [AMBIENT[i % 4]!, AMBIENT[(i + 1) % 4]!, ...(i % 3 === 0 ? FROZEN : [])].map((sku) => ({
        sku,
        qty: 1 + (i % 3),
      }));
      const corr = `k2-corr-${i}-${newId()}`;
      placed.push({
        orderId: await place(ctx, customers[i % 20]!, 1, lines, corr),
        corr,
        lines: lines.length,
      });
    }
    await waitFor(async () => (await tasks()) === 30, { what: '30 pick tasks', timeoutMs: 90_000 });
    const endToEndMs = Date.now() - t0;
    const { rows } = await pool.query<{
      order_id: string;
      status: string;
      route_status: string;
      correlation_id: string;
      route: { stops: { orderLineId: string }[]; unrouted: unknown[]; algorithm: string };
    }>('SELECT order_id, status, route_status, correlation_id, route FROM pick_tasks');
    const byOrder = new Map(rows.map((r) => [r.order_id, r]));
    for (const p of placed) {
      const t = byOrder.get(p.orderId)!;
      expect(t.status).toBe('open');
      expect(t.route_status).toBe('feasible');
      expect(t.route.stops).toHaveLength(p.lines);
      expect(t.route.unrouted).toHaveLength(0);
      expect(t.correlation_id).toBe(p.corr); // HTTP/actor → orders → outbox → Kafka header/envelope → task
    }
    await waitFor(lagZero, { what: 'consumer lag 0 (offsets committed after DB commit)', timeoutMs: 30_000 });
    const algorithms = rows.reduce<Record<string, number>>(
      (m, r) => ((m[r.route.algorithm] = (m[r.route.algorithm] ?? 0) + 1), m),
      {},
    );
    evidence.placedToTasks = { orders: 30, endToEndMs, algorithms, lagAfterwards: 0 };
  });

  it('per-key ordering: orders cancelled right after placement never end with an active task', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 20; i++) ids.push(await place(ctx, customers[i]!, 1, [{ sku: 'K2-A', qty: 1 }]));
    for (const id of ids.slice(0, 10))
      await cancelOrder(
        ctx,
        { orderId: id, reason: 'customer_request' },
        { actorId: null, correlationId: 'k2-cancel' },
      );
    await waitFor(
      async () =>
        (await countRows(
          pool,
          `SELECT count(*)::int AS n FROM outbox o WHERE o.event_type IN ('order.placed','order.cancelled')
             AND NOT EXISTS (SELECT 1 FROM processed_events p WHERE p.event_id = o.event_id)`,
        )) === 0,
      { what: 'all placed/cancelled events consumed', timeoutMs: 60_000 },
    );
    const active = await countRows(
      pool,
      `SELECT count(*)::int AS n FROM pick_tasks WHERE order_id = ANY($1::uuid[]) AND status IN ('open','claimed')`,
      [ids.slice(0, 10)],
    );
    const openForLive = await countRows(
      pool,
      `SELECT count(*)::int AS n FROM pick_tasks WHERE order_id = ANY($1::uuid[]) AND status = 'open'`,
      [ids.slice(10)],
    );
    expect(active).toBe(0);
    expect(openForLive).toBe(10);
    const cancelledOutcomes = await pool.query<{ outcome: string; n: number }>(
      `SELECT outcome, count(*)::int AS n FROM processed_events WHERE event_type = 'order.cancelled' GROUP BY 1`,
    );
    evidence.cancelOrdering = {
      cancelled: 10,
      activeTasksForCancelledOrders: active,
      cancelledEventOutcomes: cancelledOutcomes.rows,
    };
  });

  it('redelivery after a publisher crash between broker ack and outbox mark: duplicates skipped, effects unchanged', async () => {
    // Reproduces exactly the persisted state of that crash window: the broker holds the events, the outbox rows are
    // still unmarked. The publisher re-sends them to the REAL broker; the consumer must deduplicate.
    const before = {
      tasks: await tasks(),
      processed: await countRows(pool, 'SELECT count(*)::int AS n FROM processed_events'),
      statuses: (await pool.query('SELECT order_id, status FROM pick_tasks ORDER BY order_id')).rows,
    };
    const dupBefore = worker!.consumers[0]!.stats.duplicate;
    const resent = await countRows(
      pool,
      `WITH u AS (UPDATE outbox SET published_at = NULL WHERE published_at IS NOT NULL RETURNING event_type)
       SELECT count(*) FILTER (WHERE event_type IN ('order.placed','order.cancelled','order.picked'))::int AS n FROM u`,
    );
    await waitFor(async () => worker!.consumers[0]!.stats.duplicate - dupBefore >= resent, {
      what: `${resent} duplicate deliveries detected`,
      timeoutMs: 90_000,
    });
    const after = {
      tasks: await tasks(),
      processed: await countRows(pool, 'SELECT count(*)::int AS n FROM processed_events'),
      statuses: (await pool.query('SELECT order_id, status FROM pick_tasks ORDER BY order_id')).rows,
    };
    expect(after.tasks).toBe(before.tasks);
    expect(after.processed).toBe(before.processed);
    expect(after.statuses).toEqual(before.statuses);
    evidence.redelivery = {
      subscribedEventsRedelivered: resent,
      duplicatesSkipped: worker!.consumers[0]!.stats.duplicate - dupBefore,
      tasksBefore: before.tasks,
      tasksAfter: after.tasks,
    };
  });

  it('a stale event (new event id, already-applied aggregate version) has no effect', async () => {
    const { rows } = await pool.query<{ aggregate_id: string; payload: unknown; aggregate_version: number }>(
      `SELECT o.aggregate_id, o.payload, o.aggregate_version FROM outbox o
         JOIN orders ord ON ord.id::text = o.aggregate_id
        WHERE o.event_type = 'order.placed' AND ord.status = 'cancelled' LIMIT 1`,
    );
    const ev = rows[0]!;
    const staleId = newId();
    await produceRaw(prefix + Topics.orders, [
      {
        key: ev.aggregate_id,
        value: JSON.stringify({
          eventId: staleId,
          type: 'order.placed',
          schemaVersion: 1,
          aggregateType: 'order',
          aggregateId: ev.aggregate_id,
          aggregateVersion: ev.aggregate_version,
          occurredAt: new Date().toISOString(),
          correlationId: 'k2-stale',
          payload: ev.payload,
        }),
      },
    ]);
    const outcome = await waitFor(
      async () =>
        (
          await pool.query<{ outcome: string }>('SELECT outcome FROM processed_events WHERE event_id = $1', [
            staleId,
          ])
        ).rows[0]?.outcome,
      { what: 'stale event recorded' },
    );
    expect(outcome).toBe('stale');
    expect(
      await countRows(
        pool,
        `SELECT count(*)::int AS n FROM pick_tasks WHERE order_id = $1 AND status = 'open'`,
        [ev.aggregate_id],
      ),
    ).toBe(0);
    evidence.staleEvent = { outcome };
  });

  it('routing never blocks fulfilment: unplanned (no layout), infeasible (cold chain), fallback (optimizer failure)', async () => {
    const unplanned = await place(ctx, customers[0]!, 2, [{ sku: 'K2-A', qty: 1 }]);
    const infeasible = await place(ctx, customers[1]!, 3, [
      { sku: 'K2-A', qty: 1 },
      { sku: 'K2-F1', qty: 1 },
    ]);
    const status = (id: string) =>
      pool
        .query<{
          route_status: string;
          route: { stops: unknown[]; algorithm: string | null; reason: string | null };
        }>('SELECT route_status, route FROM pick_tasks WHERE order_id = $1', [id])
        .then((r) => r.rows[0]);
    const u = await waitFor(() => status(unplanned), { what: 'unplanned task' });
    const inf = await waitFor(() => status(infeasible), { what: 'infeasible task' });
    expect(u.route_status).toBe('unplanned');
    expect(u.route.reason).toBe('no_store_layout');
    expect(inf.route_status).toBe('infeasible');
    expect(inf.route.stops).toHaveLength(0); // an infeasible route is never presented as usable
    // Optimizer failure (runbook E11): restart the worker with the optimizer forced to fail.
    await worker!.stop();
    worker = await startWorker(prefix, {}, { failOptimizer: () => true });
    const fb = await place(ctx, customers[2]!, 1, [
      { sku: 'K2-A', qty: 1 },
      { sku: 'K2-C', qty: 1 },
      { sku: 'K2-D', qty: 1 },
    ]);
    const f = await waitFor(() => status(fb), { what: 'fallback task', timeoutMs: 90_000 });
    expect(f.route_status).toBe('fallback');
    expect(f.route.algorithm).toBe('s_shape');
    expect(f.route.stops).toHaveLength(3);
    evidence.routing = {
      unplanned: u.route.reason,
      infeasible: inf.route.reason,
      fallback: f.route.algorithm,
    };
  });

  it('global invariants I1–I6 hold after the workflow', async () => {
    await waitFor(
      async () =>
        (await countRows(pool, 'SELECT count(*)::int AS n FROM outbox WHERE published_at IS NULL')) === 0,
      { what: 'outbox drained' },
    );
    await waitFor(lagZero, { what: 'consumer lag 0', timeoutMs: 30_000 });
    const rows = await checkInvariants(databaseUrl(), {
      outboxThreshold: '0 seconds',
      consumerThreshold: '0 seconds',
    });
    evidence.invariants = rows.map((r) => `${r.invariant}:${r.status}`);
    for (const r of rows) expect(r.status, `${r.invariant} ${JSON.stringify(r.sample)}`).toBe('PASS');
    expect(rows.map((r) => r.invariant)).toEqual(['I1', 'I2', 'I3', 'I4', 'I5', 'I6', 'I7']);
  });
});
