/**
 * T6 — outbox late commit. In the audit prototype a publisher polling `WHERE id > last_published_id` lost an event
 * deterministically. AisleForge's OutboxPublisher claims by `published_at IS NULL`. A negative control re-runs the
 * naive watermark poller against the same sequence to prove the scenario really reproduces the loss.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import { OutboxPublisher, outboxBacklog, type EventProducer, type OutboundMessage } from '@aisleforge/worker';
import { databaseUrl, makePool, resetDatabase, writeEvidence } from '../support/db';

const pool = makePool(10);
const LOCK = 990_001;

class RecordingProducer implements EventProducer {
  sent: OutboundMessage[] = [];
  failNext = 0;
  async send(messages: OutboundMessage[]): Promise<void> {
    if (this.failNext > 0) {
      this.failNext--;
      throw new Error('broker unavailable (simulated)');
    }
    this.sent.push(...messages);
  }
}

async function insertOutbox(client: pg.ClientBase | pg.Pool, label: string): Promise<void> {
  await client.query(
    `INSERT INTO outbox (event_id, topic, partition_key, event_type, schema_version, aggregate_type, aggregate_id,
                         aggregate_version, payload, occurred_at)
     VALUES (gen_random_uuid(), 'aisleforge.order.events', $1, 'test.event', 1, 'test', $1, 1, jsonb_build_object('label', $1::text), now())`,
    [label],
  );
}

beforeEach(async () => {
  await resetDatabase(pool);
});
afterAll(async () => {
  await pool.end();
});

describe('T6 transactional outbox publisher', () => {
  it('publishes a late-committing event that was allocated a LOWER id than an already-published one', async () => {
    const producer = new RecordingProducer();
    const pub = new OutboxPublisher(pool, producer, { batchSize: 100, idleDelayMs: 10, leaderLockKey: LOCK });
    expect(await pub.tryAcquireLeadership()).toBe(true);

    const slow = new pg.Client({ connectionString: databaseUrl() });
    await slow.connect();
    await slow.query('BEGIN');
    await insertOutbox(slow, 'A_slow_tx'); // gets id 1, not yet committed
    await insertOutbox(pool, 'B_fast_tx'); // gets id 2, autocommits

    const first = await pub.publishOnce(); // sees only B
    await slow.query('COMMIT'); // A becomes visible with an id below B's
    await slow.end();
    const second = await pub.publishOnce(); // must pick up A
    const third = await pub.publishOnce();

    const labels = producer.sent.map(
      (m) => (JSON.parse(m.value) as { payload: { label: string } }).payload.label,
    );
    const backlog = await outboxBacklog(pool);
    await pub.releaseLeadership();

    // Negative control: the naive watermark poller over the same commit sequence loses A.
    await resetDatabase(pool);
    const slow2 = new pg.Client({ connectionString: databaseUrl() });
    await slow2.connect();
    await slow2.query('BEGIN');
    await insertOutbox(slow2, 'A_slow_tx');
    await insertOutbox(pool, 'B_fast_tx');
    let watermark = 0;
    const naive: string[] = [];
    const poll = async () => {
      const { rows } = await pool.query<{ id: number; label: string }>(
        `SELECT id, payload->>'label' AS label FROM outbox WHERE id > $1 ORDER BY id`,
        [watermark],
      );
      for (const r of rows) {
        naive.push(r.label);
        watermark = Math.max(watermark, r.id);
      }
    };
    await poll();
    await slow2.query('COMMIT');
    await slow2.end();
    await poll();

    writeEvidence('phase2', 'T6-outbox-late-commit', {
      publisher: { cycles: [first, second, third], publishedInOrder: labels, backlogAfter: backlog },
      negativeControlWatermarkPoller: {
        published: naive,
        lost: ['A_slow_tx', 'B_fast_tx'].filter((l) => !naive.includes(l)),
      },
    });

    expect(first.published).toBe(1);
    expect(second.published).toBe(1);
    expect(third.claimed).toBe(0);
    expect(labels.sort()).toEqual(['A_slow_tx', 'B_fast_tx']);
    expect(new Set(producer.sent.map((m) => m.headers['event-id'])).size).toBe(2); // each exactly once
    expect(backlog.unpublished).toBe(0);
    expect(naive).toEqual(['B_fast_tx']); // control reproduces the loss
  });

  it('never marks rows published when the broker fails; they are retried later', async () => {
    const producer = new RecordingProducer();
    const pub = new OutboxPublisher(pool, producer, { batchSize: 100, idleDelayMs: 10, leaderLockKey: LOCK });
    await pub.tryAcquireLeadership();
    for (let i = 0; i < 5; i++) await insertOutbox(pool, `e${i}`);
    producer.failNext = 2;
    expect(await pub.publishOnce()).toMatchObject({ published: 0, failed: 5 });
    expect(await pub.publishOnce()).toMatchObject({ published: 0, failed: 5 });
    const mid = await pool.query(
      `SELECT count(*)::int AS n, max(publish_attempts)::int AS attempts, max(last_error) AS err FROM outbox WHERE published_at IS NULL`,
    );
    expect(mid.rows[0]).toMatchObject({ n: 5, attempts: 2 });
    expect(mid.rows[0].err).toMatch(/broker unavailable/);
    expect(await pub.publishOnce()).toMatchObject({ published: 5, failed: 0 });
    expect((await outboxBacklog(pool)).unpublished).toBe(0);
    await pub.releaseLeadership();
  });

  it('allows exactly one leader; leadership transfers when the leader releases it', async () => {
    const a = new OutboxPublisher(pool, new RecordingProducer(), {
      batchSize: 10,
      idleDelayMs: 10,
      leaderLockKey: LOCK,
    });
    const b = new OutboxPublisher(pool, new RecordingProducer(), {
      batchSize: 10,
      idleDelayMs: 10,
      leaderLockKey: LOCK,
    });
    expect(await a.tryAcquireLeadership()).toBe(true);
    expect(await b.tryAcquireLeadership()).toBe(false);
    await expect(b.publishOnce()).rejects.toThrow(/without leadership/);
    await a.releaseLeadership();
    expect(await b.tryAcquireLeadership()).toBe(true);
    await b.releaseLeadership();
  });

  it('preserves outbox id order within a batch and carries correlation/event headers', async () => {
    const producer = new RecordingProducer();
    const pub = new OutboxPublisher(pool, producer, { batchSize: 3, idleDelayMs: 10, leaderLockKey: LOCK });
    await pub.tryAcquireLeadership();
    for (let i = 0; i < 7; i++) await insertOutbox(pool, `e${i}`);
    let cycles = 0;
    while ((await pub.publishOnce()).claimed > 0) cycles++;
    await pub.releaseLeadership();
    expect(cycles).toBe(3);
    expect(producer.sent.map((m) => m.outboxId)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(producer.sent[0]!.headers).toMatchObject({ 'event-type': 'test.event', 'schema-version': '1' });
  });
});
