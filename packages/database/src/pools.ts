import pg from 'pg';
import type { AppConfig, Logger } from '@aisleforge/shared';

const { Pool, types } = pg;

// int8 (COUNT(*), bigserial, version columns) -> JS number. Values in this system stay far below 2^53.
types.setTypeParser(20, (v) => Number.parseInt(v, 10));

export type PgPool = pg.Pool;
export type PgClient = pg.PoolClient;

export interface PoolSpec {
  name: string;
  max: number;
}

/**
 * Every pool has a bounded acquire timeout, statement timeout, lock timeout and idle-in-transaction timeout.
 * `connectionTimeoutMillis` defaults to 0 (wait forever) in node-postgres; that default is never used here.
 */
export function createPool(cfg: AppConfig, spec: PoolSpec, logger?: Logger): PgPool {
  const pool = new Pool({
    connectionString: cfg.DATABASE_URL,
    max: spec.max,
    connectionTimeoutMillis: cfg.PG_CONNECTION_TIMEOUT_MS,
    idleTimeoutMillis: 30_000,
    statement_timeout: cfg.PG_STATEMENT_TIMEOUT_MS,
    lock_timeout: cfg.PG_LOCK_TIMEOUT_MS,
    idle_in_transaction_session_timeout: cfg.PG_IDLE_IN_TX_TIMEOUT_MS,
    application_name: `aisleforge:${spec.name}`,
  });
  // An idle client can error (e.g. DB restart). Without a listener node-postgres would crash the process.
  pool.on('error', (err) => logger?.error({ err, pool: spec.name }, 'idle postgres client error'));
  return pool;
}

export interface PoolSet {
  orders: PgPool;
  sync: PgPool;
  worker: PgPool;
}

/** Bulkheads: sync traffic (reconnect storms) cannot starve order placement, and vice versa. */
export function createPoolSet(
  cfg: AppConfig,
  logger?: Logger,
  which: (keyof PoolSet)[] = ['orders', 'sync'],
): Partial<PoolSet> {
  const max: Record<keyof PoolSet, number> = {
    orders: cfg.PG_ORDERS_POOL_MAX,
    sync: cfg.PG_SYNC_POOL_MAX,
    worker: cfg.PG_WORKER_POOL_MAX,
  };
  const set: Partial<PoolSet> = {};
  for (const name of which) set[name] = createPool(cfg, { name, max: max[name] }, logger);
  return set;
}

export interface PoolStatus {
  name: string;
  max: number;
  total: number;
  idle: number;
  waiting: number;
}

export function poolStatus(name: string, pool: PgPool): PoolStatus {
  return {
    name,
    max: pool.options.max ?? 10,
    total: pool.totalCount,
    idle: pool.idleCount,
    waiting: pool.waitingCount,
  };
}
