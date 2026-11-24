import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { sha256Hex, type Logger } from '@aisleforge/shared';

/** Arbitrary constant; session advisory lock so concurrent deployers/pods cannot migrate simultaneously. */
const MIGRATION_LOCK_KEY = 7_411_002;

export const defaultMigrationsDir = (): string =>
  process.env.MIGRATIONS_DIR ?? fileURLToPath(new URL('../../../migrations/', import.meta.url));

export interface MigrationResult {
  applied: string[];
  alreadyApplied: string[];
}

/**
 * Forward-only SQL migrations. Each file runs in its own transaction and is recorded with its checksum.
 * Editing an already-applied migration is an error (checksum mismatch) — write a new migration instead.
 */
export async function runMigrations(
  databaseUrl: string,
  dir = defaultMigrationsDir(),
  logger?: Logger,
): Promise<MigrationResult> {
  const client = new pg.Client({ connectionString: databaseUrl, application_name: 'aisleforge:migrate' });
  await client.connect();
  const result: MigrationResult = { applied: [], alreadyApplied: [] };
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
    const done = new Map<string, string>(
      (
        await client.query<{ name: string; checksum: string }>('SELECT name, checksum FROM schema_migrations')
      ).rows.map((r) => [r.name, r.checksum]),
    );
    const files = (await readdir(dir)).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();
    for (const file of files) {
      const sql = (await readFile(path.join(dir, file), 'utf8')).replace(/\r\n/g, '\n');
      const checksum = sha256Hex(sql);
      const prior = done.get(file);
      if (prior) {
        if (prior !== checksum)
          throw new Error(`Migration ${file} was modified after being applied (checksum mismatch)`);
        result.alreadyApplied.push(file);
        continue;
      }
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations(name, checksum) VALUES ($1, $2)', [file, checksum]);
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${(e as Error).message}`, { cause: e });
      }
      result.applied.push(file);
      logger?.info({ migration: file }, 'migration applied');
    }
    return result;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]).catch(() => undefined);
    await client.end();
  }
}
