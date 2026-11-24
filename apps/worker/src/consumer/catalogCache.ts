import { invalidateCatalog, type RedisClient } from '@aisleforge/cache';
import { Topics, type PayloadOf } from '@aisleforge/events';
import type { ConsumerDefinition, EventHandler } from './runner';

export const CATALOG_CACHE_CONSUMER = 'catalog-cache';

/**
 * Event-driven invalidation of the display-only catalog cache (Phase 7, ADR-007): an inventory.balance_changed
 * event bumps that store's catalog version (coalesced to ≤ 1 bump per store per second).
 * Best effort BY DESIGN: if Redis is down the handler still succeeds — a missed invalidation only means a cached
 * page lives until its TTL (seconds), whereas failing here would retry and eventually dead-letter inventory events.
 */
export function catalogCacheConsumer(redis: RedisClient): ConsumerDefinition {
  const changed: EventHandler<undefined> = {
    async apply(_c, { envelope, logger }) {
      const p = envelope.payload as PayloadOf<'inventory.balance_changed'>;
      const bumped = await invalidateCatalog(redis, p.storeId);
      if (!redis.connected)
        logger.debug({ storeId: p.storeId }, 'catalog invalidation skipped: redis unavailable');
      return bumped ? 'applied' : 'ignored';
    },
  };
  return {
    name: CATALOG_CACHE_CONSUMER,
    topics: [Topics.inventory],
    versionCheck: false,
    handlers: { 'inventory.balance_changed': changed as EventHandler<never> },
  };
}
