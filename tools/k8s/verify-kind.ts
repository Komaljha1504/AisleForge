/**
 * Deploys AisleForge to the local kind cluster with Helm and VERIFIES it (a chart that only renders is not a
 * deployment). Every check runs against the live cluster; evidence → audit/test-results/phase9/kind-verify.run-*.json
 *
 *   pnpm tsx tools/k8s/verify-kind.ts            (cluster: kind create cluster --config deploy/kind/kind-config.yaml)
 */
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import fs, { mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const NS = 'aisleforge';
const CTX = 'kind-aisleforge';
const BASE = 'http://localhost:8090';
const bin = path.join(process.env.LOCALAPPDATA ?? '', 'aisleforge-tools', 'bin');
const run = (cmd: string, args: string[], input?: string) =>
  execFileSync(cmd, args, {
    encoding: 'utf8',
    input,
    stdio: ['pipe', 'pipe', 'pipe'],
    maxBuffer: 64 * 1024 * 1024,
  }).trim();
const kubectl = (...a: string[]) => run('kubectl', ['--context', CTX, '-n', NS, ...a]);
const helm = (...a: string[]) => run(path.join(bin, 'helm.exe'), ['--kube-context', CTX, '-n', NS, ...a]);
/** Non-blocking helm (the event loop must keep running, e.g. to send traffic during a rollout). */
const helmAsync = (...a: string[]) =>
  new Promise<string>((resolve, reject) => {
    const p = spawn(path.join(bin, 'helm.exe'), ['--kube-context', CTX, '-n', NS, ...a], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (out += d));
    p.on('close', (code) =>
      code === 0 ? resolve(out.trim()) : reject(new Error(`helm ${a[0]} exited ${code}: ${out}`)),
    );
  });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const steps: { step: string; ok: boolean; ms: number; detail?: unknown }[] = [];
async function step<T>(name: string, fn: () => Promise<T> | T): Promise<T> {
  const t0 = Date.now();
  try {
    const v = await fn();
    steps.push({ step: name, ok: true, ms: Date.now() - t0, ...(v !== undefined ? { detail: v } : {}) });
    console.log('PASS', name);
    return v;
  } catch (e) {
    steps.push({ step: name, ok: false, ms: Date.now() - t0, detail: String(e).slice(0, 2000) });
    console.log('FAIL', name, String(e).slice(0, 500));
    throw e;
  }
}
const hex = (n: number) => randomBytes(n).toString('hex');
const secrets = { pg: hex(16), jwt: hex(32), seed: `Demo-${hex(8)}` };
let pf: ChildProcess | null = null;
const portForward = async () => {
  pf?.kill();
  pf = spawn('kubectl', ['--context', CTX, '-n', NS, 'port-forward', 'svc/af-web', '8090:8080'], {
    stdio: 'ignore',
  });
  for (let i = 0; i < 40; i++) {
    try {
      if ((await fetch(`${BASE}/healthz`)).ok) return;
    } catch {
      /* not yet */
    }
    await sleep(500);
  }
  throw new Error('port-forward not ready');
};
async function api(
  method: string,
  p: string,
  token?: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  const r = await fetch(BASE + p, {
    method,
    headers: {
      Origin: BASE,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await r.text();
  return { status: r.status, json: text ? (JSON.parse(text) as any) : null, headers: r.headers }; // eslint-disable-line @typescript-eslint/no-explicit-any
}
const login = async (email: string) => {
  const r = await api('POST', '/api/v1/auth/login', undefined, { email, password: secrets.seed });
  if (r.status !== 200) throw new Error(`login ${email} → ${r.status}`);
  return r.json.accessToken as string;
};
const psql = (sql: string, db = 'aisleforge') =>
  kubectl(
    'exec',
    '-i',
    'af-postgres-0',
    '--',
    'psql',
    '-U',
    'aisleforge',
    '-d',
    db,
    '-At',
    '-v',
    'ON_ERROR_STOP=1',
    '-c',
    sql,
  );
async function orderToTask(): Promise<{ orderId: string; taskMs: number }> {
  const c = await login('customer@demo.aisleforge.test');
  const r = await api(
    'POST',
    '/api/v1/orders',
    c,
    { storeId: 1, lines: [{ sku: 'PASTA-500', qty: 1 }] },
    { 'Idempotency-Key': `k8s-${randomUUID()}` },
  );
  if (r.status !== 201) throw new Error(`order → ${r.status}`);
  const t0 = Date.now();
  for (let i = 0; i < 120; i++) {
    if (Number(psql(`SELECT count(*) FROM pick_tasks WHERE order_id = '${r.json.orderId}'`)) === 1)
      return { orderId: r.json.orderId, taskMs: Date.now() - t0 };
    await sleep(500);
  }
  throw new Error('no pick task within 60 s');
}

interface PodJson {
  metadata: { name: string };
  status: {
    initContainerStatuses?: {
      name: string;
      restartCount: number;
      lastState?: { terminated?: { exitCode: number; reason: string } };
    }[];
    containerStatuses?: {
      name: string;
      restartCount: number;
      lastState?: { terminated?: { exitCode: number; reason: string } };
    }[];
  };
}
/** Exit code + reason of every restarted container (139 = SIGSEGV, see D-K5), captured before later steps replace pods. */
const lastTerminations = () =>
  (JSON.parse(kubectl('get', 'pods', '-o', 'json')) as { items: PodJson[] }).items.flatMap((p) =>
    [...(p.status.initContainerStatuses ?? []), ...(p.status.containerStatuses ?? [])]
      .filter((c) => c.restartCount > 0)
      .map((c) => ({
        pod: p.metadata.name,
        container: c.name,
        restarts: c.restartCount,
        last: c.lastState?.terminated ?? null,
      })),
  );

let exitCode = 0;
try {
  await step(
    'images present in the kind node (local builds loaded, public images pulled by the node)',
    () => {
      // `kind load` streams a whole image through Windows pipes (~8–10 min per image here). Instead, locally built
      // images are saved to a file, copied into the node and imported with ctr (~25 s per image), and only when the
      // node's digest differs from the local one, so a run can never silently test a stale image. Public images are
      // pulled by the node directly (in parallel) and skipped if present.
      const NODE = 'aisleforge-control-plane';
      const present = run('docker', ['exec', NODE, 'crictl', 'images']);
      const has = (img: string) => {
        const [repo, tag] = img.split(':');
        return present
          .split('\n')
          .some(
            (l) => l.includes(`${repo!.includes('/') ? repo : `library/${repo}`} `) && l.includes(` ${tag} `),
          );
      };
      const nodeImages = run('docker', ['exec', NODE, 'ctr', '-n', 'k8s.io', 'images', 'ls']);
      const nodeDigest = (img: string) =>
        nodeImages
          .split('\n')
          .find((l) => l.startsWith(`docker.io/${img} `))
          ?.trim()
          .split(/\s+/)[2] ?? null;
      const digests: Record<string, { local: string; nodeBefore: string | null; imported: boolean }> = {};
      for (const img of ['aisleforge/api:dev', 'aisleforge/worker:dev', 'aisleforge/web:dev']) {
        const localId = run('docker', ['image', 'inspect', img, '--format', '{{.Id}}']).trim();
        const before = nodeDigest(img);
        const stale = before !== localId;
        if (stale) {
          const file = path.join(os.tmpdir(), `af-kind-${img.replace(/[/:]/g, '-')}.tar`);
          run('docker', ['save', '-o', file, img]);
          run('docker', ['cp', file, `${NODE}:/af-import.tar`]);
          run('docker', [
            'exec',
            NODE,
            'ctr',
            '-n',
            'k8s.io',
            'images',
            'import',
            '--all-platforms',
            '/af-import.tar',
          ]);
          run('docker', ['exec', NODE, 'rm', '-f', '/af-import.tar']);
          fs.rmSync(file, { force: true });
        }
        digests[img] = { local: localId, nodeBefore: before, imported: stale };
      }
      const pub = ['postgres:18.1-alpine', 'apache/kafka:4.1.1', 'redis:7.4.1-alpine'].filter((i) => !has(i));
      const pulls = pub.map((img) =>
        spawnSync(
          'docker',
          [
            'exec',
            'aisleforge-control-plane',
            'crictl',
            'pull',
            `docker.io/${img.includes('/') ? img : `library/${img}`}`,
          ],
          { encoding: 'utf8' },
        ),
      );
      const failed = pulls.filter((p) => p.status !== 0).map((p) => p.stderr);
      if (failed.length) throw new Error(failed.join('\n'));
      return { localImages: digests, pulled: pub };
    },
  );
  await step('helm install (local values, in-cluster dependencies with PVCs, generated secrets)', () => {
    // Secrets are generated per run and PostgreSQL only reads its password at initdb, so a namespace left over from an
    // earlier run (PVC initialized with another password, or a release stuck in pending-install after an interrupted
    // run) cannot be reused. The namespace belongs to this local, throwaway kind cluster: start from a clean one.
    const existed =
      spawnSync('kubectl', ['--context', CTX, 'get', 'namespace', NS], { encoding: 'utf8' }).status === 0;
    if (existed)
      run('kubectl', ['--context', CTX, 'delete', 'namespace', NS, '--wait=true', '--timeout=300s']);
    run('kubectl', ['--context', CTX, 'create', 'namespace', NS]);
    const dbUrl = `postgres://aisleforge:${secrets.pg}@af-postgres:5432/aisleforge`;
    return helm(
      'upgrade',
      '--install',
      'af',
      'deploy/helm/aisleforge',
      '-f',
      'deploy/helm/aisleforge/values-local.yaml',
      '--set',
      `secrets.values.POSTGRES_PASSWORD=${secrets.pg}`,
      '--set',
      `secrets.values.DATABASE_URL=${dbUrl}`,
      '--set',
      `secrets.values.JWT_SECRET=${secrets.jwt}`,
      '--set',
      `secrets.values.SEED_PASSWORD=${secrets.seed}`,
      '--set',
      'secrets.values.REDIS_URL=redis://af-redis:6379',
      '--wait',
      '--timeout',
      '15m',
    )
      .split('\n')
      .slice(0, 6)
      .join(' | ');
  });
  await step('all workloads rolled out and ready (startup/readiness probes passed)', () => ({
    pods: kubectl(
      'get',
      'pods',
      '-o',
      'custom-columns=NAME:.metadata.name,READY:.status.containerStatuses[*].ready,RESTARTS:.status.containerStatuses[*].restartCount,PHASE:.status.phase',
    ),
    // Exit code + reason of every restarted container (139 = SIGSEGV, see D-K5), captured before later steps replace pods.
    lastTerminations: lastTerminations(),
  }));
  await portForward();
  await step(
    'end-to-end through the web Service: order → reserve → outbox → Kafka → worker → pick task',
    () => orderToTask(),
  );
  await step('picker claims and completes via /sync; order reaches picked', async () => {
    const picker = await login('picker@demo.aisleforge.test');
    const avail = await api('GET', '/api/v1/pick-tasks?scope=available&limit=200', picker);
    const t = avail.json.tasks[0];
    const claimed = await api('POST', `/api/v1/pick-tasks/${t.id}/claim`, picker);
    const ops = [
      ...claimed.json.task.lines.map((l: { orderLineId: string; sku: string; qty: number }, i: number) => ({
        opId: randomUUID(),
        seq: i + 1,
        type: 'pick.confirm',
        taskId: t.id,
        payload: { orderLineId: l.orderLineId, scannedSku: l.sku, pickedQty: l.qty },
      })),
      {
        opId: randomUUID(),
        seq: claimed.json.task.lines.length + 1,
        type: 'task.complete',
        taskId: t.id,
        payload: {},
      },
    ];
    const s = await api('POST', '/api/v1/sync', picker, { deviceId: randomUUID(), ops });
    const statuses = s.json.results.map((x: { status: string }) => x.status);
    if (statuses.some((x: string) => x !== 'applied')) throw new Error(statuses.join(','));
    const order = psql(`SELECT status FROM orders WHERE id = '${t.orderId}'`);
    if (order !== 'picked') throw new Error(`order ${order}`);
    return { syncResults: statuses, order };
  });
  await step('worker pod deleted → replacement pod resumes Kafka consumption', async () => {
    const before = kubectl(
      'get',
      'pods',
      '-l',
      'app.kubernetes.io/component=worker',
      '-o',
      'jsonpath={.items[0].metadata.name}',
    );
    kubectl('delete', 'pod', before, '--wait=false');
    kubectl('rollout', 'status', 'deploy/af-worker', '--timeout=300s');
    const after = kubectl(
      'get',
      'pods',
      '-l',
      'app.kubernetes.io/component=worker',
      '--field-selector=status.phase=Running',
      '-o',
      'jsonpath={.items[*].metadata.name}',
    );
    const r = await orderToTask();
    return { deleted: before, replacement: after, taskCreatedAfterMs: r.taskMs };
  });
  await step(
    'Redis interruption (scaled to 0): login and catalog still served; restored afterwards',
    async () => {
      kubectl('scale', 'deploy/af-redis', '--replicas=0');
      kubectl('wait', '--for=delete', 'pod', '-l', 'app.kubernetes.io/component=redis', '--timeout=120s');
      const t0 = Date.now();
      const c = await login('customer@demo.aisleforge.test');
      const cat = await api('GET', '/api/v1/stores/1/catalog', c);
      const ms = Date.now() - t0;
      kubectl('scale', 'deploy/af-redis', '--replicas=1');
      kubectl('rollout', 'status', 'deploy/af-redis', '--timeout=120s');
      if (cat.status !== 200) throw new Error(`catalog ${cat.status}`);
      return { loginAndCatalogMs: ms, xCache: cat.headers.get('x-cache') };
    },
  );
  await step(
    'rolling update under traffic (helm upgrade changes config → new pods), zero failed requests',
    async () => {
      // helm must run ASYNCHRONOUSLY: the first version used the synchronous helper, which blocked the event loop, so the
      // "traffic" loop sent a single request (evidence run 2026-11-22T17-45-18). A minimum request count now guards it.
      const token = await login('customer@demo.aisleforge.test');
      let stop = false;
      const results = {
        ok: 0,
        failed: 0,
        statuses: {} as Record<string, number>,
        byPath: {} as Record<string, number>,
        failures: [] as string[],
      };
      const loop = (async () => {
        let i = 0;
        while (!stop) {
          const p = i++ % 2 === 0 ? '/health/ready' : '/api/v1/stores/1/catalog';
          try {
            const r = await fetch(
              `${BASE}${p}`,
              p.startsWith('/api') ? { headers: { authorization: `Bearer ${token}` } } : {},
            );
            const body = await r.text();
            results.statuses[r.status] = (results.statuses[r.status] ?? 0) + 1;
            results.byPath[p] = (results.byPath[p] ?? 0) + 1;
            if (r.ok) results.ok++;
            else {
              results.failed++;
              // The body distinguishes a draining pod ({"status":"draining"}) from a failed dependency check
              // ({"status":"not_ready"}) or an nginx error page (Phase 10: 1 × 503 on /health/ready, cause unknown).
              results.failures.push(`${new Date().toISOString()} ${p} ${r.status} ${body.slice(0, 160)}`);
            }
          } catch (e) {
            results.failed++;
            results.failures.push(`${new Date().toISOString()} ${p} ${String(e).slice(0, 120)}`);
          }
          await sleep(100);
        }
      })();
      const t0 = Date.now();
      await helmAsync(
        'upgrade',
        'af',
        'deploy/helm/aisleforge',
        '--reuse-values',
        '--set',
        'config.LOG_LEVEL=debug',
        '--wait',
        '--timeout',
        '10m',
      );
      const rolloutMs = Date.now() - t0;
      stop = true;
      await loop;
      const rev = helm('history', 'af', '--max', '1', '-o', 'json');
      const pods = kubectl(
        'get',
        'pods',
        '-l',
        'app.kubernetes.io/component=api',
        '-o',
        'jsonpath={.items[*].metadata.name}',
      );
      if (results.failed > 0) throw new Error(`failed requests during rollout: ${JSON.stringify(results)}`);
      if (results.ok < 50)
        throw new Error(`too few requests during the rollout to prove anything: ${JSON.stringify(results)}`);
      return { ...results, rolloutMs, revision: JSON.parse(rev)[0].revision, apiPodsAfter: pods };
    },
  );
  await step('rollback to the previous revision restores the previous configuration', async () => {
    helm('rollback', 'af', '--wait', '--timeout', '10m');
    const level = kubectl('get', 'configmap', 'af-config', '-o', 'jsonpath={.data.LOG_LEVEL}');
    if (level !== 'info') throw new Error(`LOG_LEVEL after rollback: ${level}`);
    await portForward();
    return {
      logLevel: level,
      history: JSON.parse(helm('history', 'af', '-o', 'json')).map(
        (h: { revision: number; status: string; description: string }) =>
          `${h.revision}:${h.status}:${h.description}`,
      ),
    };
  });
  await step('PostgreSQL pod deleted → data persists on its PVC', async () => {
    const before = Number(psql('SELECT count(*) FROM orders'));
    kubectl('delete', 'pod', 'af-postgres-0');
    kubectl('wait', '--for=condition=ready', 'pod/af-postgres-0', '--timeout=300s');
    await sleep(3000);
    const after = Number(psql('SELECT count(*) FROM orders'));
    if (after !== before) throw new Error(`orders ${before} → ${after}`);
    await portForward();
    return { ordersBefore: before, ordersAfter: after };
  });
  await step('in-cluster backup (pg_dump) and restore into a separate database', () => {
    const dump = spawnSync(
      'kubectl',
      [
        '--context',
        CTX,
        '-n',
        NS,
        'exec',
        'af-postgres-0',
        '--',
        'pg_dump',
        '-U',
        'aisleforge',
        '-d',
        'aisleforge',
        '-Fc',
        '--no-owner',
      ],
      { maxBuffer: 256 * 1024 * 1024 },
    ).stdout;
    kubectl(
      'exec',
      'af-postgres-0',
      '--',
      'sh',
      '-c',
      'dropdb -U aisleforge --if-exists restore_check && createdb -U aisleforge restore_check',
    );
    const restore = spawnSync(
      'kubectl',
      [
        '--context',
        CTX,
        '-n',
        NS,
        'exec',
        '-i',
        'af-postgres-0',
        '--',
        'pg_restore',
        '-U',
        'aisleforge',
        '-d',
        'restore_check',
        '--no-owner',
        '--exit-on-error',
      ],
      { input: dump },
    );
    if (restore.status !== 0) throw new Error(String(restore.stderr));
    const a = psql('SELECT count(*) FROM orders') + '/' + psql('SELECT count(*) FROM inventory_ledger');
    const b =
      psql('SELECT count(*) FROM orders', 'restore_check') +
      '/' +
      psql('SELECT count(*) FROM inventory_ledger', 'restore_check');
    kubectl('exec', 'af-postgres-0', '--', 'dropdb', '-U', 'aisleforge', 'restore_check');
    if (a !== b) throw new Error(`live ${a} vs restored ${b}`);
    return { dumpBytes: dump.length, liveOrdersLedger: a, restoredOrdersLedger: b };
  });
  await step('final pod state (restarts, readiness)', () =>
    kubectl(
      'get',
      'pods',
      '-o',
      'custom-columns=NAME:.metadata.name,READY:.status.containerStatuses[*].ready,RESTARTS:.status.containerStatuses[*].restartCount',
    ),
  );
} catch {
  exitCode = 1;
} finally {
  (pf as ChildProcess | null)?.kill(); // assigned inside portForward(); TS cannot see that from here
  const dir = path.resolve('audit/test-results/phase9');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `kind-verify.run-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  writeFileSync(
    file,
    JSON.stringify(
      { recordedAt: new Date().toISOString(), cluster: CTX, pass: exitCode === 0, steps },
      null,
      2,
    ),
  );
  console.log(`evidence: ${file}`);
}
process.exitCode = exitCode;
