import type { RedisClient } from '@aisleforge/cache';
import { Router } from 'express';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { getTxStats, poolStatus } from '@aisleforge/database';
import {
  discardDeadLetter,
  getDeadLetter,
  listDeadLetters,
  outboxBacklog,
  requestDeadLetterReplay,
  workerStatuses,
} from '@aisleforge/domain';
import {
  DeadLetterIdParamSchema,
  DeadLetterListQuerySchema,
  DiscardDeadLetterSchema,
} from '@aisleforge/validation';
import { clientIp, parse, principalOf } from '../http/middleware';
import type { AppPools, AppState } from '../app';

const loopDelay = monitorEventLoopDelay({ resolution: 20 });
loopDelay.enable();

const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> =>
  Promise.race([
    p,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms).unref()),
  ]);

/** Liveness: process responsiveness ONLY. It never touches PostgreSQL, Kafka or Redis, so a dependency outage
 *  cannot make an orchestrator restart every API process at once. */
export function healthRoutes(pools: AppPools, state: AppState): Router {
  const r = Router();
  r.get('/health/live', (_req, res) => {
    res.json({ status: 'ok', uptimeSeconds: Math.round(process.uptime()) });
  });
  /** Readiness: may this instance receive traffic? Short-timeout dependency check; 503 while draining. */
  r.get('/health/ready', async (_req, res) => {
    if (state.shuttingDown) {
      res.status(503).json({ status: 'draining' });
      return;
    }
    try {
      await withTimeout(pools.orders.query('SELECT 1'), 1000);
      res.json({ status: 'ready', checks: { postgres: 'ok' } });
    } catch {
      res.status(503).json({ status: 'not_ready', checks: { postgres: 'unavailable' } });
    }
  });
  return r;
}

/** Admin-only diagnostics and dead-letter operations (mounted behind authenticate + permit('internal:status')). */
export function internalRoutes(pools: AppPools, redis: RedisClient | null = null): Router {
  const r = Router();
  r.get('/status', async (_req, res) => {
    const [backlog, workers] = await Promise.all([
      outboxBacklog(pools.orders).catch(() => null),
      workerStatuses(pools.orders).catch(() => null),
    ]);
    res.json({
      process: {
        uptimeSeconds: Math.round(process.uptime()),
        memoryMB: Math.round(process.memoryUsage().rss / 1048576),
        eventLoopDelayMs: {
          p50: loopDelay.percentile(50) / 1e6,
          p99: loopDelay.percentile(99) / 1e6,
          max: loopDelay.max / 1e6,
        },
      },
      postgres: {
        pools: [poolStatus('orders', pools.orders), poolStatus('sync', pools.sync)],
        transactions: getTxStats(),
      },
      outbox: backlog,
      // Kafka producer/consumer state, lag and dead-letter counts as last reported by each worker process.
      workers,
      redis: redis ? await redis.status() : { configured: false },
    });
  });

  r.get('/dead-letters', async (req, res) => {
    const q = parse(DeadLetterListQuerySchema, req.query);
    res.json(
      await listDeadLetters(pools.orders, {
        limit: q.limit,
        ...(q.status ? { status: q.status } : {}),
        ...(q.beforeId ? { beforeId: q.beforeId } : {}),
      }),
    );
  });
  r.get('/dead-letters/:id', async (req, res) => {
    const { id } = parse(DeadLetterIdParamSchema, req.params);
    res.json({ deadLetter: await getDeadLetter(pools.orders, id) });
  });
  r.post('/dead-letters/:id/replay', async (req, res) => {
    const { id } = parse(DeadLetterIdParamSchema, req.params);
    const dl = await requestDeadLetterReplay(pools.orders, id, {
      userId: principalOf(req).userId,
      ip: clientIp(req),
    });
    res.status(202).json({ deadLetter: dl });
  });
  r.post('/dead-letters/:id/discard', async (req, res) => {
    const { id } = parse(DeadLetterIdParamSchema, req.params);
    const { note } = parse(DiscardDeadLetterSchema, req.body);
    res.json({
      deadLetter: await discardDeadLetter(pools.orders, id, note, {
        userId: principalOf(req).userId,
        ip: clientIp(req),
      }),
    });
  });
  return r;
}
