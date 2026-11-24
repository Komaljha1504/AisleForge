import { createServer, type Server } from 'node:http';
import { hostname } from 'node:os';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { createPool, getTxStats, poolStatus, type PgPool } from '@aisleforge/database';
import { expireDueReservations, outboxBacklog, type DomainContext } from '@aisleforge/domain';
import { newId, sleep, type Logger } from '@aisleforge/shared';
import type { WorkerConfig } from './config';
import { orderWorkflowConsumer } from './consumer/orderWorkflow';
import { DeadLetterReplayer } from './consumer/replayer';
import { EventConsumer, type ConsumerDefinition } from './consumer/runner';
import { catalogCacheConsumer } from './consumer/catalogCache';
import { RedisClient } from '@aisleforge/cache';
import {
  APPLICATION_TOPICS,
  consumerLag,
  createKafka,
  ensureTopics,
  KafkaEventProducer,
  type KafkaAdmin,
  type KafkaClient,
  type PartitionLag,
} from './kafka/client';
import { DEFAULT_PUBLISHER_LOCK_KEY, OutboxPublisher } from './outbox/publisher';

export interface WorkerHooks {
  /** Test hook (E11): make the route optimizer fail so the S-shape fallback path is exercised end to end. */
  failOptimizer?: () => boolean;
}

/**
 * The worker process: outbox publisher (single leader), Kafka consumers, dead-letter replayer, reservation expiry
 * sweeper, and a status endpoint. Each role can be enabled separately (WORKER_ROLES) so a deployment can scale
 * consumers independently of the single publisher leader.
 */
export class Worker {
  readonly id: string;
  readonly pool: PgPool;
  readonly kafka: KafkaClient;
  readonly producer: KafkaEventProducer;
  readonly publisher: OutboxPublisher;
  readonly consumers: EventConsumer[] = [];
  readonly replayer: DeadLetterReplayer;
  readonly redis: RedisClient | null;
  private admin: KafkaAdmin | null = null;
  private readonly abort = new AbortController();
  private readonly loops: Promise<void>[] = [];
  private server: Server | null = null;
  private readonly startedAt = new Date();
  private readonly loopDelay = monitorEventLoopDelay({ resolution: 20 });
  private lagCache: { at: number; value: Record<string, PartitionLag[]> } | null = null;
  shuttingDown = false;
  sweeperRuns = 0;
  expiredReservations = 0;

  constructor(
    private readonly cfg: WorkerConfig,
    private readonly logger: Logger,
    private readonly hooks: WorkerHooks = {},
  ) {
    this.id = cfg.WORKER_ID ?? `${hostname()}-${process.pid}-${newId().slice(-6)}`;
    this.pool = createPool(cfg, { name: 'worker', max: cfg.PG_WORKER_POOL_MAX }, logger);
    const settings = {
      brokers: cfg.KAFKA_BROKERS,
      clientId: `${cfg.KAFKA_CLIENT_ID}-${this.id}`,
      deliveryTimeoutMs: cfg.KAFKA_DELIVERY_TIMEOUT_MS,
      sessionTimeoutMs: cfg.KAFKA_SESSION_TIMEOUT_MS,
    };
    this.kafka = createKafka(settings, logger);
    this.producer = new KafkaEventProducer(this.kafka, settings, logger);
    this.publisher = new OutboxPublisher(this.pool, this.producer, {
      batchSize: cfg.OUTBOX_BATCH_SIZE,
      idleDelayMs: cfg.OUTBOX_IDLE_DELAY_MS,
      leaderLockKey: DEFAULT_PUBLISHER_LOCK_KEY,
      topicPrefix: cfg.KAFKA_TOPIC_PREFIX,
      logger: logger.child({ component: 'outbox-publisher' }),
    });
    this.replayer = new DeadLetterReplayer(this.pool, this.producer, logger.child({ component: 'replayer' }));
    this.redis = cfg.REDIS_URL ? new RedisClient(cfg.REDIS_URL, logger.child({ component: 'redis' })) : null;
  }

  private has(role: WorkerConfig['WORKER_ROLES'][number]): boolean {
    return this.cfg.WORKER_ROLES.includes(role);
  }

