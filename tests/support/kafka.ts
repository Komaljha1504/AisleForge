import { execFileSync } from 'node:child_process';
import { KafkaJS } from '@confluentinc/kafka-javascript';
import { inject } from 'vitest';
import type { PgPool } from '@aisleforge/database';
import { placeOrder, type DomainContext } from '@aisleforge/domain';
import { createLogger, newId, sleep } from '@aisleforge/shared';
import { WorkerConfigSchema, Worker, type WorkerConfig, type WorkerHooks } from '@aisleforge/worker';
import { databaseUrl, SYSTEM_ACTOR } from './db';

export const kafkaBrokers = (): string => inject('kafkaBrokers');

/** Unique topic/group namespace per test file, so runs never consume each other's events on the shared broker. */
export const uniquePrefix = (name: string): string =>
  `t${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}-${name}.`;

export function testWorkerConfig(prefix: string, overrides: Record<string, string> = {}): WorkerConfig {
  return WorkerConfigSchema.parse({
    NODE_ENV: 'test',
    DATABASE_URL: databaseUrl(),
    KAFKA_BROKERS: kafkaBrokers(),
    KAFKA_TOPIC_PREFIX: prefix,
    LOG_LEVEL: 'error',
    PG_WORKER_POOL_MAX: '8',
    OUTBOX_IDLE_DELAY_MS: '50',
    CONSUMER_MAX_ATTEMPTS: '3',
    CONSUMER_RETRY_BASE_MS: '50',
    CONSUMER_RETRY_MAX_MS: '300',
    KAFKA_DELIVERY_TIMEOUT_MS: '5000',
    KAFKA_SESSION_TIMEOUT_MS: '6000',
    STATUS_SNAPSHOT_INTERVAL_MS: '1000',
    RESERVATION_SWEEP_INTERVAL_MS: '60000',
    ...overrides,
  });
}

export async function startWorker(
  prefix: string,
  overrides: Record<string, string> = {},
  hooks: WorkerHooks = {},
): Promise<Worker> {
  const cfg = testWorkerConfig(prefix, overrides);
  const w = new Worker(cfg, createLogger('test-worker', { level: cfg.LOG_LEVEL }), hooks);
  await w.start({ statusServer: false });
  return w;
}

/** Polls until `fn` returns a truthy value (returned) or the timeout elapses (throws with `what`). */
export async function waitFor<T>(
  fn: () => Promise<T | false | null | undefined>,
  opts: { timeoutMs?: number; intervalMs?: number; what: string },
): Promise<T> {
  const deadline = Date.now() + (opts.timeoutMs ?? 60_000);
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    await sleep(opts.intervalMs ?? 250);
  }
  throw new Error(`Timed out waiting for: ${opts.what}${last ? ` (last error: ${String(last)})` : ''}`);
}

export function kafkaClient(): KafkaJS.Kafka {
  return new KafkaJS.Kafka({
    kafkaJS: { brokers: kafkaBrokers().split(','), logLevel: KafkaJS.logLevel.ERROR },
  });
}

/** Produces raw messages straight to the broker (poison-message injection). acks=all. */
export async function produceRaw(
  topic: string,
  messages: { key: string | null; value: string | null; headers?: Record<string, string> }[],
): Promise<void> {
  const p = kafkaClient().producer({ kafkaJS: { acks: -1 } });
  await p.connect();
  try {
    await p.send({ topic, messages });
  } finally {
    await p.disconnect();
  }
}

export interface ReadMessage {
  partition: number;
  offset: number;
  key: string | null;
  value: string | null;
  headers: Record<string, string>;
}

