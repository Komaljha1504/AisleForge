/**
 * Applies migrations and (optionally) seeds demo data. Used by the browser tests, the demo and the container setup.
 *
 *   DATABASE_URL=... [SEED_PASSWORD=...] pnpm db:init
 *
 * Prints one JSON line with the result (consumed by tests/e2e/global-setup.ts).
 */
import { runMigrations } from '@aisleforge/database';
import { seedDemo } from './seed';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is required');
  process.exit(2);
}
// In Kubernetes the migrate initContainer can start before PostgreSQL accepts connections (observed on kind: one
// ECONNREFUSED crash per pod, recovered only by the kubelet's restart backoff). Wait a bounded time for connection-class
// errors only; any other error (bad SQL, auth failure) still fails immediately.
const WAIT_MS = Number(process.env.DB_WAIT_SECONDS ?? 90) * 1000;
const RETRIABLE = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'ECONNRESET', '57P03']);
async function withDbWait<T>(fn: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + WAIT_MS;
  for (;;) {
    try {
      return await fn();
    } catch (e) {
      const code = (e as { code?: string }).code ?? '';
      if (!RETRIABLE.has(code) || Date.now() > deadline) throw e;
      console.error(`database not reachable yet (${code}); retrying`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}
const applied = await withDbWait(() => runMigrations(url));
const password = process.env.SEED_PASSWORD;
let accounts: unknown = null;
if (password) {
  if (password.length < 12) {
    console.error('SEED_PASSWORD must be at least 12 characters');
    process.exit(2);
  }
  accounts = await seedDemo(url, { password });
}
console.log(JSON.stringify({ migrations: applied, seeded: accounts !== null, accounts }));
