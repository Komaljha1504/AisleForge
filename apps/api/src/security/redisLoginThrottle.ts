import type { RedisClient } from '@aisleforge/cache';
import type { LoginThrottle, LoginThrottlePolicy, ThrottleDecision } from './loginThrottle';

/**
 * The same policy as LoginThrottle (ADR-005 §Brute force), with state in Redis so it is shared by every API
 * instance (Phase 7). Each operation is ONE Lua script, i.e. atomic: concurrent attempts cannot lose updates
 * (a read-modify-write from Node would let parallel guesses undercount failures).
 *
 * Keys per account share a hash tag {account} (cluster-safe):
 *   f:<src> failures in window · l:<src> lock (PX = duration) · e:<src> locks in escalation window
 *   a       account-wide failures in window · k:<src> known source (PX = knownSourceTtl)
 * Redis unavailable → the in-process LoginThrottle (per instance) takes over: throttling is degraded, never off.
 */
const prefix = (account: string) => `af:lt:{${account}}`;

const FAILURE = `
local f = redis.call('INCR', KEYS[1])
if f == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
if f >= tonumber(ARGV[2]) then
  local e = redis.call('INCR', KEYS[2])
  if e == 1 then redis.call('PEXPIRE', KEYS[2], ARGV[3]) end
  local secs = math.min(tonumber(ARGV[4]) * 2 ^ (e - 1), tonumber(ARGV[5]))
  redis.call('SET', KEYS[3], '1', 'PX', math.floor(secs * 1000))
  redis.call('DEL', KEYS[1])
end
local a = redis.call('INCR', KEYS[4])
if a == 1 then redis.call('PEXPIRE', KEYS[4], ARGV[6]) end
return 0`;

const CHECK = `
local lt = redis.call('PTTL', KEYS[1])
if lt > 0 then return {1, lt} end
local a = tonumber(redis.call('GET', KEYS[2]) or '0')
if a >= tonumber(ARGV[1]) and redis.call('EXISTS', KEYS[3]) == 0 then
  return {2, redis.call('PTTL', KEYS[2])}
end
return {0, 0}`;

export class RedisLoginThrottle {
  constructor(
    private readonly client: RedisClient,
    private readonly policy: LoginThrottlePolicy,
    private readonly fallback: LoginThrottle,
  ) {}

  async check(account: string, source: string): Promise<ThrottleDecision> {
    const p = prefix(account);
    return this.client.guarded(
      async (r) => {
        const [kind, ttl] = (await r.eval(
          CHECK,
          3,
          `${p}:l:${source}`,
          `${p}:a`,
          `${p}:k:${source}`,
          String(this.policy.accountMaxFailures),
        )) as [number, number];
        if (kind === 0) return { allowed: true, retryAfterSeconds: 0, reason: null };
        return {
          allowed: false,
          retryAfterSeconds: Math.max(1, Math.ceil(ttl / 1000)),
          reason: kind === 1 ? 'source_locked' : 'account_under_attack',
        };
      },
      () => this.fallback.check(account, source),
    );
  }

  async recordFailure(account: string, source: string): Promise<void> {
    const p = prefix(account);
    const P = this.policy;
    await this.client.guarded(
      async (r) => {
        await r.eval(
          FAILURE,
          4,
          `${p}:f:${source}`,
          `${p}:e:${source}`,
          `${p}:l:${source}`,
          `${p}:a`,
          String(P.failureWindowSeconds * 1000),
          String(P.perSourceMaxFailures),
          String(P.lockEscalationSeconds * 1000),
          String(P.baseLockSeconds),
          String(P.maxLockSeconds),
          String(P.accountWindowSeconds * 1000),
        );
      },
      () => this.fallback.recordFailure(account, source),
    );
  }

  async recordSuccess(account: string, source: string): Promise<void> {
    const p = prefix(account);
    await this.client.guarded(
      async (r) => {
        await r
          .multi()
          .del(`${p}:f:${source}`)
          .set(`${p}:k:${source}`, '1', 'PX', this.policy.knownSourceTtlSeconds * 1000)
          .exec();
      },
      () => this.fallback.recordSuccess(account, source),
    );
  }

  /** Admin recovery: clears every source lock, failure counter and escalation, and the account-wide counter. */
  async clearAccount(account: string): Promise<number> {
    const p = prefix(account);
    const local = this.fallback.clearAccount(account);
    const shared = await this.client.guarded(
      async (r) => {
        let cleared = 0;
        let cursor = '0';
        do {
          const [next, keys] = await r.scan(cursor, 'MATCH', `${p}:[lfe]:*`, 'COUNT', 200);
          cursor = next;
          if (keys.length) {
            cleared += keys.filter((k) => k.includes('}:l:')).length;
            await r.del(...keys);
          }
        } while (cursor !== '0');
        await r.del(`${p}:a`);
        return cleared;
      },
      () => 0,
    );
    return shared + local;
  }
}
