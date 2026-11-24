import { z } from 'zod';

const int = (def: number) => z.coerce.number().int().positive().default(def);

/**
 * All runtime configuration, validated at startup. A process with invalid configuration refuses to start
 * rather than running with surprising defaults. Defaults are development-safe; see docs/deployment/CONNECTION_BUDGET.md.
 */
export const ConfigSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DATABASE_URL: z.string().url(),

  // Connection budget (per process). Never 0: an unbounded wait turns DB slowness into a full outage.
  PG_ORDERS_POOL_MAX: int(10),
  PG_SYNC_POOL_MAX: int(5),
  PG_WORKER_POOL_MAX: int(5),
  PG_CONNECTION_TIMEOUT_MS: int(2000),
  PG_STATEMENT_TIMEOUT_MS: int(5000),
  PG_LOCK_TIMEOUT_MS: int(2000),
  PG_IDLE_IN_TX_TIMEOUT_MS: int(10000),
  PG_TX_MAX_ATTEMPTS: int(4),

  RESERVATION_TTL_MINUTES: int(30),
  /** A claimed pick task is leased to its picker for this long (renewed by claiming again); see ADR-004. */
  TASK_LEASE_MINUTES: int(240),
  /** While a task is leased, its order's reservations are kept alive at least this long past the lease end. */
  LEASE_RESERVATION_GRACE_MINUTES: int(10),
  MAX_ORDER_LINES: int(50),
  MAX_LINE_QTY: int(1000),
});

export type AppConfig = z.infer<typeof ConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = ConfigSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration: ${issues}`);
  }
  return parsed.data;
}
