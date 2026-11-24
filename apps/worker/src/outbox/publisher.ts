import type { PgClient, PgPool } from '@aisleforge/database';
import { backoffMs, sleep, type Logger } from '@aisleforge/shared';

/** One message as handed to the broker. `headers` carries event metadata (incl. correlation id). */
export interface OutboundMessage {
  outboxId: number;
  topic: string;
  key: string;
  value: string;
  headers: Record<string, string>;
}

/**
 * Broker abstraction. `send` must resolve ONLY after the broker acknowledged every message (acks=all) and must
 * preserve order of messages that share a key. The Kafka implementation is KafkaEventProducer (../kafka/client.ts).
 */
export interface EventProducer {
  send(messages: OutboundMessage[]): Promise<void>;
}

export interface PublisherOptions {
  batchSize: number;
  idleDelayMs: number;
  /** Session advisory-lock key; exactly one publisher process holds it (single leader, per-key ordering). */
  leaderLockKey: number;
  /** Prepended to every outbox topic (environment namespacing, e.g. per test run). Empty in production. */
  topicPrefix?: string;
  logger?: Logger;
}

interface OutboxRow {
  id: number;
  event_id: string;
  topic: string;
  partition_key: string;
  event_type: string;
  schema_version: number;
  aggregate_type: string;
  aggregate_id: string;
  aggregate_version: number;
  correlation_id: string | null;
  payload: unknown;
  occurred_at: Date;
}

export interface PublishResult {
  claimed: number;
  published: number;
  failed: number;
}

export const DEFAULT_PUBLISHER_LOCK_KEY = 7_411_101;

/**
 * Transactional-outbox publisher (ADR-003).
 *
 * Correctness rules, each covered by tests/concurrency/t6-outbox.test.ts:
 *  - Claims rows by `published_at IS NULL` (partial index), never by an id/time high-watermark: sequence values are
 *    allocated at INSERT, not COMMIT, so a watermark skips late-committing rows (audit T6).
 *  - Single leader via a PostgreSQL session advisory lock held on a dedicated connection. Two concurrent publishers
 *    could otherwise send events of the same aggregate out of order.
 *  - Publishes BEFORE marking: rows are marked published only after the broker acknowledged them. A crash between
 *    ack and mark republishes (at-least-once) — consumers deduplicate by event_id.
 *  - No database transaction is held open across the network call.
 *  - Failed sends keep the rows (attempts + last_error recorded) for retry with backoff.
 */
export class OutboxPublisher {
  private leaderClient: PgClient | null = null;
  private running = false;
  consecutiveFailures = 0;
  publishedTotal = 0;
  failedBatches = 0;
  lastPublishedAt: Date | null = null;
  lastError: string | null = null;

  constructor(
    private readonly pool: PgPool,
    private readonly producer: EventProducer,
    private readonly opts: PublisherOptions,
  ) {}

  get isLeader(): boolean {
    return this.leaderClient !== null;
  }

  /** Non-blocking leadership attempt; the lock lives as long as the dedicated session. */
  async tryAcquireLeadership(): Promise<boolean> {
    if (this.leaderClient) return true;
    const client = await this.pool.connect();
    try {
      const { rows } = await client.query<{ ok: boolean }>('SELECT pg_try_advisory_lock($1) AS ok', [
        this.opts.leaderLockKey,
      ]);
      if (rows[0]?.ok) {
        this.leaderClient = client;
        // If the leader session dies (DB restart), leadership is lost; drop it so it is re-acquired.
        client.on('error', (err) => {
          this.opts.logger?.warn({ err }, 'outbox leader session lost');
          void this.releaseLeadership(true);
        });
        this.opts.logger?.info('outbox publisher leadership acquired');
        return true;
      }
      client.release();
      return false;
    } catch (e) {
      client.release(true);
      throw e;
    }
  }

