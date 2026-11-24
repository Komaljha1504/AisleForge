import { Redis } from 'ioredis';
import type { Logger } from '@aisleforge/shared';

/**
 * Redis access for AisleForge (Phase 7, ADR-007). Redis is OPTIONAL and NEVER authoritative:
 *  - every command is bounded (commandTimeout) and nothing queues while disconnected (enableOfflineQueue: false),
 *    so an outage costs at most one short timeout per call;
 *  - every caller supplies a fallback (PostgreSQL for reads, the in-process limiter/throttle for limits);
 *  - PostgreSQL alone decides whether stock can be reserved — no Redis value is consulted on that path.
 */
export interface CacheStats {
  hits: number;
  misses: number;
  errors: number;
  fallbacks: number;
  invalidations: number;
}

export class RedisClient {
  readonly redis: Redis;
  readonly stats: CacheStats = { hits: 0, misses: 0, errors: 0, fallbacks: 0, invalidations: 0 };
  lastError: string | null = null;
  lastErrorAt: Date | null = null;

  constructor(
    url: string,
    private readonly logger: Logger,
    opts: { commandTimeoutMs?: number } = {},
  ) {
    this.redis = new Redis(url, {
      commandTimeout: opts.commandTimeoutMs ?? 150,
      connectTimeout: 2000,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 0,
      retryStrategy: (times) => Math.min(200 * times, 2000), // keep reconnecting in the background
      lazyConnect: false,
    });
    this.redis.on('error', (err) => this.noteError(err));
  }

  get connected(): boolean {
    return this.redis.status === 'ready';
  }

  noteError(err: unknown): void {
    this.stats.errors++;
    this.lastError = err instanceof Error ? err.message : String(err);
    this.lastErrorAt = new Date();
  }

  /** Runs a Redis operation; on any failure records it and returns the caller's fallback (never throws). */
  async guarded<T>(op: (r: Redis) => Promise<T>, fallback: () => T | Promise<T>): Promise<T> {
    if (!this.connected) {
      this.stats.fallbacks++;
      return fallback();
    }
    try {
      return await op(this.redis);
    } catch (err) {
      this.noteError(err);
      this.stats.fallbacks++;
      this.logger.warn({ err, component: 'redis' }, 'redis operation failed; using fallback');
      return fallback();
    }
  }

  async status(): Promise<Record<string, unknown>> {
    let pingMs: number | null = null;
    if (this.connected) {
      const t0 = performance.now();
      try {
        await this.redis.ping();
        pingMs = Math.round((performance.now() - t0) * 100) / 100;
      } catch (err) {
        this.noteError(err);
      }
    }
    const lookups = this.stats.hits + this.stats.misses;
    return {
      configured: true,
      connected: this.connected,
      state: this.redis.status,
      pingMs,
      stats: {
        ...this.stats,
        hitRatio: lookups ? Math.round((this.stats.hits / lookups) * 1000) / 1000 : null,
      },
      lastError: this.lastError,
      lastErrorAt: this.lastErrorAt,
    };
  }

  async close(): Promise<void> {
    this.redis.disconnect();
  }
}

// ---- catalog cache (display-only availability) -------------------------------------------------------------------

const catalogVersionKey = (storeId: number) => `af:catver:{${storeId}}`;
const catalogKey = (storeId: number, version: string, page: string) =>
  `af:cat:{${storeId}}:v${version}:${page}`;

/**
 * Cache-aside for a store's catalog page, keyed by a per-store VERSION: invalidation is one INCR (no key scans).
 * Single-flight per key inside the process prevents a stampede of identical database queries on a miss.
 * Values are display-only (ADR-002: availability shown to customers may be stale; reservation re-checks in SQL).
 */
export class CatalogCache {
  private readonly inflight = new Map<string, Promise<unknown>>();

  constructor(
    private readonly client: RedisClient,
    private readonly ttlMs = 5000,
  ) {}

  async get<T>(
    storeId: number,
    page: string,
    load: () => Promise<T>,
  ): Promise<{ value: T; source: 'redis' | 'database' }> {
    const version = await this.client.guarded(
      async (r) => (await r.get(catalogVersionKey(storeId))) ?? '0',
      () => null,
    );
    if (version === null) return { value: await load(), source: 'database' };
    const key = catalogKey(storeId, version, page);
    const cached = await this.client.guarded(
      async (r) => r.get(key),
      () => null,
    );
    if (cached !== null) {
      this.client.stats.hits++;
      return { value: JSON.parse(cached) as T, source: 'redis' };
    }
    this.client.stats.misses++;
    let p = this.inflight.get(key) as Promise<T> | undefined;
    if (!p) {
      p = load().finally(() => this.inflight.delete(key));
      this.inflight.set(key, p);
      const value = await p;
      await this.client.guarded(
        async (r) => r.set(key, JSON.stringify(value), 'PX', this.ttlMs),
        () => null,
      );
      return { value, source: 'database' };
    }
    return { value: await p, source: 'database' };
  }
}

/**
 * Invalidates a store's cached catalog after a balance change. Coalesced to at most one version bump per store per
 * second (SET NX PX). Never throws: a missed invalidation is bounded by the cache TTL, and a Redis outage must not
 * fail (or dead-letter) the inventory event that triggered it.
 */
export async function invalidateCatalog(client: RedisClient, storeId: number): Promise<boolean> {
  return client.guarded(
    async (r) => {
      const gate = await r.set(`af:catinv:{${storeId}}`, '1', 'PX', 1000, 'NX');
      if (gate !== 'OK') return false;
      await r.incr(catalogVersionKey(storeId));
      client.stats.invalidations++;
      return true;
    },
    () => false,
  );
}

// ---- shared fixed-window rate limiter ----------------------------------------------------------------------------

const RATE_SCRIPT = `
local c = redis.call('INCR', KEYS[1])
if c == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
local ttl = redis.call('PTTL', KEYS[1])
return {c, ttl}`;

export interface SharedRateDecision {
  allowed: boolean;
  count: number;
  retryAfterSeconds: number;
}

/** Atomic INCR + expiry in one script: correct under concurrency from any number of API instances. */
export async function sharedRateHit(
  client: RedisClient,
  key: string,
  limit: number,
  windowSeconds: number,
): Promise<SharedRateDecision | null> {
  return client.guarded(
    async (r) => {
      const [count, ttl] = (await r.eval(RATE_SCRIPT, 1, `af:rl:{${key}}`, String(windowSeconds * 1000))) as [
        number,
        number,
      ];
      const allowed = count <= limit;
      return {
        allowed,
        count,
        retryAfterSeconds: allowed ? 0 : Math.max(1, Math.ceil(Math.max(ttl, 0) / 1000)),
      };
    },
    () => null,
  );
}

export { Redis };
