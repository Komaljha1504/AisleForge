import express, { type Express } from 'express';
import { CatalogCache, RedisClient } from '@aisleforge/cache';
import type { PgPool } from '@aisleforge/database';
import type { DomainContext, TokenConfig } from '@aisleforge/domain';
import { AppError, type Logger } from '@aisleforge/shared';
import type { ApiConfig } from './config';
import { authenticate, cors, errorHandler, permit, requestContext, securityHeaders } from './http/middleware';
import { authRoutes } from './routes/auth';
import { healthRoutes, internalRoutes } from './routes/health';
import { pickingRoutes } from './routes/picking';
import { resourceRoutes } from './routes/resources';
import { InMemoryRateLimiter, RedisRateLimiter, type RateLimiter } from './security/rateLimiter';
import { LoginThrottle, type LoginGuard } from './security/loginThrottle';
import { RedisLoginThrottle } from './security/redisLoginThrottle';

export interface AppPools {
  /** Bulkhead for orders, auth and staff operations. */
  orders: PgPool;
  /** Bulkhead for device synchronization (Phase 4); separate so reconnect storms cannot starve order placement. */
  sync: PgPool;
}

export interface AppState {
  shuttingDown: boolean;
}

export interface AppDeps {
  config: ApiConfig;
  pools: AppPools;
  logger: Logger;
  rateLimiter?: RateLimiter;
  loginThrottle?: LoginGuard;
  state?: AppState;
  /** Optional shared Redis client (Phase 7). Created from REDIS_URL when not injected. */
  redis?: RedisClient | null;
}

export interface AppHandle {
  redis: RedisClient | null;
}

export function createApp(deps: AppDeps): Express & { aisleforge?: AppHandle } {
  const { config: cfg, pools, logger } = deps;
  const state = deps.state ?? { shuttingDown: false };
  const redis =
    deps.redis !== undefined
      ? deps.redis
      : cfg.REDIS_URL
        ? new RedisClient(cfg.REDIS_URL, logger, { commandTimeoutMs: cfg.REDIS_COMMAND_TIMEOUT_MS })
        : null;
  const policy = {
    perSourceMaxFailures: cfg.LOGIN_MAX_FAILURES,
    failureWindowSeconds: cfg.LOGIN_FAILURE_WINDOW_SECONDS,
    baseLockSeconds: cfg.LOGIN_LOCK_BASE_SECONDS,
    maxLockSeconds: cfg.LOGIN_LOCK_MAX_SECONDS,
    lockEscalationSeconds: cfg.LOGIN_LOCK_ESCALATION_SECONDS,
    accountMaxFailures: cfg.LOGIN_ACCOUNT_MAX_FAILURES,
    accountWindowSeconds: cfg.LOGIN_ACCOUNT_WINDOW_SECONDS,
    knownSourceTtlSeconds: cfg.LOGIN_KNOWN_SOURCE_TTL_DAYS * 86400,
  };
  // Shared limits when Redis is configured; the in-process implementations are the outage fallback.
  const limiter = deps.rateLimiter ?? (redis ? new RedisRateLimiter(redis) : new InMemoryRateLimiter());
  const loginThrottle: LoginGuard =
    deps.loginThrottle ??
    (redis ? new RedisLoginThrottle(redis, policy, new LoginThrottle(policy)) : new LoginThrottle(policy));
  const catalogCache = redis ? new CatalogCache(redis, cfg.CATALOG_CACHE_TTL_MS) : null;
  const tokens: TokenConfig = {
    secret: cfg.JWT_SECRET,
    issuer: cfg.JWT_ISSUER,
    audience: cfg.JWT_AUDIENCE,
    accessTtlSeconds: cfg.ACCESS_TOKEN_TTL_SECONDS,
  };
  const ordersCtx: DomainContext = { pool: pools.orders, config: cfg, logger };
  const syncCtx: DomainContext = { pool: pools.sync, config: cfg, logger };

  const app = express() as Express & { aisleforge?: AppHandle };
  app.aisleforge = { redis };
  app.disable('x-powered-by');
  app.set('trust proxy', cfg.TRUST_PROXY ? 1 : false);
  app.set('query parser', 'simple');

  app.use(requestContext(logger));
  app.use(securityHeaders);
  app.use(cors(cfg.CORS_ORIGINS));
  app.use(express.json({ limit: cfg.JSON_BODY_LIMIT, strict: true, type: 'application/json' }));

  app.use(healthRoutes(pools, state));
  app.use('/api/v1/auth', authRoutes(cfg, pools, tokens, limiter, loginThrottle));
  const auth = authenticate(tokens);
  app.use('/internal', auth, permit('internal:status'), internalRoutes(pools, redis)); // never public
  app.use('/api/v1', auth, resourceRoutes(pools, ordersCtx, loginThrottle));
  app.use(
    '/api/v1',
    auth,
    pickingRoutes(
      pools,
      ordersCtx,
      syncCtx,
      limiter,
      { max: cfg.SYNC_MAX_REQUESTS, windowSeconds: cfg.SYNC_WINDOW_SECONDS },
      catalogCache,
    ),
  );

  app.use((_req, _res, next) => next(new AppError('NOT_FOUND', 'Route not found')));
  app.use(errorHandler);
  return app;
}
