/**
 * End-to-end smoke test of the RUNNING Docker Compose stack, through the nginx front door (same origin as a browser):
 * health → customer login → order (stock reserved) → outbox → Kafka → containerized worker → pick task →
 * picker claim → /sync picks + completion → order picked. Writes evidence; exits non-zero on any failure.
 *
 *   SEED_PASSWORD=... pnpm tsx tools/smoke/compose-smoke.ts [baseUrl=http://localhost:8088]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const BASE = process.argv[2] ?? 'http://localhost:8088';
const PASSWORD = process.env.SEED_PASSWORD;
if (!PASSWORD) {
  console.error('SEED_PASSWORD (as used by the migrate job) is required');
  process.exit(2);
}
const steps: { step: string; ok: boolean; ms: number; detail?: unknown }[] = [];
async function step<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const t0 = performance.now();
  try {
    const v = await fn();
    steps.push({ step: name, ok: true, ms: Math.round(performance.now() - t0) });
    console.log('PASS', name);
    return v;
  } catch (e) {
    steps.push({ step: name, ok: false, ms: Math.round(performance.now() - t0), detail: String(e) });
    console.log('FAIL', name, String(e));
    throw e;
  }
}
async function call(
  method: string,
  p: string,
  token?: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  const r = await fetch(BASE + p, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      Origin: BASE,
      ...headers,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await r.text();
  return { status: r.status, headers: r.headers, json: text ? (JSON.parse(text) as any) : null }; // eslint-disable-line @typescript-eslint/no-explicit-any
}
const expectStatus = (r: { status: number; json: unknown }, s: number) => {
  if (r.status !== s) throw new Error(`expected ${s}, got ${r.status}: ${JSON.stringify(r.json)}`);
};
const login = async (email: string) => {
  const r = await call('POST', '/api/v1/auth/login', undefined, { email, password: PASSWORD });
  expectStatus(r, 200);
  return r.json.accessToken as string;
};
const wait = async <T>(fn: () => Promise<T | null>, what: string, ms = 60_000): Promise<T> => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 500));
  }
};

let exitCode = 0;
try {
  await step('front door serves the PWA shell (+ service worker, security headers)', async () => {
    const r = await fetch(BASE + '/');
    if (!r.ok || !(await r.text()).includes('<div id="root">')) throw new Error(`index ${r.status}`);
    if (!(await fetch(BASE + '/sw.js')).ok) throw new Error('no service worker');
    for (const h of [
      'content-security-policy',
      'x-content-type-options',
      'x-frame-options',
      'referrer-policy',
    ])
      if (!r.headers.get(h)) throw new Error(`app shell served without ${h}`);
    if (r.headers.get('cache-control') !== 'no-cache')
      throw new Error('app shell must revalidate (Cache-Control)');
  });
  await step('API readiness through the proxy', async () =>
    expectStatus(await call('GET', '/health/ready'), 200),
  );
  const customer = await step('customer login', () => login('customer@demo.aisleforge.test'));
  const order = await step('place order (PostgreSQL reserves stock)', async () => {
    const r = await call(
      'POST',
      '/api/v1/orders',
      customer,
      {
        storeId: 1,
        lines: [
          { sku: 'PASTA-500', qty: 2 },
          { sku: 'MILK-1L', qty: 1 },
        ],
      },
      { 'Idempotency-Key': `smoke-${randomUUID()}` },
    );
    expectStatus(r, 201);
    return r.json.orderId as string;
  });
  const picker = await step('picker login', () => login('picker@demo.aisleforge.test'));
  const task = await step(
    'worker (container) consumed order.placed from Kafka and created the pick task',
    () =>
      wait(async () => {
        // `all` is newest-first. `available` is FIFO (oldest first) by design, so on a database that already holds
        // more than 200 open tasks (e.g. after load runs) the new task is not on its first page: that made the
        // Phase 10 final run's smoke attempts 1-2 time out although the worker had created the task in < 0.5 s.
        const r = await call('GET', '/api/v1/pick-tasks?scope=all&limit=50', picker);
        return (
          (r.json.tasks as { id: string; orderId: string; routeStatus: string }[]).find(
            (t) => t.orderId === order,
          ) ?? null
        );
      }, 'pick task'),
  );
  const claimed = await step('claim task (lease)', async () => {
    const r = await call('POST', `/api/v1/pick-tasks/${task.id}/claim`, picker);
    expectStatus(r, 200);
    return r.json.task as { lines: { orderLineId: string; sku: string; qty: number }[] };
  });
  await step('sync picks + completion (idempotent op log)', async () => {
    const deviceId = randomUUID();
    const ops = [
      ...claimed.lines.map((l, i) => ({
        opId: randomUUID(),
        seq: i + 1,
        type: 'pick.confirm',
        taskId: task.id,
        payload: { orderLineId: l.orderLineId, scannedSku: l.sku, pickedQty: l.qty },
      })),
      {
        opId: randomUUID(),
        seq: claimed.lines.length + 1,
        type: 'task.complete',
        taskId: task.id,
        payload: {},
      },
    ];
    const r = await call('POST', '/api/v1/sync', picker, { deviceId, ops });
    expectStatus(r, 200);
    const statuses = (r.json.results as { status: string }[]).map((x) => x.status);
    if (statuses.some((s) => s !== 'applied')) throw new Error(`sync results ${statuses.join(',')}`);
    const again = await call('POST', '/api/v1/sync', picker, { deviceId, ops });
    if ((again.json.results as { status: string }[]).some((x) => x.status !== 'duplicate'))
      throw new Error('replay not deduplicated');
  });
  await step('order reaches picked', () =>
    wait(async () => {
      const r = await call('GET', `/api/v1/orders/${order}`, customer);
      return r.json.order.status === 'picked' ? r.json.order : null;
    }, 'order picked'),
  );
  await step('admin diagnostics show a reporting worker with Kafka state', async () => {
    const admin = await login('admin@demo.aisleforge.test');
    const r = await call('GET', '/internal/status', admin);
    expectStatus(r, 200);
    // A hard-killed worker (SIGKILL in E3) never deletes its snapshot; the API flags such rows stale. Require at
    // least one LIVE worker rather than looking at the first row (Phase 10 final run, attempt 3).
    const workers = (r.json.workers ?? []) as {
      stale: boolean;
      status?: { kafka?: { producer?: { connected?: boolean } } };
    }[];
    const live = workers.find((w) => !w.stale && w.status?.kafka?.producer?.connected);
    if (!live)
      throw new Error(
        `no live worker with a connected producer: ${JSON.stringify(workers.map((w) => ({ stale: w.stale })))}`,
      );
    return { workersListed: workers.length, stale: workers.filter((w) => w.stale).length };
  });
} catch {
  exitCode = 1;
} finally {
  const dir = path.resolve(process.env.AISLEFORGE_EVIDENCE_ROOT ?? 'audit/test-results', 'phase8');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `compose-smoke.run-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  writeFileSync(
    file,
    JSON.stringify(
      { recordedAt: new Date().toISOString(), base: BASE, pass: exitCode === 0, steps },
      null,
      2,
    ),
  );
  console.log(`evidence: ${file}`);
}
// exitCode instead of process.exit(): exiting while fetch sockets are closing trips a libuv assertion on Windows.
process.exitCode = exitCode;