  async releaseLeadership(broken = false): Promise<void> {
    const c = this.leaderClient;
    this.leaderClient = null;
    if (!c) return;
    if (!broken)
      await c.query('SELECT pg_advisory_unlock($1)', [this.opts.leaderLockKey]).catch(() => undefined);
    c.release(broken);
  }

  /** One claim → send → mark cycle. Only call while leader. */
  async publishOnce(): Promise<PublishResult> {
    if (!this.leaderClient) throw new Error('publishOnce called without leadership');
    const { rows } = await this.pool.query<OutboxRow>(
      `SELECT id, event_id, topic, partition_key, event_type, schema_version, aggregate_type, aggregate_id,
              aggregate_version, correlation_id, payload, occurred_at
         FROM outbox WHERE published_at IS NULL ORDER BY id LIMIT $1`,
      [this.opts.batchSize],
    );
    if (rows.length === 0) return { claimed: 0, published: 0, failed: 0 };
    const messages = rows.map((r) => toMessage(r, this.opts.topicPrefix ?? ''));
    const ids = rows.map((r) => r.id);
    try {
      await this.producer.send(messages); // network call — no transaction open
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.lastError = msg;
      this.consecutiveFailures++;
      this.failedBatches++;
      await this.pool.query(
        `UPDATE outbox SET publish_attempts = publish_attempts + 1, last_error = left($2, 2000) WHERE id = ANY($1::bigint[])`,
        [ids, msg],
      );
      this.opts.logger?.warn({ err: e, batch: ids.length }, 'outbox publish failed; rows kept for retry');
      return { claimed: rows.length, published: 0, failed: rows.length };
    }
    await this.pool.query(
      `UPDATE outbox SET published_at = clock_timestamp(), publish_attempts = publish_attempts + 1, last_error = NULL
        WHERE id = ANY($1::bigint[]) AND published_at IS NULL`,
      [ids],
    );
    this.consecutiveFailures = 0;
    this.publishedTotal += rows.length;
    this.lastPublishedAt = new Date();
    this.lastError = null;
    return { claimed: rows.length, published: rows.length, failed: 0 };
  }

  /** Loop: acquire leadership (or wait), publish while there is work, back off on failure or idleness. */
  async run(signal: AbortSignal): Promise<void> {
    this.running = true;
    try {
      while (!signal.aborted) {
        if (!(await this.tryAcquireLeadership().catch(() => false))) {
          await sleep(this.opts.idleDelayMs * 5);
          continue;
        }
        const r = await this.publishOnce().catch((e: unknown) => {
          this.opts.logger?.error({ err: e }, 'outbox cycle error');
          this.consecutiveFailures++;
          return { claimed: 0, published: 0, failed: 1 };
        });
        if (r.failed > 0) await sleep(backoffMs(Math.min(this.consecutiveFailures, 8), 100, 10_000));
        else if (r.claimed < this.opts.batchSize) await sleep(this.opts.idleDelayMs);
      }
    } finally {
      this.running = false;
      await this.releaseLeadership();
    }
  }
}

function toMessage(r: OutboxRow, topicPrefix: string): OutboundMessage {
  const envelope = {
    eventId: r.event_id,
    type: r.event_type,
    schemaVersion: r.schema_version,
    aggregateType: r.aggregate_type,
    aggregateId: r.aggregate_id,
    aggregateVersion: r.aggregate_version,
    occurredAt: new Date(r.occurred_at).toISOString(),
    correlationId: r.correlation_id,
    payload: r.payload,
  };
  const headers: Record<string, string> = {
    'event-id': r.event_id,
    'event-type': r.event_type,
    'schema-version': String(r.schema_version),
  };
  if (r.correlation_id) headers['correlation-id'] = r.correlation_id;
  return {
    outboxId: r.id,
    topic: topicPrefix + r.topic,
    key: r.partition_key,
    value: JSON.stringify(envelope),
    headers,
  };
}

export { outboxBacklog } from '@aisleforge/domain';
