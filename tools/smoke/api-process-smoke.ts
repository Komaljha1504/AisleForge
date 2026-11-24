/**
 * Boots the REAL API process (apps/api/src/main.ts via tsx) against a disposable embedded PostgreSQL and exercises it
 * over a real TCP socket: config validation refusal, readiness, register → login → order → refresh → logout.
 *
 *   pnpm tsx tools/smoke/api-process-smoke.ts
 *
 * Writes audit/test-results/phase3/api-process-smoke.json.
 * Not covered here: graceful SIGTERM handling. On Windows, child.kill('SIGTERM') terminates the process without
 * delivering a signal, so drain behaviour must be verified in a Linux container (Phase 8 / Phase 9).
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import EmbeddedPostgres from 'embedded-postgres';
import { runMigrations } from '@aisleforge/database';

const freePort = () =>
  new Promise<number>((res) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => res(p));
    });
  });
const steps: { step: string; ok: boolean; detail?: unknown }[] = [];
const record = (step: string, ok: boolean, detail?: unknown) => {
  steps.push({ step, ok, detail });
  console.log(ok ? 'PASS' : 'FAIL', step, detail ?? '');
};

const pgPort = await freePort();
// Outside the OneDrive-synced workspace (sync churn on database files caused EBUSY and memory pressure).
const dir = path.join(os.tmpdir(), 'aisleforge-pg-smoke', `pg-smoke-${pgPort}`);
rmSync(dir, { recursive: true, force: true });
mkdirSync(path.dirname(dir), { recursive: true });
const pg = new EmbeddedPostgres({
  databaseDir: dir,
  user: 'postgres',
  password: 'smoke-only',
  port: pgPort,
  persistent: false,
  postgresFlags: ['-c', 'io_method=sync'],
  onLog: () => undefined,
  onError: () => undefined,
});
await pg.initialise();
await pg.start();
await pg.createDatabase('aisleforge');
const DATABASE_URL = `postgres://postgres:smoke-only@127.0.0.1:${pgPort}/aisleforge`;
await runMigrations(DATABASE_URL);

const tsx = path.resolve('node_modules/.bin/tsx' + (process.platform === 'win32' ? '.cmd' : ''));
const startApi = (env: Record<string, string>): ChildProcess =>
  spawn(tsx, ['apps/api/src/main.ts'], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
  });

let api: ChildProcess | null = null;
try {
  // 1. Misconfiguration is refused (exit code 2), not run with insecure defaults.
  const bad = startApi({ DATABASE_URL, JWT_SECRET: 'short', PORT: String(await freePort()) });
  const code = await new Promise<number | null>((res) => bad.on('exit', res));
  record('refuses to start with a weak JWT_SECRET', code === 2, { exitCode: code });

  // 2. Real boot.
  const port = await freePort();
  api = startApi({
    DATABASE_URL,
    JWT_SECRET: randomBytes(48).toString('base64url'),
    PORT: String(port),
    COOKIE_SECURE: 'false',
    LOG_LEVEL: 'warn',
  });
  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  const t0 = Date.now();
  while (!ready && Date.now() - t0 < 30_000) {
    try {
      ready = (await fetch(`${base}/health/ready`)).status === 200;
    } catch {
      /* not listening yet */
    }
    if (!ready) await new Promise((r) => setTimeout(r, 250));
  }
  record('process boots and becomes ready', ready, { bootMs: Date.now() - t0 });
  if (!ready) throw new Error('api never became ready');

  const j = (r: Response) => r.json() as Promise<Record<string, unknown>>;
  const live = await fetch(`${base}/health/live`);
  record('GET /health/live', live.status === 200);

  const reg = await fetch(`${base}/api/v1/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: 'smoke@cust.test',
      password: 'correct-horse-battery-77',
      displayName: 'Smoke',
    }),
  });
  record('POST register', reg.status === 201, { status: reg.status });

  const login = await fetch(`${base}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'smoke@cust.test', password: 'correct-horse-battery-77' }),
  });
  const loginBody = await j(login);
  const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]!;
  record(
    'POST login',
    login.status === 200 && typeof loginBody.accessToken === 'string' && cookie.startsWith('af_refresh='),
    { status: login.status },
  );

  const auth = {
    Authorization: `Bearer ${String(loginBody.accessToken)}`,
    'Content-Type': 'application/json',
  };
  const order = await fetch(`${base}/api/v1/orders`, {
    method: 'POST',
    headers: { ...auth, 'Idempotency-Key': 'smoke-order-0001' },
    body: JSON.stringify({ storeId: 1, lines: [{ sku: 'NOPE', qty: 1 }] }),
  });
  record('POST order (store has no stock → recorded 422 UNKNOWN_SKU)', order.status === 422, {
    status: order.status,
  });

  const refresh = await fetch(`${base}/api/v1/auth/refresh`, {
    method: 'POST',
    headers: { Cookie: cookie, 'X-CSRF-Protection': '1' },
  });
  record('POST refresh rotates the session', refresh.status === 200, { status: refresh.status });
  const replay = await fetch(`${base}/api/v1/auth/refresh`, {
    method: 'POST',
    headers: { Cookie: cookie, 'X-CSRF-Protection': '1' },
  });
  record('replaying the old refresh token is rejected', replay.status === 401, { status: replay.status });
  const anonStatus = await fetch(`${base}/internal/status`);
  record('GET /internal/status without auth → 401', anonStatus.status === 401, { status: anonStatus.status });
} catch (e) {
  record('smoke run', false, (e as Error).message);
} finally {
  // Kill the whole tree: with shell=true on Windows, kill() would only end the cmd.exe wrapper (observed: orphaned API).
  if (api?.pid) {
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(api.pid), '/T', '/F']);
    else api.kill('SIGKILL');
  }
  await pg.stop();
  const pass = steps.every((s) => s.ok);
  mkdirSync('audit/test-results/phase3', { recursive: true });
  writeFileSync(
    'audit/test-results/phase3/api-process-smoke.json',
    JSON.stringify(
      {
        recordedAt: new Date().toISOString(),
        pass,
        steps,
        notVerified: [
          'graceful SIGTERM drain (Windows cannot deliver SIGTERM to a child; verify in Linux container, Phase 8/9)',
        ],
      },
      null,
      2,
    ),
  );
  console.log(pass ? 'SMOKE PASS' : 'SMOKE FAIL');
  process.exit(pass ? 0 : 1);
}
