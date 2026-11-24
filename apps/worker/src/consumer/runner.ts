import { withTransaction, type PgClient, type PgPool } from '@aisleforge/database';
import {
  deadLetterTopic,
  isKnownEventType,
  parseEnvelope,
  parsePayload,
  type Envelope,
  type EventType,
} from '@aisleforge/events';
import { backoffMs, isAppError, sleep, type Logger } from '@aisleforge/shared';
import type { KafkaClient, KafkaConsumer, KafkaEventProducer } from '../kafka/client';
import type { KafkaJS } from '@confluentinc/kafka-javascript';

/** Outcome of applying one event inside the consumer's transaction. */
export type ApplyOutcome = 'applied' | 'ignored';

export interface HandlerContext {
  envelope: Envelope;
  logger: Logger;
}

export interface EventHandler<P = unknown> {
  /** Optional read-only preparation OUTSIDE the write transaction (e.g. CPU-bound route planning). */
  prepare?(ctx: HandlerContext, pool: PgPool): Promise<P>;
  /** Effects. Runs in the same transaction as the processed_events insert; must be deterministic for retries. */
  apply(c: PgClient, ctx: HandlerContext, prepared: P): Promise<ApplyOutcome>;
}

/** Thrown by handlers for failures that retrying cannot fix (bad references, contract violations). */
export class NonRetriableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NonRetriableError';
  }
}

export interface ConsumerDefinition {
  /** consumer_name in processed_events (and the Kafka consumer group id unless `groupId` is set). */
  name: string;
  /** Kafka consumer group id; defaults to `name`. Differs only when topics are namespaced (KAFKA_TOPIC_PREFIX). */
  groupId?: string;
  topics: string[];
  handlers: Partial<Record<EventType, EventHandler<never>>>;
  /** Track aggregate versions and skip events at or below the last applied version. */
  versionCheck: boolean;
}

export interface ConsumerOptions {
  maxAttempts: number;
  retryBaseMs: number;
  retryMaxMs: number;
  sessionTimeoutMs: number;
  /** Partitions processed in parallel (order is preserved WITHIN a partition). */
  partitionsConcurrently: number;
}

export type MessageResult = 'applied' | 'ignored' | 'stale' | 'duplicate' | 'dead_lettered' | 'skipped_type';

export interface ConsumerStats {
  applied: number;
  ignored: number;
  stale: number;
  duplicate: number;
  dead_lettered: number;
  skipped_type: number;
  retries: number;
  offsetCommitFailures: number;
}

interface Inbound {
  topic: string;
  partition: number;
  offset: string;
  key: string | null;
  value: string | null;
  headers: Record<string, string>;
}

type Classified =
  | { kind: 'ok'; envelope: Envelope; type: EventType }
  | { kind: 'not_subscribed'; envelope: Envelope }
  | {
      kind: 'poison';
      errorKind: 'invalid_message' | 'unknown_event_type';
      error: string;
      envelope?: Envelope;
    };

/**
 * Kafka consumer with database-backed exactly-once EFFECTS (ADR-003):
 *
 *  1. Decode + validate the envelope and typed payload. Malformed/unknown messages are poison → dead letter.
 *  2. In ONE PostgreSQL transaction: insert processed_events (ON CONFLICT DO NOTHING — a duplicate stops here),
 *     check the aggregate version (stale → recorded, no effects), apply the handler's effects, record the version.
 *  3. Only after that transaction commits, commit the Kafka offset (offset + 1).
 *
 * A crash anywhere before step 3 redelivers the message; step 2 then finds the processed_events row and skips.
 * Handler failures are retried in place (bounded, full-jitter backoff), which blocks only this partition; after
 * `maxAttempts` the message is dead-lettered (DB row + <topic>.dlt copy) and the partition moves on.
 */
export class EventConsumer {
  private consumer: KafkaConsumer | null = null;
  readonly stats: ConsumerStats = {
    applied: 0,
    ignored: 0,
    stale: 0,
    duplicate: 0,
    dead_lettered: 0,
    skipped_type: 0,
    retries: 0,
    offsetCommitFailures: 0,
  };
  lastError: string | null = null;
  lastProcessedAt: Date | null = null;
  running = false;

  constructor(
    private readonly def: ConsumerDefinition,
    private readonly kafka: KafkaClient,
    private readonly pool: PgPool,
    private readonly dltProducer: KafkaEventProducer,
    private readonly opts: ConsumerOptions,
    private readonly logger: Logger,
  ) {}

