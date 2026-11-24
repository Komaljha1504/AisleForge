import { checkInvariants } from '../invariants';

// Usage: DATABASE_URL=... pnpm invariants [--threshold "2 minutes"] [--out file.json]
const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is required');
  process.exit(2);
}
const arg = (name: string): string | undefined => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};
const threshold = arg('--threshold');
const rows = await checkInvariants(url, threshold ? { outboxThreshold: threshold } : {});
const report = {
  checkedAt: new Date().toISOString(),
  pass: rows.every((r) => r.status === 'PASS'),
  invariants: rows,
};
const out = arg('--out');
if (out) {
  const { writeFile } = await import('node:fs/promises');
  await writeFile(out, JSON.stringify(report, null, 2));
}
console.log(JSON.stringify(report, null, 2));
process.exit(report.pass ? 0 : 1);
