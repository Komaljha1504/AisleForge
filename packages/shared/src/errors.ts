/**
 * Typed application errors. Every error that crosses a module boundary is an AppError with a stable
 * machine-readable `code`; HTTP status is derived from it in exactly one place (the API error handler).
 */
export const ErrorCodes = {
  VALIDATION_FAILED: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  INSUFFICIENT_STOCK: 409,
  INVALID_STATE_TRANSITION: 409,
  CONFLICT: 409,
  IDEMPOTENCY_KEY_REUSED: 422,
  UNKNOWN_SKU: 422,
  ADJUSTMENT_BELOW_RESERVED: 409,
  PAYLOAD_TOO_LARGE: 413,
  RATE_LIMITED: 429,
  DB_POOL_EXHAUSTED: 503,
  DB_TIMEOUT: 503,
  DEPENDENCY_UNAVAILABLE: 503,
  INTERNAL: 500,
} as const;

export type ErrorCode = keyof typeof ErrorCodes;

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly httpStatus: number;
  readonly details: Record<string, unknown> | undefined;
  /** Seconds a client should wait before retrying (sets Retry-After). */
  readonly retryAfterSeconds: number | undefined;

  constructor(
    code: ErrorCode,
    message: string,
    opts: { details?: Record<string, unknown>; cause?: unknown; retryAfterSeconds?: number } = {},
  ) {
    super(message, { cause: opts.cause });
    this.name = 'AppError';
    this.code = code;
    this.httpStatus = ErrorCodes[code];
    this.details = opts.details;
    this.retryAfterSeconds = opts.retryAfterSeconds;
  }
}

export const isAppError = (e: unknown): e is AppError => e instanceof AppError;

/** Narrow an unknown thrown value to something with a Postgres SQLSTATE code. */
export function pgErrorCode(e: unknown): string | undefined {
  if (typeof e === 'object' && e !== null && 'code' in e) {
    const code = (e as { code: unknown }).code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}
