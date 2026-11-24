/**
 * Runs one k6 profile against the RUNNING Docker Compose stack and records everything needed to interpret it:
 *   - k6 summary (client view: throughput, p50/p95/p99, errors, business outcomes, sync latency, storm latency)
 *   - every 5 s: PostgreSQL wait events (Lock vs IO vs client), API pool use/queue, outbox backlog, consumer lag,
 *     container CPU/memory, host free memory
 *   - after the run (backlog drained): invariants I1–I7
 * into audit/test-results/phase6/runs/<profile>-<shape>-<label>-<utc>/ (unique per run, never overwritten).
 *
 *   SEED_PASSWORD=... pnpm tsx tools/load/run-profile.ts <A|B|C|D> <windowMin> <steady|burst> <label>
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const [profile = 'A', windowMin = '3', shape = 'steady', label = 'run'] = process.argv.slice(2);
const PASSWORD = process.env.SEED_PASSWORD;
if (!PASSWORD) throw new Error('SEED_PASSWORD is required');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const runDir = path.resolve('audit/test-results/phase6/runs', `${profile}-${shape}-${label}-${stamp}`);
mkdirSync(runDir, { recursive: true });
const docker = (args: string[], input?: string) =>
  execFileSync('docker', args, {
    encoding: 'utf8',
    input,
    stdio: ['pipe', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  });
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

// ---- seed (idempotent, additive) --------------------------------------------------------------------------------
const t0 = Date.now();
const seedOut = docker([
  'compose',
  'exec',
  '-T',
  '-e',
  `LOAD_PROFILE=${profile}`,
  '-e',
  `SEED_PASSWORD=${PASSWORD}`,
  'api',
  'node',
  'load-seed.mjs',
]);
console.log('seed:', seedOut.trim(), `${Date.now() - t0} ms`);
const adminToken = await (async () => {
  const r = await fetch('http://localhost:8088/api/v1/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@demo.aisleforge.test', password: PASSWORD }),
  });
  return ((await r.json()) as { accessToken: string }).accessToken;
})();

// ---- server-side sampler ---------------------------------------------------------------------------------------
const samples: Record<string, unknown>[] = [];
let sampling = true;
const sampler = (async () => {
  while (sampling) {
    const at = new Date().toISOString();
    try {
      const waits = psql(
        `SELECT coalesce(wait_event_type,'CPU/none') || ':' || coalesce(wait_event,'-'), count(*) FROM pg_stat_activity
          WHERE datname = current_database() AND state = 'active' AND pid <> pg_backend_pid() GROUP BY 1 ORDER BY 2 DESC;`,
      );
      const lockWaiters = Number(psql(`SELECT count(*) FROM pg_locks WHERE NOT granted;`));
      const longestTxMs = Number(
        psql(
          `SELECT coalesce(max(extract(epoch FROM clock_timestamp() - xact_start)) * 1000, 0)::int FROM pg_stat_activity WHERE datname = current_database() AND xact_start IS NOT NULL AND pid <> pg_backend_pid();`,
        ),
      );
      const status = (await (
        await fetch('http://localhost:8088/internal/status', {
          headers: { Authorization: `Bearer ${adminToken}` },
        })
      ).json()) as {
        postgres: { pools: { name: string; total: number; idle: number; waiting: number }[] };
        outbox: { unpublished: number } | null;
        workers: { stale: boolean; status: { kafka: { lag: Record<string, { lag: number }[]> } } }[] | null;
      };
      // Live workers only: snapshots of killed worker containers stay in worker_status (flagged stale) with their
      // last lag frozen; summing them inflated the first baseline's lag figure.
      const lag = (status.workers ?? [])
        .filter((w) => !w.stale)
        .flatMap((w) => Object.values(w.status?.kafka?.lag ?? {}).flat())
        .reduce((n, p) => n + (p?.lag ?? 0), 0);
      const stats = docker(['stats', '--no-stream', '--format', '{{.Name}}|{{.CPUPerc}}|{{.MemUsage}}'])
        .trim()
        .split('\n');
      samples.push({
        at,
        pgActiveByWait: Object.fromEntries(
          waits
            ? waits
                .split('\n')
                .map((l) => l.split('|'))
                .map(([k, v]) => [k, Number(v)])
            : [],
        ),
        lockWaiters,
        longestOpenTxMs: longestTxMs,
        apiPools: status.postgres.pools,
        outboxUnpublished: status.outbox?.unpublished ?? null,
        consumerLag: lag,
        containers: Object.fromEntries(
          stats.map((l) => l.split('|')).map(([n, c, m]) => [n, { cpu: c, mem: m }]),
        ),
        hostFreeMB: Math.round(os.freemem() / 1048576),
      });
    } catch (e) {
      samples.push({ at, error: String(e) });
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
})();

// ---- k6 ---------------------------------------------------------------------------------------------------------
const tk = Date.now();
const k6 = spawn(
  'docker',
  [
    'run',
    '--rm',
    '--network',
    'aisleforge_default',
    '-v',
    `${path.resolve('load-tests/k6')}:/scripts:ro`,
    '-v',
    `${runDir}:/results`,
    'grafana/k6:0.55.0',
    'run',
    '--quiet',
    '-e',
    `PROFILE=${profile}`,
    '-e',
    `WINDOW_MIN=${windowMin}`,
    '-e',
    `SHAPE=${shape}`,
    '-e',
    `LABEL=${label}`,
    '-e',
    `PASSWORD=${PASSWORD}`,
    '-e',
    'BASE_URL=http://web:8080',
    '/scripts/aisleforge.js',
  ],
  { stdio: ['ignore', 'pipe', 'pipe'] },
);
let k6out = '';
k6.stdout.on('data', (d) => (k6out += String(d)));
k6.stderr.on('data', (d) => (k6out += String(d)));
const k6code: number = await new Promise((r) => k6.on('exit', (c) => r(c ?? -1)));
const k6Ms = Date.now() - tk;

// ---- drain + invariants -----------------------------------------------------------------------------------------
const unconsumedSql = `SELECT count(*) FROM outbox o WHERE o.event_type IN ('order.placed','order.cancelled','order.picked')
  AND (o.published_at IS NULL OR NOT EXISTS (SELECT 1 FROM processed_events p WHERE p.consumer_name='order-workflow' AND p.event_id=o.event_id));`;
const td = Date.now();
let unconsumed = Number(psql(unconsumedSql));
while (unconsumed > 0 && Date.now() - td < 300_000) {
  await new Promise((r) => setTimeout(r, 2000));
  unconsumed = Number(psql(unconsumedSql));
}
const drainMs = Date.now() - td;
sampling = false;
await sampler;
const invariants = psql(
  `SET aisleforge.outbox_threshold = '0 seconds'; SET aisleforge.consumer_threshold = '0 seconds';\n${readFileSync('audit/load-tests/invariants.sql', 'utf8')}`,
)
  .split('\n')
  .filter((l) => /^I\d\|/.test(l))
  .map((l) => {
    const [id, , status, violations] = l.split('|');
    return { id, status, violations: Number(violations) };
  });

writeFileSync(path.join(runDir, 'server-samples.json'), JSON.stringify(samples, null, 2));
writeFileSync(path.join(runDir, 'k6-console.txt'), k6out);
const result = {
  recordedAt: new Date().toISOString(),
  profile,
  shape,
  label,
  windowMin: Number(windowMin),
  k6ExitCode: k6code,
  k6WallMs: k6Ms,
  backlogDrainAfterRunMs: drainMs,
  unconsumedAfterDrain: unconsumed,
  invariants,
  note: 'Profile arrival rates preserved; window shortened to windowMin (machine/time budget). See docs/reports/PERFORMANCE_REPORT.md.',
};
// k6 exit 99 = thresholds crossed (a measured result). Any other non-zero exit, or no summary, means the load
// did not run as specified: the run is INVALID and must not be used as evidence.
const summaryFile = readdirSync(runDir).find((f) => f.startsWith('k6-summary-'));
const summaryWritten = summaryFile !== undefined;
// k6 exits 0 even when every iteration throws, so also require: no script exceptions and orders actually placed.
// "thresholds … have been crossed" is k6 reporting a MEASURED result (exit 99), not a script failure.
const scriptErrors = k6out
  .split('\n')
  .filter((l) => l.includes('level=error') && !l.includes('have been crossed')).length;
const ordersCreated = summaryFile
  ? ((
      JSON.parse(readFileSync(path.join(runDir, summaryFile), 'utf8')) as {
        metrics: Record<string, { values: { count?: number } } | undefined>;
      }
    ).metrics.orders_created?.values.count ?? 0)
  : 0;
const valid = summaryWritten && (k6code === 0 || k6code === 99) && scriptErrors === 0 && ordersCreated > 0;
Object.assign(result, { scriptErrors, ordersCreated });
writeFileSync(path.join(runDir, 'run.json'), JSON.stringify({ ...result, valid, summaryWritten }, null, 2));
console.log(JSON.stringify({ ...result, valid }, null, 1));
console.log(`evidence: ${runDir}`);
if (!valid) {
  writeFileSync(
    path.join(runDir, 'INVALID-RUN.txt'),
    `k6 exit ${k6code}; summary written: ${summaryWritten}. See k6-console.txt.\n`,
  );
  console.error('INVALID RUN: k6 did not complete the workload');
  process.exitCode = 1;
}
