/**
 * One comparable row per k6 run (client metrics from the k6 summary + server-side maxima from the 5 s samples).
 *   pnpm tsx tools/load/summarize.ts <runDir> [<runDir> ...]   → markdown table on stdout + summary.json per run
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// Tolerate a UTF-8 BOM (files rewritten by PowerShell 5.1 Set-Content -Encoding utf8 carry one).
const readJson = (file: string) => JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));

type Metric = { values: Record<string, number>; thresholds?: Record<string, { ok: boolean }> };
interface K6 {
  metrics: Record<string, Metric | undefined>;
  state: { testRunDurationMs: number };
}

const pctl = (m: Metric | undefined, k: string) => (m ? Math.round(m.values[k] ?? NaN) : NaN);
const count = (m: Metric | undefined) => (m ? Math.round(m.values.count ?? 0) : 0);
const memMiB = (s: string) => {
  const v = /([\d.]+)\s*(GiB|MiB|KiB|B)/.exec(s);
  if (!v) return NaN;
  const n = Number(v[1]);
  return Math.round(v[2] === 'GiB' ? n * 1024 : v[2] === 'KiB' ? n / 1024 : v[2] === 'B' ? n / 1048576 : n);
};

const rows = process.argv.slice(2).map((dir) => {
  const run = readJson(path.join(dir, 'run.json'));
  const k6File = readdirSync(dir).find((f) => f.startsWith('k6-summary-'))!;
  const k6 = readJson(path.join(dir, k6File)) as K6;
  const samples = readJson(path.join(dir, 'server-samples.json')) as Record<string, any>[]; // eslint-disable-line @typescript-eslint/no-explicit-any
  const ok = samples.filter((s) => !s.error);
  const max = (f: (s: (typeof ok)[number]) => number) => (ok.length ? Math.max(...ok.map(f)) : NaN);
  const cpu = (name: string) => max((s) => Number(String(s.containers?.[name]?.cpu ?? '0').replace('%', '')));
  const mem = (name: string) => max((s) => memMiB(String(s.containers?.[name]?.mem ?? '')));
  const lockSampleShare = ok.length ? ok.filter((s) => s.lockWaiters > 0).length / ok.length : NaN;
  const orderDur = k6.metrics['http_req_duration{scenario:customers}'] ?? k6.metrics['http_req_duration'];
  const durationS = k6.state.testRunDurationMs / 1000;
  const r = {
    run: path.basename(dir),
    profile: run.profile,
    shape: run.shape,
    label: run.label,
    durationS: Math.round(durationS),
    ordersCreated: count(k6.metrics.orders_created),
    ordersPerSec: Math.round((count(k6.metrics.orders_created) / durationS) * 100) / 100,
    httpReqPerSec: Math.round((k6.metrics.http_reqs?.values.rate ?? NaN) * 10) / 10,
    orderP50: pctl(orderDur, 'med'),
    orderP95: pctl(orderDur, 'p(95)'),
    orderP99: pctl(orderDur, 'p(99)'),
    orderErrorRate: Math.round((k6.metrics.order_errors?.values.rate ?? NaN) * 10000) / 100,
    httpFailedRate: Math.round((k6.metrics.http_req_failed?.values.rate ?? NaN) * 10000) / 100,
    reserveConflicts: count(k6.metrics.reserve_conflicts),
    duplicateReplays: count(k6.metrics.duplicate_replays),
    syncApplied: count(k6.metrics.sync_ops_applied),
    syncRejected: count(k6.metrics.sync_ops_rejected),
    syncShed429: count(k6.metrics.sync_load_shed_429),
    syncP95: pctl(k6.metrics.sync_batch_latency, 'p(95)'),
    stormP95: pctl(k6.metrics.storm_sync_latency, 'p(95)'),
    tasksCompleted: count(k6.metrics.tasks_completed),
    maxLockWaiters: max((s) => s.lockWaiters),
    lockWaitSampleShare: Math.round(lockSampleShare * 100),
    maxOrdersPoolWaiting: max(
      (s) => s.apiPools?.find((p: { name: string }) => p.name === 'orders')?.waiting ?? 0,
    ),
    maxSyncPoolWaiting: max(
      (s) => s.apiPools?.find((p: { name: string }) => p.name === 'sync')?.waiting ?? 0,
    ),
    maxLongestOpenTxMs: max((s) => s.longestOpenTxMs),
    maxOutboxBacklog: max((s) => s.outboxUnpublished ?? 0),
    maxConsumerLag: max((s) => s.consumerLag ?? 0),
    maxCpuApi: cpu('aisleforge-api-1'),
    maxCpuPostgres: cpu('aisleforge-postgres-1'),
    maxCpuWorker: cpu('aisleforge-worker-1'),
    maxMemApiMiB: mem('aisleforge-api-1'),
    maxMemPostgresMiB: mem('aisleforge-postgres-1'),
    maxMemKafkaMiB: mem('aisleforge-kafka-1'),
    minHostFreeMB: ok.length ? Math.min(...ok.map((s) => s.hostFreeMB)) : NaN,
    drainAfterRunMs: run.backlogDrainAfterRunMs,
    invariants: run.invariants.every((i: { status: string }) => i.status === 'PASS')
      ? 'I1–I7 PASS'
      : run.invariants
          .filter((i: { status: string }) => i.status !== 'PASS')
          .map((i: { id: string }) => i.id)
          .join(',') + ' FAIL',
    k6Thresholds: Object.entries(k6.metrics)
      .filter(([, m]) => m?.thresholds)
      .map(([k, m]) => `${k}:${Object.values(m!.thresholds!).every((t) => t.ok) ? 'ok' : 'FAILED'}`)
      .join(' '),
  };
  writeFileSync(path.join(dir, 'summary.json'), JSON.stringify(r, null, 2));
  return r;
});

const cols = Object.keys(rows[0] ?? {});
console.log(`| ${cols.join(' | ')} |`);
console.log(`| ${cols.map(() => '---').join(' | ')} |`);
for (const r of rows)
  console.log(`| ${cols.map((c) => String((r as Record<string, unknown>)[c])).join(' | ')} |`);
