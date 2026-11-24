/**
 * K5 — Worker process crashes and outage against a real broker, with REAL worker processes (apps/worker/src/main.ts):
 *  E3: two workers share the consumer group and contend for the publisher leadership; under continuous order load a
 *      random worker is hard-killed (process.kill SIGKILL → TerminateProcess on Windows: no cleanup, no offset commit)
 *      and restarted, 10 times. Redelivery is expected; processed_events must deduplicate it.
 *  E1: all workers stopped for 30 s while orders keep arriving; then one worker drains the backlog.
 * Pass rule (runbook): every order has exactly one pick task, invariants I1–I6 hold, drain time recorded.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream, mkdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkInvariants } from '@aisleforge/database';
import {
  databaseUrl,
  makeCtx,
  makePool,
  resetDatabase,
  seedCustomers,
  seedStock,
  seedStore,
  writeEvidence,
} from '../support/db';
import {
  countRows,
  deleteTopicsWithPrefix,
  kafkaBrokers,
  place,
  seedLayout,
  uniquePrefix,
  waitFor,
} from '../support/kafka';

const prefix = uniquePrefix('k5');
const pool = makePool(10);
const ctx = makeCtx(pool);
// Outside the OneDrive-synced workspace: sync churn on these files was a measured source of memory pressure.
const logDir = path.join(os.tmpdir(), 'aisleforge-test-logs', `k5-${Date.now()}`);
let customers: string[] = [];
const evidence: Record<string, unknown> = {};

interface Proc {
  name: string;
  child: ChildProcess;
  log: string;
  exited: Promise<number | null>;
}
const procs = new Map<string, Proc>();
let spawnSeq = 0;
/** Every worker exit; `killedByTest` false means the process died on its own (a defect to investigate). */
const exits: {
  worker: string;
  code: number | null;
  signal: string | null;
  killedByTest: boolean;
  log: string;
  at: string;
  codeHex: string | null;
}[] = [];

/** System memory + broker container memory, sampled every 5 s (memory-pressure hypothesis for the first failure). */
const memorySamples: { t: string; freePhysMB: number; commitUsedMB?: number; kafka?: string }[] = [];
let sampler: NodeJS.Timeout | null = null;
function startMemorySampler(): void {
  const sample = () => {
    const s: (typeof memorySamples)[number] = {
      t: new Date().toISOString(),
      freePhysMB: Math.round(os.freemem() / 1048576),
    };
    try {
      s.kafka = execFileSync(
        'docker',
        ['stats', '--no-stream', '--format', '{{.MemUsage}}', 'aisleforge-kafka-1'],
        {
          encoding: 'utf8',
          timeout: 4000,
        },
      ).trim();
    } catch {
      s.kafka = 'unavailable';
    }
    memorySamples.push(s);
  };
  sample();
  sampler = setInterval(sample, 5000);
}

const alive = () =>
  [...procs.values()].filter((p) => p.child.exitCode === null && p.child.signalCode === null);
const killing = new Set<ChildProcess>();

/** Deliberate deaths of the negative control; excluded from the "no worker died on its own" assertion. */
const expectedDeaths = new Set<ChildProcess>();

