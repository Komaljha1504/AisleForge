import { randomBytes } from 'node:crypto';
import { withTransaction, type PgClient, type PgPool } from '@aisleforge/database';
import { newId, sha256Hex } from '@aisleforge/shared';
import type { Role } from './authorization';
import { auditAuth } from './audit';

export interface ClientMeta {
  ip: string | null;
  userAgent: string | null;
}

export interface IssuedRefresh {
  refreshToken: string;
  familyId: string;
  expiresAt: Date;
}

/** 256-bit opaque token; only its SHA-256 is stored, so a database leak does not yield usable tokens. */
const newRawToken = (): string => randomBytes(32).toString('base64url');
export const hashRefreshToken = (raw: string): string => sha256Hex(raw);

/** Starts a new session (token family) with an absolute lifetime of `ttlHours` (one shift by default). */
export async function createSession(
  c: PgClient | PgPool,
  userId: string,
  ttlHours: number,
  meta: ClientMeta,
): Promise<IssuedRefresh> {
  const raw = newRawToken();
  const familyId = newId();
  const expiresAt = new Date(Date.now() + ttlHours * 3_600_000);
  await c.query(
    `INSERT INTO refresh_tokens (id, family_id, user_id, token_hash, expires_at, user_agent, ip)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      newId(),
      familyId,
      userId,
      hashRefreshToken(raw),
      expiresAt,
      meta.userAgent?.slice(0, 300) ?? null,
      meta.ip,
    ],
  );
  return { refreshToken: raw, familyId, expiresAt };
}

export type RotateResult =
  | { ok: true; refresh: IssuedRefresh; user: { id: string; role: Role; storeId: number | null } }
  | { ok: false; reason: 'unknown' | 'revoked' | 'expired' | 'reuse_detected' | 'disabled' };

/**
 * Refresh-token rotation with reuse detection (OAuth 2.0 Security BCP).
 * The presented token row is locked (FOR UPDATE), so two concurrent refreshes with the same token serialize:
 * the first rotates, the second sees `used_at` and is treated as a replay, which revokes the whole family.
 * The revocation is COMMITTED before the failure is reported (the transaction returns a result, it does not throw).
 */
export async function rotateRefreshToken(pool: PgPool, raw: string, meta: ClientMeta): Promise<RotateResult> {
  const result = await withTransaction(pool, { label: 'auth.refresh' }, async (c): Promise<RotateResult> => {
    const { rows } = await c.query<{
      id: string;
      family_id: string;
      user_id: string;
      expires_at: Date;
      used_at: Date | null;
      revoked_at: Date | null;
      role: Role;
      store_id: number | null;
      disabled_at: Date | null;
    }>(
      `SELECT t.id, t.family_id, t.user_id, t.expires_at, t.used_at, t.revoked_at, u.role, u.store_id, u.disabled_at
         FROM refresh_tokens t JOIN users u ON u.id = t.user_id
        WHERE t.token_hash = $1 FOR UPDATE OF t`,
      [hashRefreshToken(raw)],
    );
    const t = rows[0];
    if (!t) return { ok: false, reason: 'unknown' };
    if (t.revoked_at) return { ok: false, reason: 'revoked' };
    if (t.used_at) {
      await revokeFamilyInTx(c, t.family_id, 'reuse_detected');
      await auditAuth(c, {
        event: 'refresh_reuse_detected',
        success: false,
        userId: t.user_id,
        ip: meta.ip,
        detail: { familyId: t.family_id },
      });
      return { ok: false, reason: 'reuse_detected' };
    }
    if (t.expires_at.getTime() <= Date.now()) return { ok: false, reason: 'expired' };
    if (t.disabled_at) {
      await revokeFamilyInTx(c, t.family_id, 'user_disabled');
      return { ok: false, reason: 'disabled' };
    }
    const next = newRawToken();
    await c.query('UPDATE refresh_tokens SET used_at = now() WHERE id = $1', [t.id]);
    await c.query(
      `INSERT INTO refresh_tokens (id, family_id, user_id, token_hash, parent_id, expires_at, user_agent, ip)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        newId(),
        t.family_id,
        t.user_id,
        hashRefreshToken(next),
        t.id,
        t.expires_at,
        meta.userAgent?.slice(0, 300) ?? null,
        meta.ip,
      ],
    );
    return {
      ok: true,
      refresh: { refreshToken: next, familyId: t.family_id, expiresAt: t.expires_at },
      user: { id: t.user_id, role: t.role, storeId: t.store_id },
    };
  });
  return result;
}

async function revokeFamilyInTx(c: PgClient, familyId: string, reason: string): Promise<void> {
  await c.query(
    `UPDATE refresh_tokens SET revoked_at = now(), revoke_reason = $2 WHERE family_id = $1 AND revoked_at IS NULL`,
    [familyId, reason],
  );
}

/** Logout: revokes the session (family) the presented refresh token belongs to. Unknown tokens are a no-op. */
export async function revokeSessionByToken(
  pool: PgPool,
  raw: string,
  reason = 'logout',
): Promise<string | null> {
  const { rows } = await pool.query<{ family_id: string; user_id: string }>(
    `UPDATE refresh_tokens SET revoked_at = now(), revoke_reason = $2
      WHERE family_id = (SELECT family_id FROM refresh_tokens WHERE token_hash = $1) AND revoked_at IS NULL
      RETURNING family_id, user_id`,
    [hashRefreshToken(raw), reason],
  );
  return rows[0]?.user_id ?? null;
}

export async function revokeAllSessionsForUser(
  c: PgClient | PgPool,
  userId: string,
  reason: string,
): Promise<number> {
  const r = await c.query(
    `UPDATE refresh_tokens SET revoked_at = now(), revoke_reason = $2 WHERE user_id = $1 AND revoked_at IS NULL`,
    [userId, reason],
  );
  return r.rowCount ?? 0;
}
