import { randomBytes } from 'node:crypto';
import { Writable } from 'node:stream';
import type { Express } from 'express';
import request from 'supertest';
import { createApp, loadApiConfig, type ApiConfig, type AppPools } from '@aisleforge/api';
import { hashPassword, type Role } from '@aisleforge/domain';
import { createLogger, newId } from '@aisleforge/shared';
import type { PgPool } from '@aisleforge/database';
import { databaseUrl } from './db';

export const ALLOWED_ORIGIN = 'https://app.aisleforge.test';
export const PASSWORD = 'correct-horse-battery-staple-9';

export function testConfig(overrides: Record<string, string> = {}): ApiConfig {
  return loadApiConfig({
    DATABASE_URL: databaseUrl(),
    JWT_SECRET: randomBytes(48).toString('base64url'),
    CORS_ORIGINS: ALLOWED_ORIGIN,
    LOGIN_IP_MAX_ATTEMPTS: '100000',
    REGISTER_IP_MAX: '100000',
    LOG_LEVEL: 'info',
    ...overrides,
  });
}

export interface TestApi {
  app: Express;
  config: ApiConfig;
  logs: string[];
}

/** Builds the real application (all middleware, real domain, real PostgreSQL) with captured structured logs. */
export function buildApi(pools: AppPools, overrides: Record<string, string> = {}): TestApi {
  const config = testConfig(overrides);
  const logs: string[] = [];
  const sink = new Writable({
    write(chunk, _enc, cb) {
      logs.push(String(chunk));
      cb();
    },
  });
  const logger = createLogger('aisleforge-api-test', { level: 'info', destination: sink });
  return { app: createApp({ config, pools, logger }), config, logs };
}

export async function seedUser(
  pool: PgPool,
  u: { email: string; role: Role; storeId?: number | null; password?: string },
): Promise<string> {
  const id = newId();
  await pool.query(
    `INSERT INTO users (id, email, display_name, role, store_id, password_hash) VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      id,
      u.email,
      u.email.split('@')[0],
      u.role,
      u.storeId ?? null,
      await hashPassword(u.password ?? PASSWORD),
    ],
  );
  return id;
}

export interface Session {
  accessToken: string;
  /** `af_refresh=<value>` pair, ready for a Cookie header. */
  cookie: string;
  setCookie: string;
  userId: string;
}

export async function login(app: Express, email: string, password = PASSWORD): Promise<Session> {
  const res = await request(app).post('/api/v1/auth/login').send({ email, password });
  if (res.status !== 200)
    throw new Error(`login failed for ${email}: ${res.status} ${JSON.stringify(res.body)}`);
  const setCookie = ([] as string[]).concat(res.headers['set-cookie'] ?? [])[0] ?? '';
  return {
    accessToken: res.body.accessToken,
    cookie: setCookie.split(';')[0]!,
    setCookie,
    userId: res.body.user.id,
  };
}

export const bearer = (s: Session | string) => ({
  Authorization: `Bearer ${typeof s === 'string' ? s : s.accessToken}`,
});