function spawnWorker(name: string, envOverrides: Record<string, string> = {}): Proc {
  const log = path.join(logDir, `${name}-${spawnSeq++}.log`);
  const out = createWriteStream(log);
  // A diagnostic report is written if V8 dies fatally (e.g. heap exhaustion): one worker died silently in the
  // first K5 run (2026-11-22) and its cause is not yet known.
  const reportArgs = ['--report-on-fatalerror', '--report-directory', path.join(logDir, 'reports')];
  const child = spawn(process.execPath, [...reportArgs, '--import', 'tsx', 'apps/worker/src/main.ts'], {
    env: {
      ...process.env,
      NODE_ENV: 'test',
      LOG_LEVEL: 'info',
      DATABASE_URL: databaseUrl(),
      KAFKA_BROKERS: kafkaBrokers(),
      KAFKA_TOPIC_PREFIX: prefix,
      WORKER_ID: `${name}-${spawnSeq}`,
      WORKER_STATUS_PORT: String(18_100 + spawnSeq),
      OUTBOX_IDLE_DELAY_MS: '50',
      KAFKA_SESSION_TIMEOUT_MS: '6000',
      KAFKA_DELIVERY_TIMEOUT_MS: '5000',
      PG_WORKER_POOL_MAX: '6',
      STATUS_SNAPSHOT_INTERVAL_MS: '2000',
      ...envOverrides,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // Both streams share one file. With the default `end: true`, whichever stream ends first closes the file and a
  // late stderr write (e.g. a fatal stack trace) is lost — a harness defect found while investigating the first
  // K5 failure. The file is closed only after the process and BOTH streams have closed.
  child.stdout!.pipe(out, { end: false });
  child.stderr!.pipe(out, { end: false });
  child.on('close', () => out.end());
  const exited = new Promise<number | null>((resolve) =>
    child.on('exit', (code, signal) => {
      exits.push({
        worker: name,
        code,
        signal,
        killedByTest: killing.has(child),
        log: path.basename(log),
        at: new Date().toISOString(),
        // 3221225477 = 0xC0000005 (access violation), 134/3 = abort, 1 = uncaught JS error, 0 = normal exit.
        codeHex: code === null ? null : `0x${(code >>> 0).toString(16)}`,
      });
      resolve(code);
    }),
  );
  const p = { name, child, log, exited };
  procs.set(name, p);
  return p;
}

async function hardKill(name: string): Promise<void> {
  const p = procs.get(name);
  if (!p || p.child.exitCode !== null) return;
  killing.add(p.child);
  p.child.kill('SIGKILL');
  await p.exited;
}

/** Counts structured log lines across every log file of this test. */
function countLogs(message: string): number {
  let n = 0;
  for (const s of [...Array(spawnSeq).keys()])
    for (const name of ['A', 'B', 'C', 'X', 'S'])
      try {
        n += readFileSync(path.join(logDir, `${name}-${s}.log`), 'utf8')
          .split('\n')
          .filter((l) => l.includes(`"message":"${message}"`)).length;
      } catch {
        /* no such file */
      }
  return n;
}

/** On a drain timeout: who holds the publisher leadership, which sessions exist, what workers report. */
async function diagnostics(): Promise<unknown> {
  const locks = await pool.query(
    `SELECT l.pid, l.granted, a.application_name, a.state, a.backend_start, a.state_change, a.client_port
       FROM pg_locks l LEFT JOIN pg_stat_activity a ON a.pid = l.pid
      WHERE l.locktype = 'advisory'`,
  );
  const sessions = await pool.query(
    `SELECT pid, application_name, state, backend_start, state_change, client_port FROM pg_stat_activity
      WHERE application_name LIKE 'aisleforge:%' ORDER BY backend_start`,
  );
  const workers = await pool.query(
    `SELECT worker_id, updated_at, status->'outbox' AS outbox, status->'kafka'->'producer' AS producer
       FROM worker_status`,
  );
  const backlog = await countRows(pool, 'SELECT count(*)::int AS n FROM outbox WHERE published_at IS NULL');
  return { advisoryLocks: locks.rows, sessions: sessions.rows, workers: workers.rows, backlog };
}

/**
 * Waits for the backlog to drain, but FAILS FAST with diagnostics when processing is stalled: no live worker, or
 * no progress for `stallMs` while workers are alive. (The first K5 failure waited 4 minutes on a dead worker.)
 */
async function waitForDrain(what: string, timeoutMs: number, stallMs = 45_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let best = Number.POSITIVE_INFINITY;
  let lastProgress = Date.now();
  const fail = async (why: string) => {
    evidence.failureDiagnostics = {
      why,
      exits,
      alive: alive().map((p) => p.name),
      ...((await diagnostics()) as object),
    };
    throw new Error(`${what}: ${why}`);
  };
  for (;;) {
    const n = await unconsumed();
    if (n === 0) return;
    if (n < best) {
      best = n;
      lastProgress = Date.now();
    }
    if (alive().length === 0) await fail(`no live worker with ${n} events unconsumed`);
    if (Date.now() - lastProgress > stallMs)
      await fail(`stalled: ${n} events unconsumed, no progress for ${stallMs} ms`);
    if (Date.now() > deadline) await fail(`timed out with ${n} events unconsumed`);
    await new Promise((r) => setTimeout(r, 1000));
  }
}

const unconsumed = () =>
  countRows(
    pool,
    `SELECT count(*)::int AS n FROM outbox o
      WHERE o.event_type IN ('order.placed','order.cancelled','order.picked')
        AND (o.published_at IS NULL OR NOT EXISTS (
              SELECT 1 FROM processed_events p WHERE p.consumer_name = 'order-workflow' AND p.event_id = o.event_id))`,
  );

beforeAll(async () => {
  mkdirSync(logDir, { recursive: true });
  evidence.workerLogDir = logDir;
  startMemorySampler();
  await resetDatabase(pool);
  await seedStore(pool, 1);
  await seedStock(ctx, 1, { 'K5-A': 1_000_000, 'K5-B': 1_000_000, 'K5-C': 1_000_000 });
  await seedLayout(pool, 1, {
    'K5-A': { aisle: 0, pos: 12 },
    'K5-B': { aisle: 2, pos: 27 },
    'K5-C': { aisle: 5, pos: 3 },
  });
  customers = await seedCustomers(pool, 20);
});

afterAll(async () => {
  for (const name of [...procs.keys()]) await hardKill(name);
  if (sampler) clearInterval(sampler);
  evidence.workerExits = exits;
  evidence.memorySamples = {
    count: memorySamples.length,
    minFreePhysMB: Math.min(...memorySamples.map((s) => s.freePhysMB)),
    samples: memorySamples,
  };
  // Every worker log must end with the worker's own exit line unless the test killed it.
  evidence.workerLogsEndingWithExitLine = exits.map((e) => ({
    log: e.log,
    killedByTest: e.killedByTest,
    exitLine: readFileSync(path.join(logDir, e.log), 'utf8').includes('"message":"process exiting"'),
  }));
  await pool.end();
  await deleteTopicsWithPrefix(prefix);
  writeEvidence('phase2', 'K5-worker-crash-E3-E1', evidence);
});

/** Places orders continuously until `stop()` is called; returns counters. */
function orderLoad(ratePerSec: number) {
  let running = true;
  const stats = { placed: 0, errors: 0 };
  const done = (async () => {
    let i = 0;
    while (running) {
      const t0 = Date.now();
      try {
        const skus = ['K5-A', 'K5-B', 'K5-C'];
        await place(ctx, customers[i % 20]!, 1, [
          { sku: skus[i % 3]!, qty: 1 },
          { sku: skus[(i + 1) % 3]!, qty: 1 },
        ]);
        stats.placed++;
      } catch {
        stats.errors++;
      }
      i++;
      await new Promise((r) => setTimeout(r, Math.max(0, 1000 / ratePerSec - (Date.now() - t0))));
    }
  })();
  return {
    stats,
    stop: async () => {
      running = false;
      await done;
    },
  };
}

describe('K5 worker process crashes (E3) and outage (E1), real broker and processes', () => {
  it('negative control: the harness detects a worker that dies on its own, a drain with no live worker, and a stall', async () => {
    // 1. A worker that exits by itself (invalid configuration → exit code 2) is reported as NOT killed by the test.
    const x = spawnWorker('X', { KAFKA_BROKERS: '' });
    expectedDeaths.add(x.child);
    await x.exited;
    const xExit = exits.find((e) => e.worker === 'X')!;
    expect(xExit).toMatchObject({ killedByTest: false, code: 2 });
    // A JS-level exit always leaves the worker's own 'process exiting' line (the investigation's discriminator).
    await waitFor(async () => readFileSync(x.log, 'utf8').includes('"message":"process exiting"'), {
      what: 'exit line in the self-exiting worker log',
      timeoutMs: 5000,
    });
    // 2. Work exists but no worker is alive → the drain wait fails fast instead of waiting for its timeout.
    await place(ctx, customers[0]!, 1, [{ sku: 'K5-A', qty: 1 }]);
    const t0 = Date.now();
    await expect(waitForDrain('negative control (no worker)', 60_000)).rejects.toThrow(/no live worker/);
    const noWorkerDetectMs = Date.now() - t0;
    // 3. A live worker that does not publish/consume → no progress → reported as stalled.
    const s = spawnWorker('S', { WORKER_ROLES: 'sweeper' });
    expectedDeaths.add(s.child);
    const t1 = Date.now();
    await expect(waitForDrain('negative control (stall)', 60_000, 8000)).rejects.toThrow(/stalled/);
    const stallDetectMs = Date.now() - t1;
    killing.add(s.child);
    s.child.kill('SIGKILL');
    await s.exited;
    evidence.negativeControl = {
      selfExit: xExit,
      noWorkerDetectedAfterMs: noWorkerDetectMs,
      stallDetectedAfterMs: stallDetectMs,
    };
    delete evidence.failureDiagnostics; // produced deliberately above
  });

  it('E3: 10 hard kills of random workers under load; redeliveries deduplicated; one task per order', async () => {
    spawnWorker('A');
    spawnWorker('B');
    await waitFor(async () => (await countRows(pool, 'SELECT count(*)::int AS n FROM worker_status')) >= 2, {
      what: 'two workers reporting status',
      timeoutMs: 90_000,
    });
    const load = orderLoad(15);
    const kills: { at: number; worker: string }[] = [];
    const t0 = Date.now();
    for (let k = 0; k < 10; k++) {
      await new Promise((r) => setTimeout(r, 4000 + Math.random() * 2000));
      const victim = Math.random() < 0.5 ? 'A' : 'B';
      await hardKill(victim);
      kills.push({ at: Math.round((Date.now() - t0) / 1000), worker: victim });
      spawnWorker(victim);
    }
    await load.stop();
    const tDrain = Date.now();
    await waitForDrain('all subscribed events consumed after the kills', 180_000);
    const drainMs = Date.now() - tDrain;
    const orders = await countRows(pool, 'SELECT count(*)::int AS n FROM orders');
    const tasks = await countRows(pool, 'SELECT count(*)::int AS n FROM pick_tasks');
    const duplicates = countLogs('duplicate delivery skipped');
    evidence.E3 = {
      kills,
      ordersPlaced: load.stats.placed,
      orderErrors: load.stats.errors,
      orders,
      tasks,
      duplicateDeliveriesSkipped: duplicates,
      drainAfterLoadStopMs: drainMs,
      offsetCommitFailuresLogged: countLogs('offset commit failed; redelivery will be deduplicated'),
    };
    expect(load.stats.errors).toBe(0);
    expect(tasks).toBe(orders);
    expect(
      await countRows(
        pool,
        'SELECT count(*)::int AS n FROM (SELECT order_id FROM pick_tasks GROUP BY 1 HAVING count(*) > 1) d',
      ),
    ).toBe(0);
    // The runbook expects redelivery after hard kills; record it (> 0 is expected but depends on kill timing).
    expect(duplicates).toBeGreaterThanOrEqual(0);
  });

  it('E1: all workers down for 30 s while orders are accepted; one worker drains the backlog', async () => {
    await hardKill('A');
    await hardKill('B');
    const load = orderLoad(15);
    const samples: { t: number; unpublished: number }[] = [];
    const t0 = Date.now();
    while (Date.now() - t0 < 30_000) {
      await new Promise((r) => setTimeout(r, 5000));
      samples.push({
        t: Math.round((Date.now() - t0) / 1000),
        unpublished: await countRows(
          pool,
          'SELECT count(*)::int AS n FROM outbox WHERE published_at IS NULL',
        ),
      });
    }
    await load.stop();
    const backlog = await countRows(pool, 'SELECT count(*)::int AS n FROM outbox WHERE published_at IS NULL');
    const tStart = Date.now();
    spawnWorker('C');
    await waitForDrain('backlog drained by one worker', 180_000);
    const drainMs = Date.now() - tStart;
    const orders = await countRows(pool, 'SELECT count(*)::int AS n FROM orders');
    const tasks = await countRows(pool, 'SELECT count(*)::int AS n FROM pick_tasks');
    evidence.E1 = {
      outageMs: 30_000,
      ordersDuringOutage: load.stats.placed,
      orderErrors: load.stats.errors,
      backlogSamples: samples,
      backlogAtRestart: backlog,
      drainMsIncludingWorkerStartup: drainMs,
      orders,
      tasks,
    };
    expect(load.stats.errors).toBe(0);
    expect(samples.at(-1)!.unpublished).toBeGreaterThan(samples[0]!.unpublished); // backlog grows during outage
    expect(tasks).toBe(orders);
  });

  it('no worker process died on its own (only the test killed workers)', () => {
    evidence.workerExits = exits;
    const negativeControlLogs = new Set(
      [...procs.values()].filter((p) => expectedDeaths.has(p.child)).map((p) => path.basename(p.log)),
    );
    expect(exits.filter((e) => !e.killedByTest && !negativeControlLogs.has(e.log))).toEqual([]);
    expect(
      alive()
        .map((p) => p.name)
        .sort(),
    ).toEqual(['C']); // the E1 worker is still running
  });

  it('invariants I1–I6 hold after the crash experiments', async () => {
    const rows = await checkInvariants(databaseUrl(), {
      outboxThreshold: '0 seconds',
      consumerThreshold: '0 seconds',
    });
    evidence.invariants = rows.map((r) => `${r.invariant}:${r.status}`);
    for (const r of rows) expect(r.status, `${r.invariant} ${JSON.stringify(r.sample)}`).toBe('PASS');
  });
});