  async start(opts: { statusServer?: boolean } = {}): Promise<void> {
    this.loopDelay.enable();
    const signal = this.abort.signal;
    this.admin = this.kafka.admin();
    await this.admin.connect();
    const prefix = this.cfg.KAFKA_TOPIC_PREFIX;
    const created = await ensureTopics(this.admin, {
      partitions: this.cfg.KAFKA_TOPIC_PARTITIONS,
      replicationFactor: this.cfg.KAFKA_REPLICATION_FACTOR,
      topics: APPLICATION_TOPICS.map((t) => prefix + t),
    });
    if (created.length) this.logger.info({ topics: created }, 'created kafka topics');

    if (this.has('publisher')) this.loops.push(this.publisher.run(signal));
    if (this.has('replayer')) this.loops.push(this.replayer.run(signal, () => this.publisher.isLeader));
    if (this.has('sweeper')) this.loops.push(this.sweepLoop(signal));
    const startConsumer = async (def: ConsumerDefinition) => {
      const c = new EventConsumer(
        { ...def, groupId: prefix + def.name, topics: def.topics.map((t) => prefix + t) },
        this.kafka,
        this.pool,
        this.producer,
        {
          maxAttempts: this.cfg.CONSUMER_MAX_ATTEMPTS,
          retryBaseMs: this.cfg.CONSUMER_RETRY_BASE_MS,
          retryMaxMs: this.cfg.CONSUMER_RETRY_MAX_MS,
          sessionTimeoutMs: this.cfg.KAFKA_SESSION_TIMEOUT_MS,
          partitionsConcurrently: this.cfg.KAFKA_TOPIC_PARTITIONS,
        },
        this.logger.child({ component: 'consumer' }),
      );
      this.consumers.push(c);
      await c.start();
    };
    if (this.has('order-workflow'))
      await startConsumer(
        orderWorkflowConsumer({
          routeTimeBudgetMs: this.cfg.ROUTE_TIME_BUDGET_MS,
          ...(this.hooks.failOptimizer ? { failOptimizer: this.hooks.failOptimizer } : {}),
        }),
      );
    if (this.has('catalog-cache') && this.redis) await startConsumer(catalogCacheConsumer(this.redis));
    this.loops.push(this.snapshotLoop(signal));
    if (opts.statusServer !== false) await this.listen();
    this.logger.info({ workerId: this.id, roles: this.cfg.WORKER_ROLES }, 'worker started');
  }

  private async sweepLoop(signal: AbortSignal): Promise<void> {
    const ctx: DomainContext = { pool: this.pool, config: this.cfg, logger: this.logger };
    while (!signal.aborted) {
      try {
        const r = await expireDueReservations(
          ctx,
          { limit: 200 },
          { actorId: null, correlationId: 'reservation-sweeper' },
        );
        this.sweeperRuns++;
        this.expiredReservations += r.expired;
        if (r.expired) this.logger.info(r, 'expired reservations');
      } catch (err) {
        this.logger.error({ err }, 'reservation sweep failed');
      }
      await abortableSleep(this.cfg.RESERVATION_SWEEP_INTERVAL_MS, signal);
    }
  }

