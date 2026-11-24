import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

export interface InvariantRow {
  invariant: string;
  description: string;
  status: 'PASS' | 'FAIL';
  violations: number;
  sample: unknown[];
}

export const defaultInvariantsFile = (): string =>
  process.env.INVARIANTS_FILE ??
  fileURLToPath(new URL('../../../audit/load-tests/invariants.sql', import.meta.url));

/**
 * Executes audit/load-tests/invariants.sql (single source of truth for invariants, also runnable via psql).
 * Uses its own short-lived connection so it never competes with an application pool under test.
 */
export async function checkInvariants(
  databaseUrl: string,
  opts: { outboxThreshold?: string; consumerThreshold?: string; file?: string } = {},
): Promise<InvariantRow[]> {
  const sql = await readFile(opts.file ?? defaultInvariantsFile(), 'utf8');
  const client = new pg.Client({ connectionString: databaseUrl, application_name: 'aisleforge:invariants' });
  await client.connect();
  try {
    if (opts.outboxThreshold) {
      await client.query(`SELECT set_config('aisleforge.outbox_threshold', $1, false)`, [
        opts.outboxThreshold,
      ]);
    }
    if (opts.consumerThreshold) {
      await client.query(`SELECT set_config('aisleforge.consumer_threshold', $1, false)`, [
        opts.consumerThreshold,
      ]);
    }
    const { rows } = await client.query<InvariantRow>(sql);
    return rows.map((r) => ({ ...r, violations: Number(r.violations) }));
  } finally {
    await client.end();
  }
}

export const failedInvariants = (rows: InvariantRow[], only?: string[]): InvariantRow[] =>
  rows.filter((r) => r.status === 'FAIL' && (!only || only.includes(r.invariant)));
