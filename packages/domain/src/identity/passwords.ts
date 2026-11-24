import { hash, verify } from '@node-rs/argon2';
import { AppError } from '@aisleforge/shared';

/**
 * Argon2id with the OWASP Password Storage Cheat Sheet baseline (m=19 MiB, t=2, p=1).
 * `algorithm: 2` is Argon2id (the package's enum is an ambient const enum, unusable under isolatedModules).
 * Hashing runs on a native thread pool, not the Node event loop.
 */
const PARAMS = { algorithm: 2, memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

export const PASSWORD_MIN_LENGTH = 12;
/** Upper bound prevents CPU/memory abuse through enormous passwords. */
export const PASSWORD_MAX_LENGTH = 256;

export function assertPasswordPolicy(password: string, email: string): void {
  if (password.length < PASSWORD_MIN_LENGTH || password.length > PASSWORD_MAX_LENGTH) {
    throw new AppError(
      'VALIDATION_FAILED',
      `Password must be ${PASSWORD_MIN_LENGTH}-${PASSWORD_MAX_LENGTH} characters`,
    );
  }
  if (password.toLowerCase().includes(email.split('@')[0]!.toLowerCase())) {
    throw new AppError('VALIDATION_FAILED', 'Password must not contain the email name');
  }
}

export const hashPassword = (password: string): Promise<string> => hash(password, PARAMS);

let dummyHash: Promise<string> | null = null;

/**
 * Verifies a password. For unknown users (stored = null) a dummy hash is still verified, so response time does not
 * reveal whether an account exists.
 */
export async function verifyPassword(stored: string | null, password: string): Promise<boolean> {
  dummyHash ??= hash('aisleforge-timing-equaliser-not-a-password', PARAMS);
  const target = stored ?? (await dummyHash);
  try {
    const ok = await verify(target, password);
    return stored !== null && ok;
  } catch {
    return false; // malformed stored hash: treat as non-matching, never as a match
  }
}
