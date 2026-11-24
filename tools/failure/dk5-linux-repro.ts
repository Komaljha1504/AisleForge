/**
 * D-K5 reproduction harness (Linux containers). Hypothesis from the kind deployment (2026-11-22 17:26Z): the worker
 * dies with a native SIGSEGV (exit 139) when it starts against a broker that is still creating/loading
 * `__consumer_offsets` ("Coordinator load in progress"), the Linux counterpart of the Windows 0xC0000005 crashes.
 *
 * Each iteration, on an isolated Docker network (no Compose volumes touched):
 *   1. start a FRESH single-node KRaft broker (no volume → __consumer_offsets is created and loaded from scratch);
 *   2. start the real worker image at the same moment (it creates topics, joins its consumer groups and starts an
 *      idempotent producer while the coordinator is loading);
 *   3. after OBSERVE_S seconds, record whether the worker is still running, its exit code and its full log;
 *   4. remove the broker and the worker.
 * One PostgreSQL container (migrated with the api image's init-db) serves all iterations.
 *
 *   pnpm tsx tools/failure/dk5-linux-repro.ts [iterations=10] [observeSeconds=60] [label]
 *
 * Evidence → audit/test-results/phase2/k5-investigation/linux-repro-<label>-<ts>/ (logs per iteration + result.json)
 * Environment: KAFKA_SESSION_TIMEOUT_MS etc. come from the image defaults; extra worker env can be passed with
 * REPRO_WORKER_ENV="K=V,K2=V2" (used to test mitigations).
 * REPRO_START_DELAY_S=N: start the worker only after the broker answers metadata requests, plus N seconds (timing
 *   control: if crashes vanish, the trigger is starting against a broker that is still loading).
 * REPRO_WORKER_IMAGE + REPRO_GDB=1: run the worker under gdb (image from tools/failure/dk5-debug.Dockerfile) so a
 *   SIGSEGV prints a native backtrace into the worker log.
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const ITER = Number(process.argv[2] ?? 10);
const OBSERVE_S = Number(process.argv[3] ?? 60);
const LABEL = (process.argv[4] ?? 'baseline').replace(/[^a-z0-9-]/gi, '');
const NET = 'af-dk5-repro';
const PG = 'af-dk5-pg';
const PW = randomBytes(12).toString('hex');
const ts = new Date().toISOString().replace(/[:.]/g, '-');
const dir = path.join('audit', 'test-results', 'phase2', 'k5-investigation', `linux-repro-${LABEL}-${ts}`);
mkdirSync(dir, { recursive: true });

const docker = (args: string[], allowFail = false): string => {
  const r = spawnSync('docker', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0 && !allowFail) throw new Error(`docker ${args.join(' ')} → ${r.status}: ${r.stderr}`);
  return `${r.stdout ?? ''}${r.stderr ?? ''}`.trim();
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const START_DELAY_S =
  process.env.REPRO_START_DELAY_S === undefined ? null : Number(process.env.REPRO_START_DELAY_S);
const WORKER_IMAGE = process.env.REPRO_WORKER_IMAGE ?? 'aisleforge/worker:dev';
const GDB = process.env.REPRO_GDB === '1';
const workerCmd = GDB
  ? [
      'gdb',
      '-q',
      '-batch',
      '-ex',
      'handle SIGPIPE nostop noprint',
      '-ex',
      'run',
      '-ex',
      'bt 40',
      '-ex',
      'info sharedlibrary',
      '-ex',
      'thread apply all bt 15',
      '--args',
      'node',
      'worker.mjs',
    ]
  : [];
async function waitForBroker(k: string): Promise<number> {
  const t0 = Date.now();
  for (;;) {
    const r = spawnSync(
      'docker',
      [
        'exec',
        k,
        'sh',
        '-c',
        'KAFKA_HEAP_OPTS=-Xmx64m /opt/kafka/bin/kafka-broker-api-versions.sh --bootstrap-server ' +
          k +
          ':29092 >/dev/null 2>&1',
      ],
      { encoding: 'utf8' },
    );
    if (r.status === 0) return Date.now() - t0;
    if (Date.now() - t0 > 180_000) throw new Error('broker not ready in 180 s');
    await sleep(2000);
  }
}
const extraEnv = (process.env.REPRO_WORKER_ENV ?? '')
  .split(',')
  .filter(Boolean)
  .flatMap((kv) => ['-e', kv]);

const kafkaEnv = (host: string) =>
  [
    'KAFKA_NODE_ID=1',
    'KAFKA_PROCESS_ROLES=broker,controller',
    'KAFKA_LISTENERS=INTERNAL://:29092,CONTROLLER://:9093',
    `KAFKA_ADVERTISED_LISTENERS=INTERNAL://${host}:29092`,
    'KAFKA_LISTENER_SECURITY_PROTOCOL_MAP=INTERNAL:PLAINTEXT,CONTROLLER:PLAINTEXT',
    'KAFKA_INTER_BROKER_LISTENER_NAME=INTERNAL',
    'KAFKA_CONTROLLER_LISTENER_NAMES=CONTROLLER',
    `KAFKA_CONTROLLER_QUORUM_VOTERS=1@${host}:9093`,
    'KAFKA_AUTO_CREATE_TOPICS_ENABLE=false',
    'KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR=1',
    'KAFKA_TRANSACTION_STATE_LOG_REPLICATION_FACTOR=1',
    'KAFKA_TRANSACTION_STATE_LOG_MIN_ISR=1',
    'KAFKA_GROUP_INITIAL_REBALANCE_DELAY_MS=0',
    'KAFKA_HEAP_OPTS=-Xms384m -Xmx384m',
  ].flatMap((e) => ['-e', e]);

const cleanup = (names: string[]) => docker(['rm', '-f', ...names], true);

const results: Record<string, unknown>[] = [];
try {
  cleanup([PG]);
  docker(['network', 'create', NET], true);
  docker([
    'run',
    '-d',
    '--name',
    PG,
    '--network',
    NET,
    '-e',
    'POSTGRES_USER=aisleforge',
    '-e',
    `POSTGRES_PASSWORD=${PW}`,
    '-e',
    'POSTGRES_DB=aisleforge',
    '--memory',
    '384m',
    'postgres:18.1-alpine',
  ]);
  const dbUrl = `postgres://aisleforge:${PW}@${PG}:5432/aisleforge`;
  // init-db waits for PostgreSQL itself (bounded); no demo seed needed.
  docker([
    'run',
    '--rm',
    '--network',
    NET,
    '-e',
    `DATABASE_URL=${dbUrl}`,
    'aisleforge/api:dev',
    'node',
    'init-db.mjs',
  ]);

  for (let i = 1; i <= ITER; i++) {
    const k = `af-dk5-kafka-${i}`;
    const w = `af-dk5-worker-${i}`;
    cleanup([k, w]);
    const t0 = Date.now();
    docker([
      'run',
      '-d',
      '--name',
      k,
      '--network',
      NET,
      '--memory',
      '900m',
      ...kafkaEnv(k),
      'apache/kafka:4.1.1',
    ]);
    let brokerReadyMs: number | null = null;
    if (START_DELAY_S !== null) {
      brokerReadyMs = await waitForBroker(k);
      await sleep(START_DELAY_S * 1000);
    }
    docker([
      'run',
      '-d',
      '--name',
      w,
      ...(GDB ? ['--cap-add', 'SYS_PTRACE', '--security-opt', 'seccomp=unconfined'] : []),
      '--network',
      NET,
      '--memory',
      '384m',
      '-e',
      'NODE_ENV=production',
      '-e',
      `DATABASE_URL=${dbUrl}`,
      '-e',
      `KAFKA_BROKERS=${k}:29092`,
      '-e',
      `WORKER_ID=dk5-${i}`,
      ...extraEnv,
      WORKER_IMAGE,
      ...workerCmd,
    ]);
    // Supervise like Kubernetes/Compose: on every exit within the window, record it and start the same container
    // again (its log accumulates). A start-up failure (exit 1, broker not listening yet) is designed behaviour; the
    // kind crashes (exit 139) happened on such restarts while the broker was loading its coordinator state.
    type Exit = {
      exitCode: number;
      signal: number | null;
      oomKilled: boolean;
      livedMs: number;
      afterStartMs: number;
    };
    const exits: Exit[] = [];
    const deadline = Date.now() + OBSERVE_S * 1000;
    while (Date.now() < deadline) {
      await sleep(1000);
      const st = JSON.parse(docker(['inspect', w, '--format', '{{json .State}}'])) as {
        Running: boolean;
        ExitCode: number;
        OOMKilled: boolean;
        FinishedAt: string;
        StartedAt: string;
      };
      if (st.Running) continue;
      exits.push({
        exitCode: st.ExitCode,
        signal: st.ExitCode > 128 ? st.ExitCode - 128 : null,
        oomKilled: st.OOMKilled,
        livedMs: Date.parse(st.FinishedAt) - Date.parse(st.StartedAt),
        afterStartMs: Date.parse(st.FinishedAt) - t0,
      });
      if (Date.now() < deadline) docker(['start', w], true);
    }
    const state = JSON.parse(docker(['inspect', w, '--format', '{{json .State}}'])) as { Running: boolean };
    const workerLog = docker(['logs', w], true);
    writeFileSync(path.join(dir, `iter-${i}-worker.log`), workerLog);
    const gdbSignal = GDB ? (workerLog.match(/received signal (SIG\w+)/)?.[1] ?? null) : null;
    const nativeCrashes = exits.filter((e) => e.signal !== null && !e.oomKilled).length + (gdbSignal ? 1 : 0);
    if (nativeCrashes > 0) writeFileSync(path.join(dir, `iter-${i}-kafka.log`), docker(['logs', k], true));
    const row = {
      iteration: i,
      brokerReadyMs,
      exits,
      nativeCrashes,
      sigsegv: exits.filter((e) => e.exitCode === 139).length,
      startupFailures: exits.filter((e) => e.exitCode === 1).length,
      gdbSignal,
      runningAtEnd: state.Running,
      workerStartedLines: (workerLog.match(/"worker started"/g) ?? []).length,
      coordinatorLoadWarnings: (workerLog.match(/Coordinator load in progress/g) ?? []).length,
      observedMs: Date.now() - t0,
    };
    results.push(row);
    console.log(JSON.stringify(row));
    cleanup([k, w]);
  }
} finally {
  cleanup([PG]);
  docker(['network', 'rm', NET], true);
  const crashes = results.filter((r) => Number(r.nativeCrashes) > 0);
  const summary = {
    hypothesis: 'native worker crash when starting against a broker whose group coordinator is still loading',
    label: LABEL,
    iterations: results.length,
    observeSeconds: OBSERVE_S,
    workerExtraEnv: process.env.REPRO_WORKER_ENV ?? null,
    startDelayAfterBrokerReadyS: START_DELAY_S,
    workerImage: WORKER_IMAGE,
    gdb: GDB,
    iterationsWithNativeCrash: crashes.length,
    sigsegvTotal: results.reduce((n, r) => n + Number(r.sigsegv), 0),
    startupFailuresTotal: results.reduce((n, r) => n + Number(r.startupFailures), 0),
    images: {
      worker: docker(['image', 'inspect', WORKER_IMAGE, '--format', '{{.Id}}'], true),
      kafka: 'apache/kafka:4.1.1',
    },
    results,
    finishedAt: new Date().toISOString(),
  };
  writeFileSync(path.join(dir, 'result.json'), JSON.stringify(summary, null, 2));
  console.log(
    `iterations with a native crash: ${crashes.length}/${results.length}; SIGSEGV total ${summary.sigsegvTotal}; evidence ${dir}`,
  );
}
