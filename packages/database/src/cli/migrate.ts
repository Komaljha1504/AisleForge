import { createLogger } from '@aisleforge/shared';
import { runMigrations } from '../migrate';

const logger = createLogger('migrate');
const url = process.env.DATABASE_URL;
if (!url) {
  logger.fatal('DATABASE_URL is required');
  process.exit(2);
}
try {
  const r = await runMigrations(url, undefined, logger);
  logger.info({ applied: r.applied, alreadyApplied: r.alreadyApplied.length }, 'migrations complete');
} catch (err) {
  logger.fatal({ err }, 'migration failed');
  process.exit(1);
}