  get name(): string {
    return this.def.name;
  }
  get topics(): string[] {
    return this.def.topics;
  }
  get groupId(): string {
    return this.def.groupId ?? this.def.name;
  }

  assignment(): { topic: string; partition: number }[] {
    try {
      return this.consumer?.assignment() ?? [];
    } catch {
      return [];
    }
  }

  /** Committed offsets of this consumer's current assignment, read through its own consumer group (see consumerLag). */
  async committed(): Promise<{ topic: string; partition: number; offset: string }[]> {
    const c = this.consumer;
    if (!c) return [];
    const parts = this.assignment();
    if (parts.length === 0) return [];
    const res = await c.committed(parts, 5_000);
    return res.map((r) => ({ topic: r.topic, partition: r.partition, offset: String(r.offset) }));
  }

  async start(): Promise<void> {
    const consumer = this.kafka.consumer({
      'session.timeout.ms': this.opts.sessionTimeoutMs,
      'heartbeat.interval.ms': Math.max(1000, Math.floor(this.opts.sessionTimeoutMs / 3)),
      // A handler retrying a poison message must not be mistaken for a dead consumer.
      'max.poll.interval.ms': Math.max(60_000, this.opts.maxAttempts * this.opts.retryMaxMs * 2),
      kafkaJS: {
        groupId: this.groupId,
        fromBeginning: true,
        autoCommit: false,
        allowAutoTopicCreation: false,
      },
    } as KafkaJS.ConsumerConstructorConfig);
    await consumer.connect();
    await consumer.subscribe({ topics: this.def.topics });
    this.consumer = consumer;
    this.running = true;
    await consumer.run({
      partitionsConsumedConcurrently: this.opts.partitionsConcurrently,
      eachMessage: async ({ topic, partition, message }) => {
        const inbound: Inbound = {
          topic,
          partition,
          offset: message.offset,
          key: message.key ? message.key.toString('utf8') : null,
          value: message.value ? message.value.toString('utf8') : null,
          headers: decodeHeaders(message.headers),
        };
        await this.handle(inbound);
        await this.commit(topic, partition, message.offset);
      },
    });
  }

  async stop(): Promise<void> {
    const c = this.consumer;
    this.consumer = null;
    this.running = false;
    if (c) await c.disconnect().catch((err: unknown) => this.logger.warn({ err }, 'consumer disconnect'));
  }

  private async commit(topic: string, partition: number, offset: string): Promise<void> {
    try {
      await this.consumer?.commitOffsets([{ topic, partition, offset: String(BigInt(offset) + 1n) }]);
    } catch (err) {
      // E.g. the partition was revoked by a rebalance. The message will be redelivered to the new owner and
      // deduplicated by processed_events, so this is safe; it is counted for diagnostics.
      this.stats.offsetCommitFailures++;
      this.logger.warn(
        { err, topic, partition, offset },
        'offset commit failed; redelivery will be deduplicated',
      );
    }
  }

  /** Processes one message to a terminal result. Exposed for diagnostics/tests; never throws except on shutdown. */
  async handle(m: Inbound): Promise<MessageResult> {
    const classified = this.classify(m);
    const log = this.logger.child({
      consumer: this.def.name,
      topic: m.topic,
      partition: m.partition,
      offset: m.offset,
      eventId: 'envelope' in classified ? classified.envelope?.eventId : undefined,
      correlationId:
        'envelope' in classified ? classified.envelope?.correlationId : m.headers['correlation-id'],
    });
    if (classified.kind === 'not_subscribed') {
      this.stats.skipped_type++;
      return 'skipped_type';
    }
    if (classified.kind === 'poison') {
      await this.deadLetter(m, classified.errorKind, classified.error, 1, classified.envelope, log);
      return 'dead_lettered';
    }
    const { envelope, type } = classified;
    const handler = this.def.handlers[type] as EventHandler<unknown>;
    const ctx: HandlerContext = { envelope, logger: log };
    let lastErr: unknown;
    for (let attempt = 1; attempt <= this.opts.maxAttempts; attempt++) {
      try {
        const prepared = handler.prepare ? await handler.prepare(ctx, this.pool) : undefined;
        const result = await this.applyInTx(m, envelope, handler, ctx, prepared);
        this.stats[result]++;
        this.lastProcessedAt = new Date();
        if (result === 'duplicate') log.info({ eventType: type }, 'duplicate delivery skipped');
        else log.debug({ eventType: type, result }, 'event processed');
        return result;
      } catch (err) {
        lastErr = err;
        this.lastError = err instanceof Error ? err.message : String(err);
        if (err instanceof NonRetriableError) break;
        if (attempt < this.opts.maxAttempts) {
          this.stats.retries++;
          const delay = backoffMs(attempt, this.opts.retryBaseMs, this.opts.retryMaxMs);
          log.warn({ err, attempt, delayMs: delay }, 'handler failed; retrying');
          await sleep(delay);
        }
      }
    }
    const attempts = lastErr instanceof NonRetriableError ? 1 : this.opts.maxAttempts;
    const message = describeError(lastErr);
    await this.deadLetter(m, 'handler_failed', message, attempts, envelope, log);
    return 'dead_lettered';
  }

