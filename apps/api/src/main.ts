import { createPoolSet } from '@aisleforge/database';
import { createLogger } from '@aisleforge/shared';
import { createApp, type AppPools, type AppState } from './app';
import { loadApiConfig } from './config';

const logger = createLogger('aisleforge-api', { role: 'api' });
let cfg;
try {
  cfg = loadApiConfig();
} catch (err) {
  logger.fatal({ err }, 'refusing to start: invalid configuration');
  process.exit(2);
}
const pools = createPoolSet(cfg, logger, ['orders', 'sync']) as AppPools;
const state: AppState = { shuttingDown: false };
const app = createApp({ config: cfg, pools, logger, state });
const server = app.listen(cfg.PORT, () => logger.info({ port: cfg.PORT }, 'api listening'));
server.keepAliveTimeout = 65_000; // longer than typical proxy idle timeouts
server.headersTimeout = 66_000;
server.requestTimeout = 30_000;

/**
 * Graceful shutdown: fail readiness first (so load balancers stop routing), then stop accepting connections, let
 * in-flight requests finish, close pools. A hard deadline prevents hanging past the orchestrator's grace period.
 */
async function shutdown(signal: string): Promise<void> {
  if (state.shuttingDown) return;
  state.shuttingDown = true;
  logger.info({ signal }, 'shutdown started');
  const deadline = setTimeout(() => {
    logger.error('shutdown deadline exceeded; exiting');
    process.exit(1);
  }, 20_000);
  deadline.unref();
  await new Promise((r) => setTimeout(r, Number(process.env.SHUTDOWN_DRAIN_DELAY_MS ?? 5000)));
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await Promise.allSettled([pools.orders.end(), pools.sync.end(), app.aisleforge?.redis?.close()]);
  logger.info('shutdown complete');
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('unhandledRejection', (err) => logger.error({ err }, 'unhandled rejection'));
