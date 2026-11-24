/**
 * Phase 3 — authentication & session security, through the real HTTP application and real PostgreSQL.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { SignJWT } from 'jose';
import { ALLOWED_ORIGIN, bearer, buildApi, login, PASSWORD, seedUser, type TestApi } from '../support/api';
import { makePool, resetDatabase, seedStore } from '../support/db';
import { newId } from '@aisleforge/shared';

const pool = makePool(10);
const pools = { orders: pool, sync: pool };
let api: TestApi;
let pickerId: string;

beforeAll(async () => {
  await resetDatabase(pool);
  await seedStore(pool, 1);
  pickerId = await seedUser(pool, { email: 'picker.one@store1.test', role: 'picker', storeId: 1 });
  await seedUser(pool, { email: 'admin@aisleforge.test', role: 'admin' });
  api = buildApi(pools);
});
afterAll(async () => {
  await pool.end();
});

const csrf = { 'X-CSRF-Protection': '1' };

describe('registration', () => {
  it('creates customers only; a role field is rejected (mass assignment)', async () => {
    const bad = await request(api.app)
      .post('/api/v1/auth/register')
      .send({ email: 'eve@x.test', password: 'a-very-long-password-1', displayName: 'Eve', role: 'admin' });
    expect(bad.status).toBe(400);
    const ok = await request(api.app)
      .post('/api/v1/auth/register')
      .send({ email: 'Eve@X.test', password: 'a-very-long-password-1', displayName: 'Eve' });
    expect(ok.status).toBe(201);
    expect(ok.body.user).toMatchObject({ email: 'eve@x.test', role: 'customer', storeId: null });
    const dup = await request(api.app)
      .post('/api/v1/auth/register')
      .send({ email: 'eve@x.test', password: 'a-very-long-password-1', displayName: 'Eve' });
    expect(dup.status).toBe(409);
  });

  it('enforces the password policy', async () => {
    const short = await request(api.app)
      .post('/api/v1/auth/register')
      .send({ email: 'p@x.test', password: 'short', displayName: 'P' });
    expect(short.status).toBe(400);
    const containsName = await request(api.app)
      .post('/api/v1/auth/register')
      .send({ email: 'mallory@x.test', password: 'mallory-password-123', displayName: 'M' });
    expect(containsName.status).toBe(400);
  });

  it('stores passwords as Argon2id with the configured cost, never in plaintext', async () => {
    const { rows } = await pool.query(`SELECT password_hash FROM users WHERE email = 'eve@x.test'`);
    expect(rows[0].password_hash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
    expect(rows[0].password_hash).not.toContain('a-very-long-password-1');
  });
});

describe('login', () => {
  it('returns a short-lived access token and a hardened refresh cookie', async () => {
    const res = await request(api.app)
      .post('/api/v1/auth/login')
      .send({ email: 'picker.one@store1.test', password: PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      tokenType: 'Bearer',
      expiresIn: 600,
      user: { role: 'picker', storeId: 1 },
    });
    const cookie = ([] as string[]).concat(res.headers['set-cookie'] ?? [])[0]!;
    expect(cookie).toMatch(/^af_refresh=[A-Za-z0-9_-]{40,}/);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/Secure/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
    expect(cookie).toMatch(/Path=\/api\/v1\/auth/);
    expect(res.headers['cache-control']).toBe('no-store');
    // Only the hash of the refresh token is stored.
    const raw = cookie.split(';')[0]!.split('=')[1]!;
    const stored = await pool.query(`SELECT token_hash FROM refresh_tokens WHERE user_id = $1`, [pickerId]);
    expect(stored.rows.map((r) => r.token_hash)).not.toContain(raw);
  });

  it('gives the same response for unknown email and wrong password (no account enumeration)', async () => {
    const unknown = await request(api.app)
      .post('/api/v1/auth/login')
      .send({ email: 'nobody@x.test', password: PASSWORD });
    const wrong = await request(api.app)
      .post('/api/v1/auth/login')
      .send({ email: 'admin@aisleforge.test', password: 'wrong-password-123' });
    expect(unknown.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect(unknown.body.error).toEqual(wrong.body.error);
  });

  it('locks an account out after repeated failures (429 + Retry-After), even for the correct password', async () => {
    await seedUser(pool, { email: 'target@x.test', role: 'customer' });
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++)
      statuses.push(
        (
          await request(api.app)
            .post('/api/v1/auth/login')
            .send({ email: 'target@x.test', password: `guess-number-${i}-x` })
        ).status,
      );
    const blocked = await request(api.app)
      .post('/api/v1/auth/login')
      .send({ email: 'target@x.test', password: PASSWORD });
    expect(statuses).toEqual([401, 401, 401, 401, 401]);
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    const audit = await pool.query(
      `SELECT count(*)::int AS n FROM auth_audit_log WHERE email = 'target@x.test' AND event = 'login' AND NOT success`,
    );
    expect(audit.rows[0].n).toBe(5);
  });

  it('limits attempts per client IP', async () => {
    const strict = buildApi(pools, { LOGIN_IP_MAX_ATTEMPTS: '3' });
    const codes: number[] = [];
    for (let i = 0; i < 4; i++)
      codes.push(
        (
          await request(strict.app)
            .post('/api/v1/auth/login')
            .send({ email: `x${i}@x.test`, password: 'whatever-123456' })
        ).status,
      );
    expect(codes).toEqual([401, 401, 401, 429]);
  });
});

describe('access tokens', () => {
  async function forge(
    claims: Record<string, unknown>,
    opts: { secret?: string; aud?: string; exp?: string | number } = {},
  ) {
    return new SignJWT(claims)
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject((claims.sub as string) ?? pickerId)
      .setIssuer(api.config.JWT_ISSUER)
      .setAudience(opts.aud ?? api.config.JWT_AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(opts.exp ?? '5m')
      .sign(new TextEncoder().encode(opts.secret ?? api.config.JWT_SECRET));
  }
  const goodClaims = () => ({ role: 'admin', store: null, sid: newId() });

  it('accepts a valid token (control)', async () => {
    const t = await forge(goodClaims());
    expect((await request(api.app).get('/api/v1/me').set(bearer(t))).status).not.toBe(401);
  });

  it.each([
    [
      'tampered signature',
      async () => {
        const t = await forge(goodClaims());
        return t.slice(0, -2) + (t.endsWith('AA') ? 'BB' : 'AA');
      },
    ],
    ['signed with another secret', () => forge(goodClaims(), { secret: 'x'.repeat(48) })],
    ['wrong audience', () => forge(goodClaims(), { aud: 'some-other-api' })],
    ['expired', () => forge(goodClaims(), { exp: Math.floor(Date.now() / 1000) - 60 })],
    ['unknown role claim', () => forge({ ...goodClaims(), role: 'superadmin' })],
    [
      'alg=none',
      async () => {
        const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
        return `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ sub: pickerId, role: 'admin', store: null, sid: newId(), iss: api.config.JWT_ISSUER, aud: api.config.JWT_AUDIENCE, exp: Math.floor(Date.now() / 1000) + 300 })}.`;
      },
    ],
  ])('rejects %s with 401', async (_name, make) => {
    const res = await request(api.app)
      .get('/api/v1/me')
      .set(bearer(await make()));
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('rejects missing/malformed Authorization headers', async () => {
    expect((await request(api.app).get('/api/v1/me')).status).toBe(401);
    expect((await request(api.app).get('/api/v1/me').set('Authorization', 'Basic abc')).status).toBe(401);
  });
});

describe('refresh rotation, reuse detection, logout, CSRF', () => {
  it('requires the CSRF header and an allow-listed Origin', async () => {
    const s = await login(api.app, 'picker.one@store1.test');
    expect((await request(api.app).post('/api/v1/auth/refresh').set('Cookie', s.cookie)).status).toBe(403);
    expect(
      (
        await request(api.app)
          .post('/api/v1/auth/refresh')
          .set('Cookie', s.cookie)
          .set(csrf)
          .set('Origin', 'https://evil.test')
      ).status,
    ).toBe(403);
    expect(
      (
        await request(api.app)
          .post('/api/v1/auth/refresh')
          .set('Cookie', s.cookie)
          .set(csrf)
          .set('Origin', ALLOWED_ORIGIN)
      ).status,
    ).toBe(200);
  });

  it('rotates the refresh token; replaying a used token revokes the whole session', async () => {
    const s = await login(api.app, 'picker.one@store1.test');
    const r1 = await request(api.app).post('/api/v1/auth/refresh').set('Cookie', s.cookie).set(csrf);
    expect(r1.status).toBe(200);
    const rotated = ([] as string[]).concat(r1.headers['set-cookie'] ?? [])[0]!.split(';')[0]!;
    expect(rotated).not.toEqual(s.cookie);
    expect(r1.body.accessToken).toBeTruthy();

    const replay = await request(api.app).post('/api/v1/auth/refresh').set('Cookie', s.cookie).set(csrf);
    expect(replay.status).toBe(401);
    // The legitimately rotated token is now dead too (family revoked): a stolen token cannot keep a session alive.
    expect(
      (await request(api.app).post('/api/v1/auth/refresh').set('Cookie', rotated).set(csrf)).status,
    ).toBe(401);
    const audit = await pool.query(
      `SELECT count(*)::int AS n FROM auth_audit_log WHERE event = 'refresh_reuse_detected' AND user_id = $1`,
      [pickerId],
    );
    expect(audit.rows[0].n).toBeGreaterThanOrEqual(1);
  });

  it('logout revokes the session', async () => {
    const s = await login(api.app, 'picker.one@store1.test');
    expect(
      (await request(api.app).post('/api/v1/auth/logout').set('Cookie', s.cookie).set(csrf)).status,
    ).toBe(204);
    expect(
      (await request(api.app).post('/api/v1/auth/refresh').set('Cookie', s.cookie).set(csrf)).status,
    ).toBe(401);
  });

  it("a role change by an admin revokes the user's sessions", async () => {
    const victim = await seedUser(pool, { email: 'temp.picker@store1.test', role: 'picker', storeId: 1 });
    const s = await login(api.app, 'temp.picker@store1.test');
    const admin = await login(api.app, 'admin@aisleforge.test');
    const change = await request(api.app)
      .patch(`/api/v1/admin/users/${victim}/role`)
      .set(bearer(admin))
      .send({ role: 'supervisor', storeId: 1 });
    expect(change.status).toBe(200);
    expect(
      (await request(api.app).post('/api/v1/auth/refresh').set('Cookie', s.cookie).set(csrf)).status,
    ).toBe(401);
  });
});

describe('information exposure', () => {
  it('never logs passwords, access tokens or refresh tokens', async () => {
    api.logs.length = 0;
    const s = await login(api.app, 'picker.one@store1.test');
    await request(api.app)
      .post('/api/v1/auth/refresh')
      .set('Cookie', s.cookie)
      .set(csrf)
      .set('Authorization', `Bearer ${s.accessToken}`);
    await request(api.app).get('/api/v1/me').set(bearer(s));
    const out = api.logs.join('\n');
    expect(api.logs.length).toBeGreaterThan(0);
    expect(out).not.toContain(PASSWORD);
    expect(out).not.toContain(s.accessToken);
    expect(out).not.toContain(s.cookie.split('=')[1]!);
  });

  it('errors carry a code and request id but no stack traces or internals', async () => {
    const res = await request(api.app)
      .post('/api/v1/auth/login')
      .set('Content-Type', 'application/json')
      .send('{"email": broken');
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: { code: 'VALIDATION_FAILED' }, requestId: expect.any(String) });
    expect(JSON.stringify(res.body)).not.toMatch(/at \w+ \(|node_modules|stack/i);
    const notFound = await request(api.app).get('/nope');
    expect(notFound.status).toBe(404);
    expect(notFound.headers['x-powered-by']).toBeUndefined();
  });

  it('rejects oversized bodies with 413', async () => {
    const res = await request(api.app)
      .post('/api/v1/auth/login')
      .send({ email: 'a@b.test', password: 'x'.repeat(70_000) });
    expect(res.status).toBe(413);
  });
});

describe('CORS', () => {
  it('allows only allow-listed origins, never with a wildcard', async () => {
    const ok = await request(api.app)
      .options('/api/v1/orders')
      .set('Origin', ALLOWED_ORIGIN)
      .set('Access-Control-Request-Method', 'POST');
    expect(ok.status).toBe(204);
    expect(ok.headers['access-control-allow-origin']).toBe(ALLOWED_ORIGIN);
    expect(ok.headers['access-control-allow-credentials']).toBe('true');
    const evil = await request(api.app)
      .options('/api/v1/orders')
      .set('Origin', 'https://evil.test')
      .set('Access-Control-Request-Method', 'POST');
    expect(evil.status).toBe(403);
    expect(evil.headers['access-control-allow-origin']).toBeUndefined();
  });
});
