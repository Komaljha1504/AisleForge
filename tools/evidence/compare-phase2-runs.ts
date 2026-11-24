/**
 * Puts the key Phase 2 measurements of several runs side by side, so variation between runs is visible.
 *
 *   pnpm tsx tools/evidence/compare-phase2-runs.ts <label>=<evidence root> [...]
 *
 * An evidence root is a directory containing `phase1/` and `phase2/` JSON files as written by tests/support/db.ts
 * (for example audit/test-results, or audit/test-results/phase2/runs/run3-<ts>). When a directory holds several runs
 * of a test (`<name>.json` plus `<name>.run-<ts>.json`), pass `<label>=<root>#<suffix>` to pick the `.run-<suffix>`
 * file instead of the first one. Labels should say whether the run was valid.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';

type Json = Record<string, unknown>;

function load(root: string, phase: string, name: string, suffix: string | undefined): Json | null {
  const dir = path.join(root, phase);
  if (!existsSync(dir)) return null;
  const file = suffix
    ? readdirSync(dir).find((f) => f.startsWith(`${name}.run-${suffix}`))
    : readdirSync(dir).find((f) => f === `${name}.json`);
  return file ? (JSON.parse(readFileSync(path.join(dir, file), 'utf8')) as Json) : null;
}

const get = (o: unknown, p: string): unknown =>
  p
    .split('.')
    .reduce<unknown>((acc, k) => (acc && typeof acc === 'object' ? (acc as Json)[k] : undefined), o);

const metrics: { label: string; phase: string; file: string; path: string }[] = [
  {
    label: 'T4 orders/s (1000×5, 20 hot SKUs)',
    phase: 'phase1',
    file: 'T4-sorted-lock-order',
    path: 'committedOrdersPerSec',
  },
  { label: 'T4 p50 ms', phase: 'phase1', file: 'T4-sorted-lock-order', path: 'latencyMs.p50' },
  { label: 'T4 p99 ms', phase: 'phase1', file: 'T4-sorted-lock-order', path: 'latencyMs.p99' },
  {
    label: 'K1 ack ms (40 msgs, 2 batches)',
    phase: 'phase2',
    file: 'K1-producer',
    path: 'roundtrip.ackMsForTwoBatches',
  },
  {
    label: 'K2 30 orders → tasks ms',
    phase: 'phase2',
    file: 'K2-order-workflow',
    path: 'placedToTasks.endToEndMs',
  },
  {
    label: 'K2 duplicates skipped',
    phase: 'phase2',
    file: 'K2-order-workflow',
    path: 'redelivery.duplicatesSkipped',
  },
  {
    label: 'K4 orders during 60 s outage',
    phase: 'phase2',
    file: 'K4-broker-outage-E2',
    path: 'duringOutage.ordersPlaced',
  },
  {
    label: 'K4 order errors during outage',
    phase: 'phase2',
    file: 'K4-broker-outage-E2',
    path: 'duringOutage.orderErrors',
  },
  {
    label: 'K4 place p99 ms during outage',
    phase: 'phase2',
    file: 'K4-broker-outage-E2',
    path: 'duringOutage.placeLatencyMs.p99',
  },
  {
    label: 'K4 rows marked while down',
    phase: 'phase2',
    file: 'K4-broker-outage-E2',
    path: 'duringOutage.rowsMarkedPublishedWhileDown',
  },
  {
    label: 'K4 broker reachable after ms',
    phase: 'phase2',
    file: 'K4-broker-outage-E2',
    path: 'recovery.brokerReachableAfterMs',
  },
  {
    label: 'K4 outbox drained after ms',
    phase: 'phase2',
    file: 'K4-broker-outage-E2',
    path: 'recovery.outboxDrainedAfterMs',
  },
  {
    label: 'K4 all tasks after ms',
    phase: 'phase2',
    file: 'K4-broker-outage-E2',
    path: 'recovery.allTasksCreatedAfterMs',
  },
  { label: 'K5 E3 orders', phase: 'phase2', file: 'K5-worker-crash-E3-E1', path: 'E3.ordersPlaced' },
  {
    label: 'K5 E3 duplicates skipped',
    phase: 'phase2',
    file: 'K5-worker-crash-E3-E1',
    path: 'E3.duplicateDeliveriesSkipped',
  },
  {
    label: 'K5 E3 drain after load ms',
    phase: 'phase2',
    file: 'K5-worker-crash-E3-E1',
    path: 'E3.drainAfterLoadStopMs',
  },
  {
    label: 'K5 E1 backlog at restart',
    phase: 'phase2',
    file: 'K5-worker-crash-E3-E1',
    path: 'E1.backlogAtRestart',
  },
  {
    label: 'K5 E1 drain ms (incl. start)',
    phase: 'phase2',
    file: 'K5-worker-crash-E3-E1',
    path: 'E1.drainMsIncludingWorkerStartup',
  },
  {
    label: 'K5 min free RAM MB',
    phase: 'phase2',
    file: 'K5-worker-crash-E3-E1',
    path: 'memorySamples.minFreePhysMB',
  },
];

const runs = process.argv.slice(2).map((a) => {
  const [label, spec] = a.split('=') as [string, string];
  const [root, suffix] = spec.split('#') as [string, string | undefined];
  return { label, root, suffix };
});
if (runs.length === 0) {
  console.error('usage: compare-phase2-runs.ts <label>=<root>[#suffix] ...');
  process.exit(2);
}

const header = ['metric', ...runs.map((r) => r.label)];
const rows = metrics.map((m) => [
  m.label,
  ...runs.map((r) => {
    const v = get(load(r.root, m.phase, m.file, r.suffix), m.path);
    return v === undefined || v === null ? '—' : String(v);
  }),
]);
console.log(`| ${header.join(' | ')} |`);
console.log(`| ${header.map(() => '---').join(' | ')} |`);
for (const row of rows) console.log(`| ${row.join(' | ')} |`);
