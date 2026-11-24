import { pino, type DestinationStream, type Logger, type LoggerOptions } from 'pino';

/**
 * Structured JSON logging. Redaction is configured here, once, so no call site can forget it.
 * Paths cover common request/credential shapes; values are replaced, keys are kept for debuggability.
 */
export const REDACT_PATHS = [
  'password',
  '*.password',
  'passwordHash',
  '*.passwordHash',
  'token',
  '*.token',
  'accessToken',
  '*.accessToken',
  'refreshToken',
  '*.refreshToken',
  'secret',
  '*.secret',
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  'headers.authorization',
  'headers.cookie',
];

/**
 * `sync: true` writes each line to stdout synchronously. pino's default stdout destination is asynchronous and
 * flushes in its own exit hook, so lines written later (e.g. in a process 'exit' handler) or just before an abrupt
 * termination can be lost. Used by the worker, whose log volume is low and whose last lines matter (K5 finding).
 */
export function createLogger(
  service: string,
  opts: { level?: string; role?: string; destination?: DestinationStream; sync?: boolean } = {},
): Logger {
  const options: LoggerOptions = {
    level: opts.level ?? process.env.LOG_LEVEL ?? 'info',
    base: { service, role: opts.role ?? service },
    timestamp: pino.stdTimeFunctions.isoTime,
    messageKey: 'message',
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
    formatters: { level: (label) => ({ level: label }) },
  };
  if (opts.destination) return pino(options, opts.destination);
  if (opts.sync) return pino(options, pino.destination({ dest: 1, sync: true }));
  return pino(options);
}

export type { Logger };