/** Reads a topic from the beginning with a throwaway group until `count` messages arrived (or timeout). */
export async function readTopic(topic: string, count: number, timeoutMs = 30_000): Promise<ReadMessage[]> {
  const out: ReadMessage[] = [];
  const c = kafkaClient().consumer({
    kafkaJS: { groupId: `reader-${newId()}`, fromBeginning: true, autoCommit: false },
  });
  await c.connect();
  await c.subscribe({ topics: [topic] });
  await c.run({
    eachMessage: async ({ partition, message }) => {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(message.headers ?? {}))
        if (v !== undefined) headers[k] = String(Array.isArray(v) ? v[0] : v);
      out.push({
        partition,
        offset: Number(message.offset),
        key: message.key?.toString('utf8') ?? null,
        value: message.value?.toString('utf8') ?? null,
        headers,
      });
    },
  });
  try {
    await waitFor(async () => out.length >= count, { timeoutMs, what: `${count} messages on ${topic}` });
  } finally {
    await c.disconnect();
  }
  return out;
}

export async function deleteTopicsWithPrefix(prefix: string): Promise<void> {
  const admin = kafkaClient().admin();
  await admin.connect();
  try {
    const topics = (await admin.listTopics()).filter((t) => t.startsWith(prefix));
    if (topics.length) await admin.deleteTopics({ topics, timeout: 15_000 });
  } catch {
    // best-effort cleanup; topics are namespaced, so leftovers cannot affect other runs
  } finally {
    await admin.disconnect();
  }
}

/** A grid store layout with SKU bin locations, so placed orders get real routes. */
export async function seedLayout(
  pool: PgPool,
  storeId: number,
  locations: Record<string, { aisle: number; pos: number }>,
): Promise<void> {
  const layout = {
    id: `store-${storeId}`,
    aisles: 6,
    aisleLength: 30,
    aisleSpacing: 3,
    crossAisles: [0, 30],
    entry: { aisle: 0, pos: 0 },
    exit: { aisle: 0, pos: 0 },
  };
  await pool.query(
    `INSERT INTO store_layouts (store_id, layout) VALUES ($1, $2::jsonb)
     ON CONFLICT (store_id) DO UPDATE SET layout = EXCLUDED.layout`,
    [storeId, JSON.stringify(layout)],
  );
  for (const [sku, loc] of Object.entries(locations))
    await pool.query(
      `INSERT INTO sku_locations (store_id, sku, aisle, pos) VALUES ($1, $2, $3, $4)
       ON CONFLICT (store_id, sku) DO UPDATE SET aisle = EXCLUDED.aisle, pos = EXCLUDED.pos`,
      [storeId, sku, loc.aisle, loc.pos],
    );
}

export async function place(
  ctx: DomainContext,
  customerId: string,
  storeId: number,
  lines: { sku: string; qty: number }[],
  correlationId = `corr-${newId()}`,
): Promise<string> {
  const r = await placeOrder(
    ctx,
    { principalId: customerId, idempotencyKey: `k-${newId()}`, storeId, lines },
    { actorId: customerId, correlationId },
  );
  if (r.statusCode !== 201 || !r.orderId) throw new Error(`placeOrder failed: ${JSON.stringify(r.body)}`);
  return r.orderId;
}

export { SYSTEM_ACTOR };

/**
 * Runs `docker compose <args>` for failure injection against the real stack. POSTGRES_PASSWORD only satisfies
 * compose-file interpolation (stop/start do not change a container's environment).
 */
export function compose(args: string[], timeoutMs = 120_000): string {
  return execFileSync('docker', ['compose', ...args], {
    encoding: 'utf8',
    timeout: timeoutMs,
    env: { ...process.env, POSTGRES_PASSWORD: process.env.POSTGRES_PASSWORD ?? 'compose-interpolation-only' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

export async function waitForKafkaHealthy(timeoutMs = 180_000): Promise<void> {
  await waitFor(
    async () => {
      const admin = kafkaClient().admin();
      try {
        await admin.connect();
        await admin.listTopics({ timeout: 3000 });
        return true;
      } finally {
        await admin.disconnect().catch(() => undefined);
      }
    },
    { what: 'Kafka broker reachable', timeoutMs, intervalMs: 2000 },
  );
}

export async function countRows(pool: PgPool, sql: string, params: unknown[] = []): Promise<number> {
  const { rows } = await pool.query<{ n: number }>(sql, params);
  return Number(rows[0]?.n ?? 0);
}