  private classify(m: Inbound): Classified {
    if (m.value === null)
      return { kind: 'poison', errorKind: 'invalid_message', error: 'empty message value' };
    let raw: unknown;
    try {
      raw = JSON.parse(m.value);
    } catch (e) {
      return { kind: 'poison', errorKind: 'invalid_message', error: `invalid JSON: ${(e as Error).message}` };
    }
    let envelope: Envelope;
    try {
      envelope = parseEnvelope(raw);
    } catch (e) {
      return { kind: 'poison', errorKind: 'invalid_message', error: `invalid envelope: ${summarize(e)}` };
    }
    if (!isKnownEventType(envelope.type))
      return {
        kind: 'poison',
        errorKind: 'unknown_event_type',
        error: `unknown event type '${envelope.type}'`,
        envelope,
      };
    const type: EventType = envelope.type;
    if (!this.def.handlers[type]) return { kind: 'not_subscribed', envelope };
    try {
      envelope = { ...envelope, payload: parsePayload(type, envelope.payload) };
    } catch (e) {
      return {
        kind: 'poison',
        errorKind: 'invalid_message',
        error: `invalid ${type} payload: ${summarize(e)}`,
        envelope,
      };
    }
    return { kind: 'ok', envelope, type };
  }

  private applyInTx(
    m: Inbound,
    env: Envelope,
    handler: EventHandler<unknown>,
    ctx: HandlerContext,
    prepared: unknown,
  ): Promise<Exclude<MessageResult, 'dead_lettered' | 'skipped_type'>> {
    return withTransaction(this.pool, { label: `consume.${this.def.name}`, maxAttempts: 4 }, async (c) => {
      // 1. Dedupe guard FIRST: a concurrent duplicate (rebalance/zombie) blocks on this key, then sees the conflict.
      const ins = await c.query(
        `INSERT INTO processed_events (consumer_name, event_id, event_type, topic, kafka_partition, kafka_offset, outcome)
         VALUES ($1, $2, $3, $4, $5, $6, 'applied') ON CONFLICT (consumer_name, event_id) DO NOTHING`,
        [this.def.name, env.eventId, env.type, m.topic, m.partition, m.offset],
      );
      if (ins.rowCount === 0) return 'duplicate';
      // 2. Aggregate version check (stale events, e.g. replays of superseded events, have no effect).
      if (this.def.versionCheck) {
        const v = await c.query<{ version: number }>(
          `SELECT version FROM consumer_aggregate_versions
            WHERE consumer_name = $1 AND aggregate_type = $2 AND aggregate_id = $3 FOR UPDATE`,
          [this.def.name, env.aggregateType, env.aggregateId],
        );
        const last = v.rows[0]?.version;
        if (last !== undefined && env.aggregateVersion <= last) {
          await setOutcome(c, this.def.name, env.eventId, 'stale');
          ctx.logger.info(
            { aggregateVersion: env.aggregateVersion, lastApplied: last },
            'stale event skipped (version already applied)',
          );
          return 'stale';
        }
      }
      // 3. Effects.
      const outcome = await handler.apply(c, ctx, prepared);
      if (outcome === 'ignored') await setOutcome(c, this.def.name, env.eventId, 'ignored');
      if (this.def.versionCheck)
        await c.query(
          `INSERT INTO consumer_aggregate_versions (consumer_name, aggregate_type, aggregate_id, version)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (consumer_name, aggregate_type, aggregate_id)
           DO UPDATE SET version = GREATEST(consumer_aggregate_versions.version, EXCLUDED.version),
                         updated_at = clock_timestamp()`,
          [this.def.name, env.aggregateType, env.aggregateId, env.aggregateVersion],
        );
      return outcome;
    });
  }

