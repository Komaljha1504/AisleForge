import { SignJWT, jwtVerify } from 'jose';
import { z } from 'zod';
import { AppError, newId } from '@aisleforge/shared';
import { ROLES, type Principal } from './authorization';

export interface TokenConfig {
  secret: string;
  issuer: string;
  audience: string;
  accessTtlSeconds: number;
}

const ALG = 'HS256';
const keyCache = new Map<string, Uint8Array>();
const keyFor = (secret: string): Uint8Array => {
  let k = keyCache.get(secret);
  if (!k) keyCache.set(secret, (k = new TextEncoder().encode(secret)));
  return k;
};

const ClaimsSchema = z.object({
  sub: z.uuid(),
  role: z.enum(ROLES),
  store: z.number().int().positive().nullable(),
  sid: z.uuid(),
});

/** Short-lived access token. Held in memory by clients (never localStorage). */
export async function issueAccessToken(
  cfg: TokenConfig,
  p: Principal,
): Promise<{ token: string; expiresIn: number }> {
  const token = await new SignJWT({ role: p.role, store: p.storeId, sid: p.sessionId })
    .setProtectedHeader({ alg: ALG, typ: 'JWT' })
    .setSubject(p.userId)
    .setIssuer(cfg.issuer)
    .setAudience(cfg.audience)
    .setIssuedAt()
    .setJti(newId())
    .setExpirationTime(`${cfg.accessTtlSeconds}s`)
    .sign(keyFor(cfg.secret));
  return { token, expiresIn: cfg.accessTtlSeconds };
}

/**
 * Verifies signature, algorithm (allow-list: HS256 only — rejects `none` and algorithm confusion), issuer,
 * audience, expiry, and the claim shape. Any failure is a uniform 401 without detail.
 */
export async function verifyAccessToken(cfg: TokenConfig, token: string): Promise<Principal> {
  try {
    const { payload } = await jwtVerify(token, keyFor(cfg.secret), {
      algorithms: [ALG],
      issuer: cfg.issuer,
      audience: cfg.audience,
      clockTolerance: 5,
    });
    const c = ClaimsSchema.parse(payload);
    return { userId: c.sub, role: c.role, storeId: c.store, sessionId: c.sid };
  } catch (e) {
    throw new AppError('UNAUTHENTICATED', 'Invalid or expired access token', { cause: e });
  }
}
