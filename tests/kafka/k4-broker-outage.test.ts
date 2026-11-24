/**
 * K4 — Real broker outage (runbook E2): `docker compose stop kafka` while orders keep arriving.
 * Hypothesis: orders are still accepted (Kafka is not on the write path); the publisher retries with backoff and
 * never marks rows published while the broker is down; after `docker compose start kafka` the backlog drains,
 * every order gets exactly one pick task, and invariants I1–I6 hold. Outage shortened from the runbook's 5 min to
 * 60 s to keep the suite practical on this machine (documented in the Phase 2 report).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkInvariants } from '@aisleforge/database';
import type { Worker } from '@aisleforge/worker';
import {
  databaseUrl,
  makeCtx,
  makePool,
  pct,
  resetDatabase,
  seedCustomers,
  seedStock,
  seedStore,
  writeEvidence,
} from '../support/db';
import {
  compose,
  countRows,
  deleteTopicsWithPrefix,
  place,
  seedLayout,
  startWorker,
  uniquePrefix,
  waitFor,
  waitForKafkaHealthy,
} from '../support/kafka';

const OUTAGE_MS = 60_000;
const prefix = uniquePrefix('k4');
const pool = makePool(10);
const ctx = makeCtx(pool);
let worker: Worker | null = null;
let customers: string[] = [];
let kafkaStopped = false;
const evidence: Record<string, unknown> = { outageMs: OUTAGE_MS };

beforeAll(async () => {
  await resetDatabase(pool);
  await seedStore(pool, 1);
  await seedStock(ctx, 1, { 'K4-A': 100_000, 'K4-B': 100_000 });
  await seedLayout(pool, 1, { 'K4-A': { aisle: 1, pos: 9 }, 'K4-B': { aisle: 4, pos: 21 } });
  customers = await seedCustomers(pool, 10);
  worker = await startWorker(prefix, { KAFKA_DELIVERY_TIMEOUT_MS: '5000' });
});

afterAll(async () => {
  if (kafkaStopped) {
    compose(['start', 'kafka']);
    await waitForKafkaHealthy();
  }
  await worker?.stop();
  await pool.end();
  await deleteTopicsWithPrefix(prefix);
  writeEvidence('phase2', 'K4-broker-outage-E2', evidence);
});

const tasks = () => countRows(pool, 'SELECT count(*)::int AS n FROM pick_tasks');
const orders = () => countRows(pool, 'SELECT count(*)::int AS n FROM orders');

describe('K4 broker outage (E2, real docker compose stop kafka)', () => {
  it('baseline: orders flow to pick tasks while the broker is up', async () => {
    for (let i = 0; i < 20; i++) await place(ctx, customers[i % 10]!, 1, [{ sku: 'K4-A', qty: 1 }]);
    await waitFor(async () => (await tasks()) === 20, { what: '20 baseline tasks', timeoutMs: 60_000 });
  });

  it('during the outage orders are accepted, the publisher fails without marking rows, the backlog grows', async () => {
    const tStop = Date.now();
    compose(['stop', 'kafka']);
    kafkaStopped = true;
    evidence.stopCommandMs = Date.now() - tStop;
    const outageStart = Date.now();
    const failedBefore = worker!.publisher.failedBatches;
    const latencies: number[] = [];
    let errors = 0;
    let placed = 0;
    const backlogSamples: { t: number; unpublished: number }[] = [];
    while (Date.now() - outageStart < OUTAGE_MS) {
      const t0 = performance.now();
      try {
        await place(ctx, customers[placed % 10]!, 1, [
          { sku: 'K4-A', qty: 1 },
          { sku: 'K4-B', qty: 1 },
        ]);
        placed++;
      } catch {
        errors++;
      }
      latencies.push(performance.now() - t0);
      if (placed % 10 === 0)
        backlogSamples.push({
          t: Math.round((Date.now() - outageStart) / 1000),
          unpublished: await countRows(
            pool,
            'SELECT count(*)::int AS n FROM outbox WHERE published_at IS NULL',
          ),
        });
      await new Promise((r) => setTimeout(r, 100));
    }
    const markedDuringOutage = await countRows(
      pool,
      'SELECT count(*)::int AS n FROM outbox WHERE published_at >= $1',
      [new Date(outageStart + 2000)],
    );
    const unpublished = await countRows(
      pool,
      'SELECT count(*)::int AS n FROM outbox WHERE published_at IS NULL',
    );
    evidence.duringOutage = {
      ordersPlaced: placed,
      orderErrors: errors,
      placeLatencyMs: { p50: pct(latencies, 50), p95: pct(latencies, 95), p99: pct(latencies, 99) },
      publisherFailedBatches: worker!.publisher.failedBatches - failedBefore,
      publisherLastError: worker!.publisher.lastError,
      rowsMarkedPublishedWhileDown: markedDuringOutage,
      unpublishedAtEnd: unpublished,
      backlogSamples,
    };
    expect(errors).toBe(0); // Kafka is not on the order write path
    expect(placed).toBeGreaterThan(50);
    expect(worker!.publisher.failedBatches - failedBefore).toBeGreaterThan(0);
    expect(markedDuringOutage).toBe(0); // never marked published without a broker acknowledgement
    expect(unpublished).toBeGreaterThanOrEqual(placed * 2); // order.placed + balance changes per order
  });

  it('after restart the backlog drains, every order has exactly one task, and invariants I1–I6 hold', async () => {
    const tStart = Date.now();
    compose(['start', 'kafka']);
    kafkaStopped = false;
    await waitForKafkaHealthy();
    const brokerBackMs = Date.now() - tStart;
    await waitFor(
      async () =>
        (await countRows(pool, 'SELECT count(*)::int AS n FROM outbox WHERE published_at IS NULL')) === 0,
      { what: 'outbox drained after broker restart', timeoutMs: 180_000, intervalMs: 500 },
    );
    const drainedMs = Date.now() - tStart;
    const expected = await orders();
    await waitFor(async () => (await tasks()) === expected, {
      what: `${expected} tasks`,
      timeoutMs: 180_000,
      intervalMs: 500,
    });
    const tasksDoneMs = Date.now() - tStart;
    const dupTasks = await countRows(
      pool,
      'SELECT count(*)::int AS n FROM (SELECT order_id FROM pick_tasks GROUP BY 1 HAVING count(*) > 1) d',
    );
    expect(dupTasks).toBe(0);
    const rows = await checkInvariants(databaseUrl(), {
      outboxThreshold: '0 seconds',
      consumerThreshold: '0 seconds',
    });
    evidence.recovery = {
      brokerReachableAfterMs: brokerBackMs,
      outboxDrainedAfterMs: drainedMs,
      allTasksCreatedAfterMs: tasksDoneMs,
      orders: expected,
      tasks: await tasks(),
      duplicateDeliveriesSkipped: worker!.consumers[0]!.stats.duplicate,
      invariants: rows.map((r) => `${r.invariant}:${r.status}`),
    };
    for (const r of rows) expect(r.status, `${r.invariant} ${JSON.stringify(r.sample)}`).toBe('PASS');
  });
});
