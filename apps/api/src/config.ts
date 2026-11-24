import { z } from 'zod';
import { ConfigSchema } from '@aisleforge/shared';

const int = (def: number, max = Number.MAX_SAFE_INTEGER) =>
  z.coerce.number().int().positive().max(max).default(def);
const bool = (def: boolean) => z.stringbool().default(def);

export const ApiConfigSchema = ConfigSchema.extend({
  PORT: int(8080, 65535),
  // HS256 secret: >= 32 bytes of entropy. No default: the API refuses to start without one.
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  JWT_ISSUER: z.string().default('aisleforge'),
  JWT_AUDIENCE: z.string().default('aisleforge-api'),
  ACCESS_TOKEN_TTL_SECONDS: int(600, 3600),
  REFRESH_TOKEN_TTL_HOURS: int(12, 24),
  CORS_ORIGINS: z
    .string()
    .default('http://localhost:5173')
    .transform((s) =>
      s
        .split(',')
        .map((o) => o.trim())
        .filter(Boolean),
    ),
  COOKIE_SECURE: bool(true),
  TRUST_PROXY: bool(false),
  JSON_BODY_LIMIT: z.string().default('64kb'),
  // Login throttle (per account+source, progressive) — see ADR-005.
  LOGIN_MAX_FAILURES: int(5),
  LOGIN_FAILURE_WINDOW_SECONDS: int(900),
  LOGIN_LOCK_BASE_SECONDS: int(60),
  LOGIN_LOCK_MAX_SECONDS: int(900),
  LOGIN_LOCK_ESCALATION_SECONDS: int(86400),
  LOGIN_ACCOUNT_MAX_FAILURES: int(100),
  LOGIN_ACCOUNT_WINDOW_SECONDS: int(3600),
  LOGIN_KNOWN_SOURCE_TTL_DAYS: int(30),
  LOGIN_IP_MAX_ATTEMPTS: int(30),
  LOGIN_IP_WINDOW_SECONDS: int(300),
  REGISTER_IP_MAX: int(20),
  REGISTER_IP_WINDOW_SECONDS: int(3600),
  // Phase 7 (ADR-007). Empty = Redis disabled: in-process limits, catalog straight from PostgreSQL.
  REDIS_URL: z
    .string()
    .default('')
    .refine((s) => s === '' || /^rediss?:\/\//.test(s), 'REDIS_URL must be redis:// or rediss://'),
  REDIS_COMMAND_TIMEOUT_MS: int(150, 5000),
  CATALOG_CACHE_TTL_MS: int(5000, 300_000),
  // Offline sync load shedding per user (reconnect storms) — ADR-004.
  SYNC_MAX_REQUESTS: int(120),
  SYNC_WINDOW_SECONDS: int(60),
});
export type ApiConfig = z.infer<typeof ApiConfigSchema>;

export function loadApiConfig(env: NodeJS.ProcessEnv = process.env): ApiConfig {
  const parsed = ApiConfigSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid API configuration: ${issues}`);
  }
  return parsed.data;
}