  private async snapshotLoop(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        const s = await this.status();
        await this.pool.query(
          `INSERT INTO worker_status (worker_id, status, started_at) VALUES ($1, $2::jsonb, $3)
           ON CONFLICT (worker_id) DO UPDATE SET status = EXCLUDED.status, updated_at = clock_timestamp()`,
          [this.id, JSON.stringify(s), this.startedAt],
        );
      } catch (err) {
        this.logger.debug({ err }, 'status snapshot failed');
      }
      await abortableSleep(this.cfg.STATUS_SNAPSHOT_INTERVAL_MS, signal);
    }
  }

  private async lag(): Promise<Record<string, PartitionLag[]> | { error: string }> {
    if (this.lagCache && Date.now() - this.lagCache.at < 2000) return this.lagCache.value;
    if (!this.admin) return { error: 'admin not connected' };
    try {
      const value: Record<string, PartitionLag[]> = {};
      for (const c of this.consumers) value[c.name] = await consumerLag(this.admin, c);
      this.lagCache = { at: Date.now(), value };
      return value;
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Diagnostics only (no secrets). Also written to worker_status for the API's admin status page. */
  async status(): Promise<Record<string, unknown>> {
    const backlog = await outboxBacklog(this.pool).catch(() => null);
    const deadLetters = await this.pool
      .query<{ status: string; n: number }>(
        'SELECT status::text, count(*)::int AS n FROM dead_letters GROUP BY 1',
      )
      .then((r) => Object.fromEntries(r.rows.map((x) => [x.status, x.n])))
      .catch(() => null);
    return {
      workerId: this.id,
      roles: this.cfg.WORKER_ROLES,
      startedAt: this.startedAt.toISOString(),
      shuttingDown: this.shuttingDown,
      process: {
        uptimeSeconds: Math.round(process.uptime()),
        memoryMB: Math.round(process.memoryUsage().rss / 1048576),
        eventLoopDelayP99Ms: this.loopDelay.percentile(99) / 1e6,
      },
      kafka: {
        brokers: this.cfg.KAFKA_BROKERS,
        producer: {
          connected: this.producer.connected,
          sentMessages: this.producer.sentMessages,
          lastAckAt: this.producer.lastAckAt,
          lastError: this.producer.lastError,
        },
        consumers: this.consumers.map((c) => ({
          name: c.name,
          topics: c.topics,
          running: c.running,
          assignment: c.assignment(),
          stats: c.stats,
          lastProcessedAt: c.lastProcessedAt,
          lastError: c.lastError,
        })),
        lag: this.consumers.length ? await this.lag() : {},
      },
      outbox: {
        leader: this.publisher.isLeader,
        publishedTotal: this.publisher.publishedTotal,
        failedBatches: this.publisher.failedBatches,
        consecutiveFailures: this.publisher.consecutiveFailures,
        lastPublishedAt: this.publisher.lastPublishedAt,
        lastError: this.publisher.lastError,
        backlog,
      },
      deadLetters,
      redis: this.redis ? await this.redis.status() : { configured: false },
      replayer: { replayed: this.replayer.replayed, lastError: this.replayer.lastError },
      sweeper: { runs: this.sweeperRuns, expiredReservations: this.expiredReservations },
      postgres: { pool: poolStatus('worker', this.pool), transactions: getTxStats() },
    };
  }

  private listen(): Promise<void> {
    this.server = createServer((req, res) => {
      const send = (code: number, body: unknown) => {
        res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify(body));
      };
      if (req.method !== 'GET') return send(405, { error: 'method not allowed' });
      if (req.url === '/health/live') return send(200, { status: 'ok' });
      if (req.url === '/health/ready') {
        if (this.shuttingDown) return send(503, { status: 'draining' });
        void this.pool
          .query('SELECT 1')
          .then(() => send(200, { status: 'ready' }))
          .catch(() => send(503, { status: 'not_ready', checks: { postgres: 'unavailable' } }));
        return;
      }
      if (req.url === '/status') {
        void this.status()
          .then((s) => send(200, s))
          .catch((err: unknown) => send(500, { error: String(err) }));
        return;
      }
      send(404, { error: 'not found' });
    });
    return new Promise((resolve) => this.server!.listen(this.cfg.WORKER_STATUS_PORT, resolve));
  }

  /**
   * Graceful stop: stop taking new work, let the in-flight message/batch finish, release the publisher leadership,
   * disconnect Kafka clients, close the pool. Offsets of finished messages were already committed per message.
   */
  async stop(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    this.abort.abort();
    await Promise.allSettled(this.consumers.map((c) => c.stop()));
    await Promise.allSettled(this.loops);
    await this.producer.close();
    await this.redis?.close();
    await this.admin?.disconnect().catch(() => undefined);
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
    await this.pool.query('DELETE FROM worker_status WHERE worker_id = $1', [this.id]).catch(() => undefined);
    await this.pool.end();
    this.loopDelay.disable();
    this.logger.info({ workerId: this.id }, 'worker stopped');
  }
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return Promise.race([
    sleep(ms),
    new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true })),
  ]);
}
