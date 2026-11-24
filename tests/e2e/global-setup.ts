/**
 * Starts the REAL stack for browser tests: embedded PostgreSQL (migrated + seeded), the API and worker processes
 * (apps/api and apps/worker main.ts) against the real Kafka broker (docker compose up -d kafka), and the BUILT PWA via
 * `vite preview` (production service worker). Nothing is mocked. Logs and data go to %TEMP% (outside OneDrive).
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import { API_PORT, E2E_PASSWORD, STACK_FILE, WEB_PORT } from './stack';

const freePort = (): Promise<number> =>
  new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const p = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(p));
    });
  });

async function waitHttp(url: string, what: string, timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`${what} did not become ready at ${url}`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  const root = path.join(os.tmpdir(), 'aisleforge-e2e');
  const runDir = path.join(root, `run-${Date.now()}`);
  mkdirSync(runDir, { recursive: true });
  if (!existsSync(path.resolve('apps/web/dist/index.html')))
    throw new Error('Build the PWA first: pnpm --filter @aisleforge/web build');

  const pgPort = await freePort();
  const pgDir = path.join(runDir, 'pgdata');
  rmSync(pgDir, { recursive: true, force: true });
  const pgLog = createWriteStream(path.join(runDir, 'postgres.log'));
  const pgServer = new EmbeddedPostgres({
    databaseDir: pgDir,
    user: 'postgres',
    password: 'e2e-only-password',
    port: pgPort,
    // We delete the directory ourselves after stop(): with persistent:false the library removes it immediately after
    // PostgreSQL exits, while Windows still holds file handles → EBUSY failed the Phase 10 final run's teardown.
    persistent: true,
    postgresFlags: ['-c', 'max_connections=100', '-c', 'io_method=sync'],
    onLog: (m) => pgLog.write(`${String(m)}\n`),
    onError: (m) => pgLog.write(`${String(m)}\n`),
  });
  await pgServer.initialise();
  await pgServer.start();
  await pgServer.createDatabase('aisleforge_e2e');
  const databaseUrl = `postgres://postgres:e2e-only-password@127.0.0.1:${pgPort}/aisleforge_e2e`;
  // Migrations + seed run in a tsx process (the workspace packages are TypeScript sources).
  const init = spawnSync(process.execPath, ['--import', 'tsx', 'tools/seed/init-db.ts'], {
    env: { ...process.env, DATABASE_URL: databaseUrl, SEED_PASSWORD: E2E_PASSWORD },
    encoding: 'utf8',
  });
  if (init.status !== 0) throw new Error(`database init failed: ${init.stderr || init.stdout}`);
  const accounts = (JSON.parse(init.stdout.trim().split('\n').at(-1)!) as { accounts: unknown }).accounts;

  const prefix = `e2e${Date.now().toString(36)}.`;
  const common = { ...process.env, NODE_ENV: 'production', LOG_LEVEL: 'info', DATABASE_URL: databaseUrl };
  const procs: ChildProcess[] = [];
  const start = (name: string, args: string[], env: NodeJS.ProcessEnv, cwd = process.cwd()) => {
    const out = createWriteStream(path.join(runDir, `${name}.log`));
    const child = spawn(process.execPath, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout!.pipe(out, { end: false });
    child.stderr!.pipe(out, { end: false });
    child.on('close', () => out.end());
    procs.push(child);
    return child;
  };
  start('api', ['--import', 'tsx', 'apps/api/src/main.ts'], {
    ...common,
    PORT: String(API_PORT),
    JWT_SECRET: randomBytes(48).toString('base64url'),
    CORS_ORIGINS: `http://localhost:${WEB_PORT},http://127.0.0.1:${WEB_PORT}`,
    COOKIE_SECURE: 'true',
    TRUST_PROXY: 'true',
    LOGIN_IP_MAX_ATTEMPTS: '10000',
    SHUTDOWN_DRAIN_DELAY_MS: '0',
  });
  start('worker', ['--import', 'tsx', 'apps/worker/src/main.ts'], {
    ...common,
    KAFKA_BROKERS: process.env.KAFKA_BROKERS ?? '127.0.0.1:9092',
    KAFKA_TOPIC_PREFIX: prefix,
    WORKER_STATUS_PORT: String(await freePort()),
    OUTBOX_IDLE_DELAY_MS: '100',
    RESERVATION_SWEEP_INTERVAL_MS: '60000',
  });
  start(
    'web',
    [
      path.resolve('apps/web/node_modules/vite/bin/vite.js'),
      'preview',
      '--port',
      String(WEB_PORT),
      '--strictPort',
      '--host',
      'localhost',
    ],
    { ...process.env, AISLEFORGE_API_URL: `http://127.0.0.1:${API_PORT}` },
    path.resolve('apps/web'),
  );

  await waitHttp(`http://127.0.0.1:${API_PORT}/health/ready`, 'API');
  await waitHttp(`http://localhost:${WEB_PORT}/`, 'PWA preview');
  const deadline = Date.now() + 120_000;
  const pgc = new (await import('pg')).default.Client({ connectionString: databaseUrl });
  await pgc.connect();
  while ((await pgc.query('SELECT count(*)::int AS n FROM worker_status')).rows[0].n === 0) {
    if (Date.now() > deadline) throw new Error('worker did not report status');
    await new Promise((r) => setTimeout(r, 500));
  }
  await pgc.end();

  writeFileSync(
    STACK_FILE,
    JSON.stringify({ databaseUrl, runDir, accounts, password: E2E_PASSWORD, prefix }, null, 2),
  );
  process.env.AISLEFORGE_E2E_DATABASE_URL = databaseUrl;

  return async () => {
    for (const p of procs) if (p.exitCode === null) p.kill();
    await Promise.all(procs.map((p) => (p.exitCode === null ? new Promise((r) => p.once('exit', r)) : null)));
    await pgServer.stop();
    try {
      rmSync(pgDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
    } catch (err) {
      // A leftover directory in %TEMP% is harmless; it must not turn a passed suite red. It is reported.
      console.warn(`e2e teardown: could not remove ${pgDir} (${String(err)})`);
    }
  };
}