  /**
   * Poison message: durable DB record first (idempotent per source offset), then a copy on <topic>.dlt with the
   * failure reason in headers. If either step fails, this throws so the offset is NOT committed and the message
   * is redelivered (after a pause) — a poison message is never dropped silently.
   */
  private async deadLetter(
    m: Inbound,
    errorKind: 'invalid_message' | 'unknown_event_type' | 'handler_failed',
    error: string,
    attempts: number,
    envelope: Envelope | undefined,
    log: Logger,
  ): Promise<void> {
    try {
      const { rows } = await this.pool.query<{ id: number; dlt_published_at: Date | null }>(
        `INSERT INTO dead_letters (consumer_name, topic, kafka_partition, kafka_offset, kafka_key, raw_value, headers,
                                   event_id, event_type, correlation_id, error_kind, error_message, attempts)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, left($12, 4000), $13)
         ON CONFLICT ON CONSTRAINT dead_letters_source_unique
         DO UPDATE SET attempts = dead_letters.attempts + EXCLUDED.attempts
         RETURNING id, dlt_published_at`,
        [
          this.def.name,
          m.topic,
          m.partition,
          m.offset,
          m.key,
          m.value,
          JSON.stringify(m.headers),
          envelope?.eventId ?? null,
          envelope?.type ?? null,
          envelope?.correlationId ?? m.headers['correlation-id'] ?? null,
          errorKind,
          error,
          attempts,
        ],
      );
      const row = rows[0]!;
      if (!row.dlt_published_at) {
        await this.dltProducer.sendRaw([
          {
            topic: deadLetterTopic(m.topic),
            messages: [
              {
                key: m.key,
                value: m.value,
                headers: {
                  ...m.headers,
                  'dlt-id': String(row.id),
                  'dlt-consumer': this.def.name,
                  'dlt-error-kind': errorKind,
                  'dlt-error': error.slice(0, 500),
                  'dlt-source': `${m.topic}/${m.partition}/${m.offset}`,
                },
              },
            ],
          },
        ]);
        await this.pool.query('UPDATE dead_letters SET dlt_published_at = clock_timestamp() WHERE id = $1', [
          row.id,
        ]);
      }
      this.stats.dead_lettered++;
      log.error({ deadLetterId: row.id, errorKind, error, attempts }, 'message dead-lettered');
    } catch (err) {
      this.lastError = `dead-letter failed: ${err instanceof Error ? err.message : String(err)}`;
      log.error({ err }, 'could not dead-letter message; it will be redelivered');
      await sleep(backoffMs(4, this.opts.retryBaseMs, this.opts.retryMaxMs));
      throw err;
    }
  }
}

async function setOutcome(c: PgClient, consumer: string, eventId: string, outcome: 'stale' | 'ignored') {
  await c.query('UPDATE processed_events SET outcome = $3 WHERE consumer_name = $1 AND event_id = $2', [
    consumer,
    eventId,
    outcome,
  ]);
}

function decodeHeaders(h: KafkaJS.IHeaders | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!h) return out;
  for (const [k, v] of Object.entries(h)) {
    if (v === undefined) continue;
    const first = Array.isArray(v) ? v[0] : v;
    if (first !== undefined) out[k] = Buffer.isBuffer(first) ? first.toString('utf8') : String(first);
  }
  return out;
}

/** Operator-facing failure reason: error code, details (e.g. SQLSTATE) and the underlying cause. */
export function describeError(e: unknown): string {
  if (!(e instanceof Error)) return String(e);
  const parts = [isAppError(e) ? `${e.code}: ${e.message}` : e.message];
  if (isAppError(e) && e.details) parts.push(JSON.stringify(e.details));
  if (e.cause instanceof Error) parts.push(`(cause: ${e.cause.message})`);
  return parts.join(' ');
}

function summarize(e: unknown): string {
  if (
    typeof e === 'object' &&
    e !== null &&
    'issues' in e &&
    Array.isArray((e as { issues: unknown }).issues)
  ) {
    return (e as { issues: { path: unknown[]; message: string }[] }).issues
      .slice(0, 5)
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
  }
  return e instanceof Error ? e.message : String(e);
}
