import { sharedRateHit, type RedisClient } from '@aisleforge/cache';
/**
 * Rate limiting abstraction. Phase 3 ships the in-process implementation; Phase 7 adds a Redis-backed one that
 * falls back to this when Redis is unavailable. With N API replicas and no Redis, limits are per instance
 * (effective limit up to N×) — documented limitation until Phase 7.
 */
export interface RateDecision {
  allowed: boolean;
  count: number;
  retryAfterSeconds: number;
}

export interface RateLimiter {
  /** Counts one hit against `key` and reports whether the limit is still respected. */
  hit(key: string, limit: number, windowSeconds: number): RateDecision | Promise<RateDecision>;
  /** Reads without counting. */
  peek(key: string, limit: number): RateDecision;
  reset(key: string): void;
}

/**
 * Shared limiter (Phase 7): one counter per key across ALL API instances, so N replicas no longer multiply an
 * attacker's budget by N. Falls back to the in-process limiter when Redis is unavailable (per-instance limits —
 * degraded, never disabled).
 */
export class RedisRateLimiter implements RateLimiter {
  constructor(
    private readonly client: RedisClient,
    private readonly fallback: InMemoryRateLimiter = new InMemoryRateLimiter(),
  ) {}

  async hit(key: string, limit: number, windowSeconds: number): Promise<RateDecision> {
    const shared = await sharedRateHit(this.client, key, limit, windowSeconds);
    return shared ?? this.fallback.hit(key, limit, windowSeconds);
  }
  peek(key: string, limit: number): RateDecision {
    return this.fallback.peek(key, limit);
  }
  reset(key: string): void {
    this.fallback.reset(key);
  }
}

/** Fixed-window counters with bounded memory (oldest windows evicted beyond `maxKeys`). */
export class InMemoryRateLimiter implements RateLimiter {
  private readonly windows = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly maxKeys = 100_000,
    private readonly now: () => number = Date.now,
  ) {}

  private current(key: string): { count: number; resetAt: number } | undefined {
    const w = this.windows.get(key);
    if (w && w.resetAt <= this.now()) {
      this.windows.delete(key);
      return undefined;
    }
    return w;
  }

  hit(key: string, limit: number, windowSeconds: number): RateDecision {
    let w = this.current(key);
    if (!w) {
      if (this.windows.size >= this.maxKeys) {
        const oldest = this.windows.keys().next().value;
        if (oldest !== undefined) this.windows.delete(oldest);
      }
      w = { count: 0, resetAt: this.now() + windowSeconds * 1000 };
      this.windows.set(key, w);
    }
    w.count++;
    return this.decide(w, limit);
  }

  /** allowed = fewer than `limit` hits recorded in the current window. */
  peek(key: string, limit: number): RateDecision {
    const w = this.current(key);
    if (!w || w.count < limit) return { allowed: true, count: w?.count ?? 0, retryAfterSeconds: 0 };
    return {
      allowed: false,
      count: w.count,
      retryAfterSeconds: Math.max(1, Math.ceil((w.resetAt - this.now()) / 1000)),
    };
  }

  reset(key: string): void {
    this.windows.delete(key);
  }

  private decide(w: { count: number; resetAt: number }, limit: number): RateDecision {
    const allowed = w.count <= limit;
    return {
      allowed,
      count: w.count,
      retryAfterSeconds: allowed ? 0 : Math.max(1, Math.ceil((w.resetAt - this.now()) / 1000)),
    };
  }
}
