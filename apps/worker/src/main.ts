import { createLogger } from '@aisleforge/shared';
import { loadWorkerConfig, type WorkerConfig } from './config';
import { Worker } from './worker';

// Synchronous logging: every line is on stdout before the next statement runs, so a crash or an 'exit' handler
// cannot lose the last lines (pino's default async destination would — found by the K5 negative control).
const logger = createLogger('aisleforge-worker', { role: 'worker', sync: true });

// Registered FIRST, so every JS-level way out of the process leaves a structured line. A worker that disappears
// WITHOUT a 'process exiting' line was terminated from outside the JS runtime (external kill, native crash, OS);
// see docs/reports/K5_WORKER_DISAPPEARANCE_INVESTIGATION.md.
process.on('exit', (code) => {
  logger.info({ code, uptimeSeconds: Math.round(process.uptime()) }, 'process exiting');
});
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'uncaught exception; exiting');
  process.exit(1);
});
process.on('unhandledRejection', (err) => logger.error({ err }, 'unhandled rejection'));

let cfg: WorkerConfig;
try {
  cfg = loadWorkerConfig();
} catch (err) {
  logger.fatal({ err }, 'refusing to start: invalid configuration');
  process.exit(2);
}

const worker = new Worker(cfg, logger);

async function shutdown(signal: string): Promise<void> {
  if (worker.shuttingDown) return;
  logger.info({ signal }, 'shutdown started');
  const deadline = setTimeout(() => {
    logger.error(
      'shutdown deadline exceeded; exiting (uncommitted messages will be redelivered and deduplicated)',
    );
    process.exit(1);
  }, cfg.SHUTDOWN_TIMEOUT_MS);
  deadline.unref();
  await worker.stop();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

worker.start().catch(async (err: unknown) => {
  logger.fatal({ err }, 'worker failed to start');
  // Release the Kafka clients created so far BEFORE exiting. Calling process.exit with live librdkafka handles
  // (e.g. the admin client after "Broker transport failure" while the broker starts) crashed the process during
  // teardown with SIGSEGV (exit 139 after logging code 1) in 2 of 6 D-K5 reproduction runs. Bounded.
  const deadline = setTimeout(() => process.exit(1), 10_000);
  deadline.unref();
  await worker.stop().catch(() => undefined);
  process.exit(1);
});
