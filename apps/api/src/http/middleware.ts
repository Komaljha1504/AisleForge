import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { ZodType } from 'zod';
import { AppError, newId, type Logger } from '@aisleforge/shared';
import {
  requirePermission,
  verifyAccessToken,
  type Permission,
  type Principal,
  type TokenConfig,
} from '@aisleforge/domain';
import './types';

const TRACE_ID = /^[A-Za-z0-9._:-]{8,128}$/;

/** Request id + correlation id (accepted from the caller only if well-formed), child logger, access log. */
export function requestContext(logger: Logger): RequestHandler {
  return (req, res, next) => {
    const incomingReq = req.get('x-request-id');
    const incomingCorr = req.get('x-correlation-id');
    req.id = incomingReq && TRACE_ID.test(incomingReq) ? incomingReq : newId();
    req.correlationId = incomingCorr && TRACE_ID.test(incomingCorr) ? incomingCorr : req.id;
    req.log = logger.child({ request_id: req.id, correlation_id: req.correlationId });
    res.setHeader('X-Request-Id', req.id);
    res.setHeader('X-Correlation-Id', req.correlationId);
    const start = process.hrtime.bigint();
    res.on('finish', () => {
      const ms = Number(process.hrtime.bigint() - start) / 1e6;
      req.log.info(
        {
          method: req.method,
          path: req.path, // path only: query strings may contain identifiers
          status: res.statusCode,
          duration_ms: Math.round(ms * 10) / 10,
          employee_id: req.principal?.role === 'customer' ? undefined : req.principal?.userId,
          customer_id: req.principal?.role === 'customer' ? req.principal.userId : undefined,
          store_id: req.principal?.storeId ?? undefined,
        },
        'request completed',
      );
    });
    next();
  };
}

/** API-appropriate security headers (no HTML is served by the API). */
export const securityHeaders: RequestHandler = (_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
  res.setHeader('Cross-Origin-Resource-Policy', 'same-site');
  res.setHeader('Cache-Control', 'no-store');
  next();
};

/** Explicit CORS allow-list. Credentials are only ever allowed for allow-listed origins; never `*`. */
export function cors(allowed: string[]): RequestHandler {
  const set = new Set(allowed);
  return (req, res, next) => {
    const origin = req.get('origin');
    if (origin) res.vary('Origin');
    const ok = origin !== undefined && set.has(origin);
    if (ok) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader(
        'Access-Control-Expose-Headers',
        'X-Request-Id, X-Correlation-Id, Retry-After, Idempotent-Replayed, Location',
      );
    }
    if (req.method === 'OPTIONS' && origin) {
      if (!ok) {
        res.status(403).end();
        return;
      }
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE');
      res.setHeader(
        'Access-Control-Allow-Headers',
        'Authorization, Content-Type, Idempotency-Key, X-Request-Id, X-Correlation-Id, X-CSRF-Protection',
      );
      res.setHeader('Access-Control-Max-Age', '600');
      res.status(204).end();
      return;
    }
    next();
  };
}

/**
 * CSRF defence for the cookie-authenticated endpoints (/auth/refresh, /auth/logout):
 *  1. SameSite=Strict cookie (set elsewhere);
 *  2. a custom header is mandatory — HTML forms cannot set it and cross-origin fetches must pass a CORS preflight;
 *  3. if the browser sends Origin, it must be allow-listed.
 */
export function requireCsrfProtection(allowed: string[]): RequestHandler {
  const set = new Set(allowed);
  return (req, _res, next) => {
    if (req.get('x-csrf-protection') !== '1')
      return next(new AppError('FORBIDDEN', 'Missing CSRF protection header'));
    const origin = req.get('origin');
    if (origin && !set.has(origin)) return next(new AppError('FORBIDDEN', 'Origin not allowed'));
    next();
  };
}

/** Bearer authentication. Sets req.principal or rejects with 401. */
export function authenticate(tokens: TokenConfig): RequestHandler {
  return async (req, _res, next) => {
    const h = req.get('authorization');
    const m = h ? /^Bearer ([A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]+\.[A-Za-z0-9\-_]*)$/.exec(h) : null;
    if (!m) return next(new AppError('UNAUTHENTICATED', 'Missing or malformed bearer token'));
    req.principal = await verifyAccessToken(tokens, m[1]!);
    req.log = req.log.child({
      user_id: req.principal.userId,
      role: req.principal.role,
      store_id: req.principal.storeId,
    });
    next();
  };
}

export const permit =
  (perm: Permission): RequestHandler =>
  (req, _res, next) => {
    requirePermission(principalOf(req), perm);
    next();
  };

export function principalOf(req: Request): Principal {
  if (!req.principal) throw new AppError('UNAUTHENTICATED', 'Authentication required');
  return req.principal;
}

/** Validates external input; reports paths and messages only (never echoes submitted values). */
export function parse<T>(schema: ZodType<T>, data: unknown): T {
  const r = schema.safeParse(data);
  if (!r.success) {
    throw new AppError('VALIDATION_FAILED', 'Request validation failed', {
      details: {
        issues: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message, code: i.code })),
      },
    });
  }
  return r.data;
}

export const clientIp = (req: Request): string | null => req.ip ?? null;

/** Final error handler: typed errors -> stable JSON; unknown errors -> 500 with an error id, no stack, no detail. */
export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  const log = req.log ?? undefined;
  let e: AppError;
  const bodyErr = err as { type?: string; status?: number };
  if (bodyErr?.type === 'entity.too.large') e = new AppError('PAYLOAD_TOO_LARGE', 'Request body too large');
  else if (bodyErr?.type === 'entity.parse.failed')
    e = new AppError('VALIDATION_FAILED', 'Malformed JSON body');
  else if (bodyErr?.type === 'encoding.unsupported' || bodyErr?.type === 'charset.unsupported')
    e = new AppError('VALIDATION_FAILED', 'Unsupported body encoding');
  else if (err instanceof AppError) e = err;
  else {
    log?.error({ err }, 'unhandled error');
    e = new AppError('INTERNAL', 'Internal server error');
  }
  if (e.httpStatus >= 500 && e.code !== 'INTERNAL')
    log?.warn({ err: e, code: e.code }, 'dependency or capacity error');
  if (e.retryAfterSeconds) res.setHeader('Retry-After', String(e.retryAfterSeconds));
  res.status(e.httpStatus).json({
    error: {
      code: e.code,
      message: e.message,
      ...(e.details && e.httpStatus < 500 ? { details: e.details } : {}),
    },
    requestId: req.id,
  });
}
