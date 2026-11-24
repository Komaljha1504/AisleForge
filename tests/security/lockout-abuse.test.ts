/**
 * Account-lockout abuse scenarios (engineering review item 1). Client IPs are simulated with X-Forwarded-For and
 * TRUST_PROXY=true (one trusted proxy hop), exactly as the API would see them behind a single reverse proxy.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { bearer, buildApi, login, PASSWORD, seedUser, type TestApi } from '../support/api';
import { makePool, resetDatabase, writeEvidence } from '../support/db';

const pool = makePool(10);
const pools = { orders: pool, sync: pool };
let api: TestApi;
const evidence: Record<string, unknown> = {};

beforeAll(async () => {
  await resetDatabase(pool);
  await seedUser(pool, { email: 'victim@cust.test', role: 'customer' });
  await seedUser(pool, { email: 'victim2@cust.test', role: 'customer' });
  await seedUser(pool, { email: 'victim3@cust.test', role: 'customer' });
  await seedUser(pool, { email: 'ops@hq.test', role: 'admin' });
  api = buildApi(pools, { TRUST_PROXY: 'true', LOGIN_ACCOUNT_MAX_FAILURES: '40' });
});
afterAll(async () => {
  writeEvidence('phase3', 'lockout-abuse', evidence);
  await pool.end();
});

const attempt = (email: string, password: string, ip: string) =>
  request(api.app).post('/api/v1/auth/login').set('X-Forwarded-For', ip).send({ email, password });

describe('lockout abuse', () => {
  it('an attacker hammering one account from one IP cannot lock out the real user on another IP', async () => {
    const attackerCodes: number[] = [];
    for (let i = 0; i < 20; i++)
      attackerCodes.push((await attempt('victim@cust.test', `wrong-guess-${i}-xx`, '203.0.113.66')).status);
    const victim = await attempt('victim@cust.test', PASSWORD, '198.51.100.7');
    evidence.singleSourceAttack = { attackerStatuses: attackerCodes, victimStatus: victim.status };
    expect(attackerCodes.slice(0, 5)).toEqual([401, 401, 401, 401, 401]);
    expect(attackerCodes.slice(5).every((c) => c === 429)).toBe(true); // attacker's source is throttled
    expect(victim.status).toBe(200); // the real user is not denied service
  });

  it('the throttled source stays throttled even with the correct password (no oracle for the attacker)', async () => {
    const r = await attempt('victim@cust.test', PASSWORD, '203.0.113.66');
    expect(r.status).toBe(429);
    expect(Number(r.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('a distributed attack (many IPs) slows new sources but not a source the user already logged in from', async () => {
    // The user has a prior successful login from their usual network.
    expect((await attempt('victim2@cust.test', PASSWORD, '198.51.100.20')).status).toBe(200);
    const statuses: number[] = [];
    for (let i = 0; i < 60; i++)
      statuses.push((await attempt('victim2@cust.test', `spray-${i}-password`, `203.0.113.${i + 1}`)).status);
    const fromNewSource = await attempt('victim2@cust.test', PASSWORD, '192.0.2.200');
    const fromKnownSource = await attempt('victim2@cust.test', PASSWORD, '198.51.100.20');
    evidence.distributedAttack = {
      attempts: statuses.length,
      rejectedAs401: statuses.filter((s) => s === 401).length,
      throttled429: statuses.filter((s) => s === 429).length,
      newSourceStatus: fromNewSource.status,
      knownSourceStatus: fromKnownSource.status,
    };
    expect(statuses.filter((s) => s === 401).length).toBe(40); // account-wide threshold reached
    expect(statuses.filter((s) => s === 429).length).toBe(20); // further guesses are refused without checking the password
    expect(fromNewSource.status).toBe(429);
    expect(fromKnownSource.status).toBe(200);
  });

  it('an admin can clear the throttles for an account (recovery path), and it is audited', async () => {
    for (let i = 0; i < 6; i++) await attempt('victim3@cust.test', `bad-${i}-password`, '203.0.113.99');
    expect((await attempt('victim3@cust.test', PASSWORD, '203.0.113.99')).status).toBe(429);
    const admin = await login(api.app, 'ops@hq.test');
    const ids = await pool.query(`SELECT id FROM users WHERE email = 'victim3@cust.test'`);
    const unlock = await request(api.app)
      .post(`/api/v1/admin/users/${ids.rows[0].id}/unlock-login`)
      .set(bearer(admin))
      .set('X-Forwarded-For', '10.0.0.1');
    expect(unlock.status).toBe(204);
    expect((await attempt('victim3@cust.test', PASSWORD, '203.0.113.99')).status).toBe(200);
    const audit = await pool.query(
      `SELECT count(*)::int AS n FROM auth_audit_log WHERE event = 'login_throttle_cleared'`,
    );
    expect(audit.rows[0].n).toBe(1);
  });

  it('without TRUST_PROXY, X-Forwarded-For is ignored (clients cannot spoof their way out of a throttle)', async () => {
    await seedUser(pool, { email: 'spoof@cust.test', role: 'customer' });
    const direct = buildApi(pools); // TRUST_PROXY=false (default)
    const codes: number[] = [];
    for (let i = 0; i < 7; i++) {
      codes.push(
        (
          await request(direct.app)
            .post('/api/v1/auth/login')
            .set('X-Forwarded-For', `203.0.113.${i}`)
            .send({ email: 'spoof@cust.test', password: `nope-${i}-password` })
        ).status,
      );
    }
    expect(codes.slice(5)).toEqual([429, 429]); // all attempts counted against the real socket address
  });
});
