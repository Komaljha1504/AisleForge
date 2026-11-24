import { Router, type Request, type Response } from 'express';
import { parseCookie, stringifySetCookie } from 'cookie';
import {
  auditAuth,
  createSession,
  findUserForLogin,
  issueAccessToken,
  registerCustomer,
  revokeSessionByToken,
  rotateRefreshToken,
  verifyPassword,
  type TokenConfig,
} from '@aisleforge/domain';
import { AppError } from '@aisleforge/shared';
import { LoginRequestSchema, RegisterRequestSchema } from '@aisleforge/validation';
import type { ApiConfig } from '../config';
import { clientIp, parse, requireCsrfProtection } from '../http/middleware';
import type { RateLimiter } from '../security/rateLimiter';
import type { LoginGuard } from '../security/loginThrottle';
import type { AppPools } from '../app';

export const REFRESH_COOKIE = 'af_refresh';
const COOKIE_PATH = '/api/v1/auth';

export function authRoutes(
  cfg: ApiConfig,
  pools: AppPools,
  tokens: TokenConfig,
  limiter: RateLimiter,
  loginThrottle: LoginGuard,
): Router {
  const r = Router();
  const csrf = requireCsrfProtection(cfg.CORS_ORIGINS);

  const setRefreshCookie = (res: Response, token: string, expiresAt: Date) =>
    res.append(
      'Set-Cookie',
      stringifySetCookie({
        name: REFRESH_COOKIE,
        value: token,
        httpOnly: true,
        secure: cfg.COOKIE_SECURE,
        sameSite: 'strict',
        path: COOKIE_PATH,
        expires: expiresAt,
      }),
    );
  const clearRefreshCookie = (res: Response) =>
    res.append(
      'Set-Cookie',
      stringifySetCookie({
        name: REFRESH_COOKIE,
        value: '',
        httpOnly: true,
        secure: cfg.COOKIE_SECURE,
        sameSite: 'strict',
        path: COOKIE_PATH,
        maxAge: 0,
      }),
    );
  const readRefreshCookie = (req: Request): string | null => {
    const raw = req.headers.cookie ? parseCookie(req.headers.cookie)[REFRESH_COOKIE] : undefined;
    return raw && /^[A-Za-z0-9_-]{20,200}$/.test(raw) ? raw : null;
  };
  const meta = (req: Request) => ({ ip: clientIp(req), userAgent: req.get('user-agent') ?? null });

  r.post('/register', async (req, res) => {
    const ip = clientIp(req) ?? 'unknown';
    const d = await limiter.hit(`register-ip:${ip}`, cfg.REGISTER_IP_MAX, cfg.REGISTER_IP_WINDOW_SECONDS);
    if (!d.allowed)
      throw new AppError('RATE_LIMITED', 'Too many registrations; retry later', {
        retryAfterSeconds: d.retryAfterSeconds,
      });
    const body = parse(RegisterRequestSchema, req.body);
    const user = await registerCustomer(pools.orders, body, { ip });
    res.status(201).json({ user });
  });

  r.post('/login', async (req, res) => {
    const ip = clientIp(req) ?? 'unknown';
    const body = parse(LoginRequestSchema, req.body);
    const ipDecision = await limiter.hit(
      `login-ip:${ip}`,
      cfg.LOGIN_IP_MAX_ATTEMPTS,
      cfg.LOGIN_IP_WINDOW_SECONDS,
    );
    // Throttle is keyed by (account, source) so an attacker cannot lock the real user out (ADR-005).
    const throttle = await loginThrottle.check(body.email, ip);
    if (!ipDecision.allowed || !throttle.allowed) {
      await auditAuth(pools.orders, {
        event: 'login_rate_limited',
        success: false,
        email: body.email,
        ip,
        detail: { reason: !ipDecision.allowed ? 'ip_rate_limit' : throttle.reason },
      });
      throw new AppError('RATE_LIMITED', 'Too many login attempts; retry later', {
        retryAfterSeconds: Math.max(ipDecision.retryAfterSeconds, throttle.retryAfterSeconds),
      });
    }
    const user = await findUserForLogin(pools.orders, body.email);
    const passwordOk = await verifyPassword(user?.passwordHash ?? null, body.password); // constant work for unknown users
    if (!user || !passwordOk || user.disabled) {
      await loginThrottle.recordFailure(body.email, ip);
      await auditAuth(pools.orders, {
        event: 'login',
        success: false,
        userId: user?.id ?? null,
        email: body.email,
        ip,
      });
      throw new AppError('UNAUTHENTICATED', 'Invalid email or password'); // identical for every failure cause
    }
    await loginThrottle.recordSuccess(body.email, ip);
    const session = await createSession(pools.orders, user.id, cfg.REFRESH_TOKEN_TTL_HOURS, meta(req));
    const access = await issueAccessToken(tokens, {
      userId: user.id,
      role: user.role,
      storeId: user.storeId,
      sessionId: session.familyId,
    });
    await auditAuth(pools.orders, { event: 'login', success: true, userId: user.id, email: body.email, ip });
    setRefreshCookie(res, session.refreshToken, session.expiresAt);
    res.json({
      accessToken: access.token,
      tokenType: 'Bearer',
      expiresIn: access.expiresIn,
      user: { id: user.id, role: user.role, storeId: user.storeId },
    });
  });

  r.post('/refresh', csrf, async (req, res) => {
    const raw = readRefreshCookie(req);
    if (!raw) throw new AppError('UNAUTHENTICATED', 'No session');
    const out = await rotateRefreshToken(pools.orders, raw, meta(req));
    if (!out.ok) {
      clearRefreshCookie(res);
      throw new AppError('UNAUTHENTICATED', 'Session is no longer valid');
    }
    const access = await issueAccessToken(tokens, {
      userId: out.user.id,
      role: out.user.role,
      storeId: out.user.storeId,
      sessionId: out.refresh.familyId,
    });
    setRefreshCookie(res, out.refresh.refreshToken, out.refresh.expiresAt);
    res.json({ accessToken: access.token, tokenType: 'Bearer', expiresIn: access.expiresIn, user: out.user });
  });

  r.post('/logout', csrf, async (req, res) => {
    const raw = readRefreshCookie(req);
    if (raw) {
      const userId = await revokeSessionByToken(pools.orders, raw);
      await auditAuth(pools.orders, { event: 'logout', success: true, userId, ip: clientIp(req) });
    }
    clearRefreshCookie(res);
    res.status(204).end();
  });

  return r;
}
