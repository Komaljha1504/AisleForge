import { z } from 'zod';
import { ConfigSchema } from '@aisleforge/shared';

const int = (def: number, max = Number.MAX_SAFE_INTEGER) =>
  z.coerce.number().int().positive().max(max).default(def);

export const WorkerConfigSchema = ConfigSchema.extend({
  WORKER_ID: z.string().min(1).optional(),
  WORKER_STATUS_PORT: int(8081, 65535),
  KAFKA_BROKERS: z
    .string()
    .min(1)
    .transform((s) =>
      s
        .split(',')
        .map((b) => b.trim())
        .filter(Boolean),
    ),
  KAFKA_CLIENT_ID: z.string().default('aisleforge-worker'),
  /** Namespaces topics AND consumer-group ids (e.g. per test run on a shared broker). Empty in production. */
  KAFKA_TOPIC_PREFIX: z
    .string()
    .regex(/^[a-zA-Z0-9._-]*$/)
    .default(''),
  /** Partitions for topics the worker creates (ordering is per key, so more partitions = more parallelism). */
  KAFKA_TOPIC_PARTITIONS: int(3, 64),
  KAFKA_REPLICATION_FACTOR: int(1, 5),
  /** Upper bound on how long the producer waits for a broker acknowledgement before failing the batch. */
  KAFKA_DELIVERY_TIMEOUT_MS: int(15_000),
  // 30 s: a broker pause (observed up to ~20 s on the local single broker) must not drop the consumer from its group.
  // The native client crashed (0xC0000005) once after exactly such a session timeout; see
  // docs/reports/K5_WORKER_DISAPPEARANCE_INVESTIGATION.md. Tests lower it for fast failover.
  KAFKA_SESSION_TIMEOUT_MS: int(30_000),
  OUTBOX_BATCH_SIZE: int(200, 5000),
  OUTBOX_IDLE_DELAY_MS: int(200),
  /** Handler attempts for one message before it is dead-lettered. */
  CONSUMER_MAX_ATTEMPTS: int(5, 50),
  CONSUMER_RETRY_BASE_MS: int(200),
  CONSUMER_RETRY_MAX_MS: int(5_000),
  RESERVATION_SWEEP_INTERVAL_MS: int(15_000),
  STATUS_SNAPSHOT_INTERVAL_MS: int(5_000),
  ROUTE_TIME_BUDGET_MS: int(250, 10_000),
  /** Phase 7: Redis for catalog-cache invalidation. Empty = disabled (the catalog-cache role then does nothing). */
  REDIS_URL: z
    .string()
    .default('')
    .refine((s) => s === '' || /^rediss?:\/\//.test(s), 'REDIS_URL must be redis:// or rediss://'),
  /** Comma-separated subset of: publisher, order-workflow, catalog-cache, sweeper, replayer. Default: all. */
  WORKER_ROLES: z
    .string()
    .default('publisher,order-workflow,catalog-cache,sweeper,replayer')
    .transform((s) =>
      s
        .split(',')
        .map((r) => r.trim())
        .filter(Boolean),
    )
    .pipe(z.array(z.enum(['publisher', 'order-workflow', 'catalog-cache', 'sweeper', 'replayer'])).min(1)),
  SHUTDOWN_TIMEOUT_MS: int(25_000),
});
export type WorkerConfig = z.infer<typeof WorkerConfigSchema>;

export function loadWorkerConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const parsed = WorkerConfigSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid worker configuration: ${issues}`);
  }
  return parsed.data;
}
