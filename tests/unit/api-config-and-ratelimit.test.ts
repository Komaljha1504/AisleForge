import { describe, expect, it } from 'vitest';
import { InMemoryRateLimiter, loadApiConfig } from '@aisleforge/api';

const base = { DATABASE_URL: 'postgres://u:p@localhost:5432/db' };

describe('API configuration', () => {
  it('refuses to start without a JWT secret or with a weak one', () => {
    expect(() => loadApiConfig(base)).toThrow(/JWT_SECRET/);
    expect(() => loadApiConfig({ ...base, JWT_SECRET: 'too-short' })).toThrow(/at least 32/);
  });

  it('defaults to secure cookies, short access tokens, and bounded refresh lifetime', () => {
    const c = loadApiConfig({ ...base, JWT_SECRET: 'x'.repeat(40) });
    expect(c.COOKIE_SECURE).toBe(true);
    expect(c.ACCESS_TOKEN_TTL_SECONDS).toBe(600);
    expect(c.REFRESH_TOKEN_TTL_HOURS).toBe(12);
    expect(() =>
      loadApiConfig({ ...base, JWT_SECRET: 'x'.repeat(40), ACCESS_TOKEN_TTL_SECONDS: '86400' }),
    ).toThrow();
    expect(() =>
      loadApiConfig({ ...base, JWT_SECRET: 'x'.repeat(40), REFRESH_TOKEN_TTL_HOURS: '720' }),
    ).toThrow();
  });

  it('parses an explicit CORS allow-list (no wildcard default)', () => {
    const c = loadApiConfig({
      ...base,
      JWT_SECRET: 'x'.repeat(40),
      CORS_ORIGINS: 'https://a.test, https://b.test',
    });
    expect(c.CORS_ORIGINS).toEqual(['https://a.test', 'https://b.test']);
  });
});

describe('InMemoryRateLimiter', () => {
  it('counts within a fixed window and reports Retry-After', () => {
    let now = 0;
    const rl = new InMemoryRateLimiter(1000, () => now);
    expect([1, 2, 3].map(() => rl.hit('k', 2, 60).allowed)).toEqual([true, true, false]);
    expect(rl.hit('k', 2, 60).retryAfterSeconds).toBe(60);
    now = 61_000;
    expect(rl.hit('k', 2, 60).allowed).toBe(true); // window rolled over
  });

  it('peek reports blocked once the limit is reached, without counting', () => {
    const rl = new InMemoryRateLimiter();
    rl.hit('f', 2, 60);
    expect(rl.peek('f', 2).allowed).toBe(true);
    rl.hit('f', 2, 60);
    expect(rl.peek('f', 2).allowed).toBe(false);
    expect(rl.peek('f', 2).count).toBe(2);
    rl.reset('f');
    expect(rl.peek('f', 2).allowed).toBe(true);
  });

  it('bounds memory by evicting the oldest window', () => {
    const rl = new InMemoryRateLimiter(3);
    for (const k of ['a', 'b', 'c', 'd']) rl.hit(k, 1, 60);
    expect(rl.peek('a', 1).count).toBe(0);
    expect(rl.peek('d', 1).count).toBe(1);
  });
});
