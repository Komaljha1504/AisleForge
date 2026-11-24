import { appendFileSync, mkdirSync, rmSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import EmbeddedPostgres from 'embedded-postgres';
import type { TestProject } from 'vitest/node';
import { runMigrations } from '@aisleforge/database';

declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrl: string;
    databaseKind: string;
  }
}

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      srv.close(() => (typeof addr === 'object' && addr ? resolve(addr.port) : reject(new Error('no port'))));
    });
  });

/**
 * Starts a disposable PostgreSQL for the `db` test project unless TEST_DATABASE_URL points at one
 * (e.g. the Docker Compose postgres in CI). Durability settings are left at defaults (fsync on).
 */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  let url = process.env.TEST_DATABASE_URL;
  let kind = 'external';
  let stop = async (): Promise<void> => undefined;
  if (!url) {
    const port = await freePort();
    // Data directory OUTSIDE the workspace: the workspace is OneDrive-synced, and OneDrive locking files it is
    // uploading made the post-run cleanup fail with EBUSY (observed 2026-11-22).
    const dataRoot = path.join(os.tmpdir(), 'aisleforge-pg-test');
    mkdirSync(dataRoot, { recursive: true });
    const dir = path.join(dataRoot, `pg-test-${port}`);
    rmSync(dir, { recursive: true, force: true });
    const log = path.join(dataRoot, 'pg-test-server.log');
    const pg = new EmbeddedPostgres({
      databaseDir: dir,
      user: 'postgres',
      password: 'test-only-password',
      port,
      persistent: false,
      // io_method=sync: PostgreSQL 18's default 'worker' I/O processes were observed to outlive the postmaster
      // on Windows when the embedded server stops, leaving orphaned postgres.exe processes.
      postgresFlags: ['-c', 'max_connections=150', '-c', 'io_method=sync'],
      onLog: (m) => appendFileSync(log, `${String(m)}\n`),
      onError: (m) => appendFileSync(log, `${String(m)}\n`),
    });
    await pg.initialise();
    await pg.start();
    await pg.createDatabase('aisleforge_test');
    url = `postgres://postgres:test-only-password@127.0.0.1:${port}/aisleforge_test`;
    kind = 'embedded-postgres';
    stop = async () => {
      await pg.stop();
    };
  }
  await runMigrations(url);
  project.provide('databaseUrl', url);
  project.provide('databaseKind', kind);
  return stop;
}
