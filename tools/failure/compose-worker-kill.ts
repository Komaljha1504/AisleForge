/**
 * Runbook E3 against the Docker Compose stack, exactly as written: `docker compose kill -s SIGKILL worker`, ten times,
 * under continuous order load, on the Linux worker container. Afterwards every container death is read from
 * `docker events` with its exit code: the test's kills exit 137; ANY other exit code is a worker that died on its own
 * (on Windows this was a native 0xC0000005 crash, defect D-K5). Pass rule: backlog drains, every order has exactly
 * one pick task, invariants I1–I7 hold, and no unexplained exit.
 *
 *   SEED_PASSWORD=... pnpm tsx tools/failure/compose-worker-kill.ts
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

const BASE = 'http://localhost:8088';
const PASSWORD = process.env.SEED_PASSWORD!;
const KILLS = Number(process.env.KILLS ?? 10);
const docker = (args: string[]) =>
  execFileSync('docker', args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
const psql = (sql: string) =>
  spawnSync(
    'docker',
    [
      'compose',
      'exec',
      '-T',
      'postgres',
      'sh',
      '-c',
      'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At -F "|" -v ON_ERROR_STOP=1',
    ],
    {
      input: sql,
      encoding: 'utf8',
    },
  ).stdout.trim();

async function login(email: string): Promise<string> {
  const r = await fetch(`${BASE}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: BASE },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  return ((await r.json()) as { accessToken: string }).accessToken;
}

const startedAt = new Date();
const customer = await login('customer@demo.aisleforge.test');
const stats = { placed: 0, errors: 0 };
let running = true;
const load = (async () => {
  const skus = ['PASTA-500', 'RICE-2KG', 'TOMATO-CAN', 'APPLE-6', 'COFFEE-250'];
  let i = 0;
  while (running) {
    const t0 = Date.now();
    try {
      const r = await fetch(`${BASE}/api/v1/orders`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${customer}`,
          'Idempotency-Key': `e3-${randomUUID()}`,
          Origin: BASE,
        },
        body: JSON.stringify({
          storeId: 1 + (i % 2),
          lines: [
            { sku: skus[i % 5], qty: 1 },
            { sku: skus[(i + 2) % 5], qty: 1 },
          ],
        }),
      });
      if (r.status === 201) stats.placed++;
      else stats.errors++;
    } catch {
      stats.errors++;
    }
    i++;
    await new Promise((r) => setTimeout(r, Math.max(0, 125 - (Date.now() - t0)))); // ~8 orders/s
  }
})();

// Per-kill evidence straight from `docker inspect` (the docker events window proved unreliable across the
// Windows/WSL clock boundary: it reported 2 deaths for 10 kills). Before each kill the worker must still be the SAME
// process we last started (unchanged StartedAt, running) — otherwise it died/restarted on its own.
const inspect = () => {
  const [running, startedAt, exitCode] = docker([
    'inspect',
    '-f',
    '{{.State.Running}}|{{.State.StartedAt}}|{{.State.ExitCode}}',
    'aisleforge-worker-1',
  ])
    .trim()
    .split('|');
  return { running: running === 'true', startedAt: startedAt!, exitCode: Number(exitCode) };
};
const kills: {
  at: string;
  runningBefore: boolean;
  sameProcessSinceLastStart: boolean;
  exitCodeAfterKill: number;
}[] = [];
let lastStart = inspect().startedAt;
for (let k = 0; k < KILLS; k++) {
  await new Promise((r) => setTimeout(r, 5000 + Math.random() * 3000));
  const before = inspect();
  docker(['compose', 'kill', '-s', 'SIGKILL', 'worker']);
  const after = inspect();
  kills.push({
    at: new Date().toISOString(),
    runningBefore: before.running,
    sameProcessSinceLastStart: before.startedAt === lastStart,
    exitCodeAfterKill: after.exitCode,
  });
  await new Promise((r) => setTimeout(r, 1500));
  docker(['compose', '--profile', 'app', 'start', 'worker']);
  lastStart = inspect().startedAt;
}
await new Promise((r) => setTimeout(r, 5000));
const finalState = inspect();
const silentDeaths =
  kills.filter((k) => !k.runningBefore || !k.sameProcessSinceLastStart).length +
  (finalState.running && finalState.startedAt === lastStart ? 0 : 1);
running = false;
await load;

const unconsumedSql = `SELECT count(*) FROM outbox o WHERE o.event_type IN ('order.placed','order.cancelled','order.picked')
  AND (o.published_at IS NULL OR NOT EXISTS (SELECT 1 FROM processed_events p WHERE p.consumer_name='order-workflow' AND p.event_id=o.event_id));`;
const tDrain = Date.now();
let unconsumed = Number(psql(unconsumedSql));
while (unconsumed > 0 && Date.now() - tDrain < 180_000) {
  await new Promise((r) => setTimeout(r, 1000));
  unconsumed = Number(psql(unconsumedSql));
}
const drainMs = Date.now() - tDrain;
const orders = Number(psql('SELECT count(*) FROM orders;'));
const tasks = Number(psql('SELECT count(*) FROM pick_tasks;'));
const dupTasks = Number(
  psql('SELECT count(*) FROM (SELECT order_id FROM pick_tasks GROUP BY 1 HAVING count(*) > 1) d;'),
);
const invSql = `SET aisleforge.outbox_threshold = '0 seconds'; SET aisleforge.consumer_threshold = '0 seconds';\n${readFileSync('audit/load-tests/invariants.sql', 'utf8')}`;
const invariants = psql(invSql)
  .split('\n')
  .filter((l) => /^I\d\|/.test(l))
  .map((l) => {
    const [id, , status, violations] = l.split('|');
    return { id, status, violations: Number(violations) };
  });
const killExitCodes = kills.map((k) => k.exitCodeAfterKill);
const pass =
  unconsumed === 0 &&
  tasks === orders &&
  dupTasks === 0 &&
  silentDeaths === 0 &&
  killExitCodes.every((c) => c === 137) &&
  invariants.every((r) => r.status === 'PASS');
void startedAt;
const evidence = {
  recordedAt: new Date().toISOString(),
  experiment: 'E3 on Docker Compose (Linux worker container): docker compose kill -s SIGKILL worker',
  kills,
  load: stats,
  drainAfterLoadMs: drainMs,
  unconsumedAfterDrain: unconsumed,
  orders,
  tasks,
  duplicateTasks: dupTasks,
  killExitCodes,
  workerDiedOrRestartedOnItsOwn: silentDeaths,
  finalWorkerState: finalState,
  invariants,
  pass,
};
const dir = path.resolve(process.env.AISLEFORGE_EVIDENCE_ROOT ?? 'audit/test-results', 'phase6');
mkdirSync(dir, { recursive: true });
const file = path.join(
  dir,
  `E3-compose-worker-kill.run-${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
);
writeFileSync(file, JSON.stringify(evidence, null, 2));
console.log(
  JSON.stringify({ ...evidence, invariants: invariants.map((r) => `${r.id}:${r.status}`) }, null, 1),
);
console.log(`evidence: ${file}`);
process.exitCode = pass ? 0 : 1;
