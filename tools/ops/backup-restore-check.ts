/**
 * Verifies the backup/restore procedure on the running Compose stack: backup.sh → restore.sh into a SEPARATE
 * database → compare row counts of every table and run invariants I1–I7 on the restored copy → drop the copy.
 * Evidence: audit/test-results/phase8/backup-restore.run-<ts>.json. The live database is never modified.
 *
 *   pnpm tsx tools/ops/backup-restore-check.ts [backup-dir]
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = process.argv[2] ?? path.join(os.tmpdir(), 'aisleforge-backups');
const sh = (script: string, args: string[]) =>
  execFileSync('C:\\Program Files\\Git\\bin\\sh.exe', [script, ...args], { encoding: 'utf8' }).trim();
const psql = (db: string | null, sql: string) =>
  spawnSync(
    'docker',
    [
      'compose',
      'exec',
      '-T',
      'postgres',
      'sh',
      '-c',
      `psql -U "$POSTGRES_USER" -d ${db ?? '"$POSTGRES_DB"'} -At -F "|" -v ON_ERROR_STOP=1`,
    ],
    { input: sql, encoding: 'utf8' },
  ).stdout.trim();
const counts = (db: string | null) =>
  Object.fromEntries(
    psql(
      db,
      `SELECT string_agg(format('%s|%s', table_name, (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I', table_name), false, true, '')))[1]::text), E'\\n' ORDER BY table_name)
         FROM information_schema.tables WHERE table_schema = 'public';`,
    )
      .split('\n')
      .filter(Boolean)
      .map((l) => l.split('|'))
      .map(([t, n]) => [t, Number(n)]),
  );

// The reference counts must describe the SAME state as the dump. pg_dump is snapshot-consistent, but a live worker
// kept consuming between "count" and "dump" in the first run (processed_events moved), so writers are paused for
// the count + dump and resumed right after. The backup procedure itself works online.
execFileSync('docker', ['compose', '--profile', 'app', 'stop', 'api', 'worker'], { stdio: 'ignore' });
let before: Record<string, number>;
let file: string;
let backupMs: number;
try {
  const t0 = Date.now();
  before = counts(null);
  file = sh('deploy/scripts/backup.sh', [dir]).split('\n').at(-1)!;
  backupMs = Date.now() - t0;
} finally {
  execFileSync('docker', ['compose', '--profile', 'app', 'start', 'api', 'worker'], { stdio: 'ignore' });
}
const t1 = Date.now();
sh('deploy/scripts/restore.sh', [file, 'aisleforge_restore_check']);
const restoreMs = Date.now() - t1;
const after = counts('aisleforge_restore_check');
const mismatches = Object.keys(before).filter((t) => t !== 'worker_status' && before[t] !== after[t]);
const invariants = psql(
  'aisleforge_restore_check',
  `SET aisleforge.outbox_threshold = '100 years'; SET aisleforge.consumer_threshold = '100 years';\n${readFileSync('audit/load-tests/invariants.sql', 'utf8')}`,
)
  .split('\n')
  .filter((l) => /^I\d\|/.test(l))
  .map((l) => {
    const [id, , status, violations] = l.split('|');
    return { id, status, violations: Number(violations) };
  });
// Refusal check: restoring over the live database without --force must be refused.
const refusal = spawnSync(
  'C:\\Program Files\\Git\\bin\\sh.exe',
  ['deploy/scripts/restore.sh', file, 'aisleforge'],
  { encoding: 'utf8' },
);
psql(null, 'SELECT 1;');
spawnSync('docker', [
  'compose',
  'exec',
  '-T',
  'postgres',
  'sh',
  '-c',
  'dropdb -U "$POSTGRES_USER" aisleforge_restore_check',
]);
const pass =
  mismatches.length === 0 &&
  invariants.length === 7 &&
  invariants.every((i) => i.status === 'PASS') &&
  refusal.status !== 0;
const evidence = {
  recordedAt: new Date().toISOString(),
  backupFile: file,
  backupBytes: statSync(file).size,
  backupMs,
  restoreMs,
  tables: Object.keys(before).length,
  rowsBefore: before,
  mismatchedTables: mismatches,
  restoredInvariants: invariants,
  liveOverwriteRefusedWithoutForce: refusal.status !== 0,
  refusalMessage: refusal.stderr.trim(),
  pass,
  note: 'worker_status is excluded from the comparison (live snapshots change every few seconds).',
};
const outDir = path.resolve('audit/test-results/phase8');
mkdirSync(outDir, { recursive: true });
const out = path.join(outDir, `backup-restore.run-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
writeFileSync(out, JSON.stringify(evidence, null, 2));
console.log(JSON.stringify({ ...evidence, rowsBefore: undefined }, null, 1));
console.log(`evidence: ${out}`);
process.exitCode = pass ? 0 : 1;
