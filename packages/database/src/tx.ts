import {
  AppError,
  backoffMs,
  jitteredRetryAfterSeconds,
  pgErrorCode,
  sleep,
  type Logger,
} from '@aisleforge/shared';
import type { PgClient, PgPool } from './pools';

/** SQLSTATEs that are safe to retry: the transaction was rolled back by the server, no effect was applied. */
export const TRANSIENT_SQLSTATES: ReadonlySet<string> = new Set([
  '40P01', // deadlock_detected
  '40001', // serialization_failure
  '55P03', // lock_not_available (lock_timeout)
]);

export interface TxStats {
  committed: number;
  rolledBack: number;
  retries: Record<string, number>;
  exhaustedRetries: number;
  poolAcquireTimeouts: number;
  statementTimeouts: number;
}

const stats = new Map<string, TxStats>();
const blank = (): TxStats => ({
  committed: 0,
  rolledBack: 0,
  retries: {},
  exhaustedRetries: 0,
  poolAcquireTimeouts: 0,
  statementTimeouts: 0,
});
const statsFor = (label: string): TxStats => {
  let s = stats.get(label);
  if (!s) stats.set(label, (s = blank()));
  return s;
};
export const getTxStats = (): Record<string, TxStats> => Object.fromEntries(stats);
export const resetTxStats = (): void => stats.clear();

function isPoolAcquireTimeout(e: unknown): boolean {
  return (
    e instanceof Error &&
    /timeout exceeded when trying to connect|Connection terminated due to connection timeout/i.test(e.message)
  );
}

export interface TxOptions {
  /** Stable name for diagnostics, e.g. 'orders.place'. */
  label: string;
  maxAttempts?: number;
  logger?: Logger;
}

/**
 * Runs `fn` in a READ COMMITTED transaction.
 *
 * - Retries ONLY transient concurrency failures (deadlock, serialization failure, lock timeout), with bounded
 *   attempts and full-jitter backoff. Business failures (AppError) are never retried.
 * - Pool acquire timeout -> 503 DB_POOL_EXHAUSTED with a jittered Retry-After (load shedding, not queueing forever).
 * - Statement timeout -> 503 DB_TIMEOUT.
 * - `fn` must not perform network calls to Kafka/Redis/optimizer: it holds row locks.
 */
export async function withTransaction<T>(
  pool: PgPool,
  opts: TxOptions,
  fn: (client: PgClient) => Promise<T>,
): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? 4;
  const s = statsFor(opts.label);
  for (let attempt = 1; ; attempt++) {
    let client: PgClient;
    try {
      client = await pool.connect();
    } catch (e) {
      if (isPoolAcquireTimeout(e)) {
        s.poolAcquireTimeouts++;
        throw new AppError('DB_POOL_EXHAUSTED', 'Database is saturated; retry later', {
          cause: e,
          retryAfterSeconds: jitteredRetryAfterSeconds(1, 2),
        });
      }
      throw new AppError('DEPENDENCY_UNAVAILABLE', 'Database unavailable', {
        cause: e,
        retryAfterSeconds: jitteredRetryAfterSeconds(2, 3),
      });
    }

    let outcome: { ok: true; value: T } | { ok: false; error: unknown };
    let broken = false;
    try {
      await client.query('BEGIN');
      const value = await fn(client);
      await client.query('COMMIT');
      s.committed++;
      outcome = { ok: true, value };
    } catch (e) {
      try {
        await client.query('ROLLBACK');
      } catch {
        broken = true; // connection unusable; destroy it instead of returning it to the pool
      }
      s.rolledBack++;
      outcome = { ok: false, error: e };
    }
    // Exactly one release per acquire, before any backoff sleep (never hold a connection while sleeping).
    client.release(broken);

    if (outcome.ok) return outcome.value;
    const e = outcome.error;
    const code = pgErrorCode(e);
    if (code && TRANSIENT_SQLSTATES.has(code)) {
      if (attempt < maxAttempts) {
        s.retries[code] = (s.retries[code] ?? 0) + 1;
        opts.logger?.debug({ code, attempt, label: opts.label }, 'transient transaction failure; retrying');
        await sleep(backoffMs(attempt));
        continue;
      }
      s.exhaustedRetries++;
      throw new AppError('DB_TIMEOUT', 'Database contention; retry later', {
        cause: e,
        details: { sqlstate: code, attempts: attempt },
        retryAfterSeconds: jitteredRetryAfterSeconds(1, 2),
      });
    }
    if (code === '57014') {
      s.statementTimeouts++;
      throw new AppError('DB_TIMEOUT', 'Database statement timed out', {
        cause: e,
        retryAfterSeconds: jitteredRetryAfterSeconds(1, 2),
      });
    }
    throw e;
  }
}
