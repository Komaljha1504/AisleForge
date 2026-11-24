import type { CatalogCache } from '@aisleforge/cache';
import { Router } from 'express';
import {
  assertStoreAccess,
  claimPickTask,
  getPickTask,
  listMyRejections,
  listPickTasks,
  listRejections,
  listStores,
  releasePickTask,
  resolveRejection,
  storeCatalog,
  storeInventory,
  syncOperations,
  type DomainContext,
} from '@aisleforge/domain';
import { AppError, jitteredRetryAfterSeconds } from '@aisleforge/shared';
import {
  CatalogQuerySchema,
  DeviceOpParamsSchema,
  RejectionListQuerySchema,
  ResolveRejectionSchema,
  StoreIdParamSchema,
  SyncRequestSchema,
  TaskListQuerySchema,
  UuidParamSchema,
} from '@aisleforge/validation';
import { parse, permit, principalOf } from '../http/middleware';
import type { AppPools } from '../app';
import type { RateLimiter } from '../security/rateLimiter';

/**
 * Phase 4: catalog, pick tasks, offline synchronization and supervisor review. Mounted behind `authenticate`.
 * Synchronization uses the separate `sync` pool (bulkhead: a reconnect storm cannot starve order placement) and is
 * load-shed per user with 429 + jittered Retry-After (ADR-004).
 */
export function pickingRoutes(
  pools: AppPools,
  ordersCtx: DomainContext,
  syncCtx: DomainContext,
  limiter: RateLimiter,
  syncLimit: { max: number; windowSeconds: number },
  catalogCache: CatalogCache | null = null,
): Router {
  const r = Router();

  // ---- catalog (display-only availability; never used to decide a reservation) ----------------------------------
  r.get('/stores', permit('catalog:read'), async (_req, res) => {
    res.json({ stores: await listStores(pools.orders) });
  });
  r.get('/stores/:storeId/catalog', permit('catalog:read'), async (req, res) => {
    const { storeId } = parse(StoreIdParamSchema, req.params);
    const page = parse(CatalogQuerySchema, req.query);
    const load = () => storeCatalog(pools.orders, storeId, page);
    // Display-only availability: served from Redis when possible (TTL + version invalidation), else PostgreSQL.
    const out = catalogCache
      ? await catalogCache.get(storeId, `${page.limit}:${page.offset}`, load)
      : { value: await load(), source: 'database' as const };
    res.setHeader('Cache-Control', 'private, max-age=5');
    res.setHeader('X-Cache', out.source === 'redis' ? 'HIT' : catalogCache ? 'MISS' : 'DISABLED');
    res.json({ storeId, items: out.value });
  });
  r.get('/stores/:storeId/inventory', permit('inventory:read'), async (req, res) => {
    const { storeId } = parse(StoreIdParamSchema, req.params);
    assertStoreAccess(principalOf(req), storeId);
    res.json({ storeId, items: await storeInventory(pools.orders, storeId) });
  });

  // ---- pick tasks ------------------------------------------------------------------------------------------------
  r.get('/pick-tasks', permit('tasks:read'), async (req, res) => {
    const q = parse(TaskListQuerySchema, req.query);
    res.json({ tasks: await listPickTasks(pools.orders, principalOf(req), q) });
  });
  r.get('/pick-tasks/:id', permit('tasks:read'), async (req, res) => {
    const { id } = parse(UuidParamSchema, req.params);
    res.json({ task: await getPickTask(pools.orders, principalOf(req), id) });
  });
  /** Online-only and server-authoritative (ADR-004): a claim is never queued offline. */
  r.post('/pick-tasks/:id/claim', permit('tasks:pick'), async (req, res) => {
    const { id } = parse(UuidParamSchema, req.params);
    res.json({ task: await claimPickTask(ordersCtx, principalOf(req), id) });
  });
  r.post('/pick-tasks/:id/release', permit('tasks:read'), async (req, res) => {
    const { id } = parse(UuidParamSchema, req.params);
    res.json({ task: await releasePickTask(ordersCtx, principalOf(req), id) });
  });

  // ---- offline synchronization -------------------------------------------------------------------------------------
  r.post('/sync', permit('sync:write'), async (req, res) => {
    const p = principalOf(req);
    const decision = await limiter.hit(`sync:${p.userId}`, syncLimit.max, syncLimit.windowSeconds);
    if (!decision.allowed)
      throw new AppError('RATE_LIMITED', 'Too many synchronization requests; retry later', {
        retryAfterSeconds: jitteredRetryAfterSeconds(decision.retryAfterSeconds, 3),
      });
    const body = parse(SyncRequestSchema, req.body);
    const out = await syncOperations(syncCtx, p, {
      deviceId: body.deviceId,
      userAgent: req.get('user-agent')?.slice(0, 300) ?? null,
      correlationId: req.correlationId,
      ops: body.ops.map((o) => ({
        opId: o.opId,
        seq: o.seq,
        type: o.type,
        taskId: o.taskId,
        payload: o.payload,
        clientCreatedAt: o.clientCreatedAt,
      })),
    });
    res.json(out);
  });

  // ---- rejected operations ----------------------------------------------------------------------------------------
  r.get('/sync/rejections/mine', permit('sync:write'), async (req, res) => {
    res.json({ rejections: await listMyRejections(pools.orders, principalOf(req), 100) });
  });
  r.get('/sync/rejections', permit('rejections:review'), async (req, res) => {
    const q = parse(RejectionListQuerySchema, req.query);
    res.json({ rejections: await listRejections(pools.orders, principalOf(req), q) });
  });
  r.post('/sync/rejections/:deviceId/:opId/resolve', permit('rejections:review'), async (req, res) => {
    const params = parse(DeviceOpParamsSchema, req.params);
    const body = parse(ResolveRejectionSchema, req.body);
    await resolveRejection(pools.orders, principalOf(req), { ...params, ...body });
    res.status(204).end();
  });

  return r;
}
