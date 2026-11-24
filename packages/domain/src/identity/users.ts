import { withTransaction, type PgPool } from '@aisleforge/database';
import { AppError, newId, pgErrorCode } from '@aisleforge/shared';
import { auditAuth } from './audit';
import type { Principal, Role } from './authorization';
import { assertPasswordPolicy, hashPassword } from './passwords';
import { revokeAllSessionsForUser } from './sessions';

export interface PublicUser {
  id: string;
  email: string;
  displayName: string;
  role: Role;
  storeId: number | null;
}

interface UserRow {
  id: string;
  email: string;
  display_name: string;
  role: Role;
  store_id: number | null;
}
const toPublic = (r: UserRow): PublicUser => ({
  id: r.id,
  email: r.email,
  displayName: r.display_name,
  role: r.role,
  storeId: r.store_id,
});

function mapUserWriteError(e: unknown): never {
  const code = pgErrorCode(e);
  if (code === '23505')
    throw new AppError('CONFLICT', 'An account with this email already exists', { cause: e });
  if (code === '23514')
    throw new AppError('VALIDATION_FAILED', 'Role and store assignment are inconsistent', { cause: e });
  if (code === '23503') throw new AppError('VALIDATION_FAILED', 'Unknown store', { cause: e });
  throw e;
}

/** Self-service registration. The role is fixed to 'customer' here; it is not an input. */
export async function registerCustomer(
  pool: PgPool,
  cmd: { email: string; password: string; displayName: string },
  meta: { ip: string | null },
): Promise<PublicUser> {
  const email = cmd.email.toLowerCase();
  assertPasswordPolicy(cmd.password, email);
  const hash = await hashPassword(cmd.password);
  try {
    const { rows } = await pool.query<UserRow>(
      `INSERT INTO users (id, email, display_name, role, store_id, password_hash) VALUES ($1, $2, $3, 'customer', NULL, $4)
       RETURNING id, email, display_name, role, store_id`,
      [newId(), email, cmd.displayName, hash],
    );
    const u = toPublic(rows[0]!);
    await auditAuth(pool, { event: 'register', success: true, userId: u.id, email, ip: meta.ip });
    return u;
  } catch (e) {
    mapUserWriteError(e);
  }
}

/** Admin-only (enforced by the caller's permission check AND re-checked here). */
export async function createStaffUser(
  pool: PgPool,
  actor: Principal,
  cmd: { email: string; password: string; displayName: string; role: Role; storeId: number | null },
): Promise<PublicUser> {
  if (actor.role !== 'admin') throw new AppError('FORBIDDEN', 'Only admins can create users');
  const email = cmd.email.toLowerCase();
  assertPasswordPolicy(cmd.password, email);
  const hash = await hashPassword(cmd.password);
  try {
    const { rows } = await pool.query<UserRow>(
      `INSERT INTO users (id, email, display_name, role, store_id, password_hash) VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, email, display_name, role, store_id`,
      [newId(), email, cmd.displayName, cmd.role, cmd.storeId, hash],
    );
    const u = toPublic(rows[0]!);
    await auditAuth(pool, {
      event: 'user_created',
      success: true,
      userId: u.id,
      actorId: actor.userId,
      email,
      detail: { role: u.role, storeId: u.storeId },
    });
    return u;
  } catch (e) {
    mapUserWriteError(e);
  }
}

/**
 * Admin-only role/store change. All of the user's sessions are revoked in the same transaction, so the old role
 * cannot be refreshed; an already-issued access token remains valid until it expires (≤ ACCESS_TOKEN_TTL).
 */
export async function changeUserRole(
  pool: PgPool,
  actor: Principal,
  cmd: { userId: string; role: Role; storeId: number | null },
): Promise<PublicUser> {
  if (actor.role !== 'admin') throw new AppError('FORBIDDEN', 'Only admins can change roles');
  if (cmd.userId === actor.userId) throw new AppError('FORBIDDEN', 'Admins cannot change their own role');
  try {
    return await withTransaction(pool, { label: 'users.changeRole' }, async (c) => {
      const before = await c.query<{ role: Role; store_id: number | null }>(
        'SELECT role, store_id FROM users WHERE id = $1 FOR UPDATE',
        [cmd.userId],
      );
      if (!before.rows[0]) throw new AppError('NOT_FOUND', 'User not found');
      const { rows } = await c.query<UserRow>(
        `UPDATE users SET role = $2, store_id = $3, updated_at = now() WHERE id = $1 RETURNING id, email, display_name, role, store_id`,
        [cmd.userId, cmd.role, cmd.storeId],
      );
      const revoked = await revokeAllSessionsForUser(c, cmd.userId, 'role_changed');
      await auditAuth(c, {
        event: 'role_changed',
        success: true,
        userId: cmd.userId,
        actorId: actor.userId,
        detail: {
          from: before.rows[0],
          to: { role: cmd.role, store_id: cmd.storeId },
          sessionsRevoked: revoked,
        },
      });
      return toPublic(rows[0]!);
    });
  } catch (e) {
    if (e instanceof AppError) throw e;
    mapUserWriteError(e);
  }
}

export async function getUser(pool: PgPool, userId: string): Promise<PublicUser | null> {
  const { rows } = await pool.query<UserRow>(
    'SELECT id, email, display_name, role, store_id FROM users WHERE id = $1 AND disabled_at IS NULL',
    [userId],
  );
  return rows[0] ? toPublic(rows[0]) : null;
}

/** The only self-editable field. Role/store/email changes go through admin endpoints. */
export async function updateDisplayName(
  pool: PgPool,
  userId: string,
  displayName: string,
): Promise<PublicUser> {
  const { rows } = await pool.query<UserRow>(
    `UPDATE users SET display_name = $2, updated_at = now() WHERE id = $1 RETURNING id, email, display_name, role, store_id`,
    [userId, displayName],
  );
  if (!rows[0]) throw new AppError('NOT_FOUND', 'User not found');
  return toPublic(rows[0]);
}

export async function findUserForLogin(
  pool: PgPool,
  email: string,
): Promise<{
  id: string;
  passwordHash: string;
  role: Role;
  storeId: number | null;
  disabled: boolean;
} | null> {
  const { rows } = await pool.query<{
    id: string;
    password_hash: string;
    role: Role;
    store_id: number | null;
    disabled_at: Date | null;
  }>('SELECT id, password_hash, role, store_id, disabled_at FROM users WHERE email = $1', [
    email.toLowerCase(),
  ]);
  const r = rows[0];
  return r
    ? {
        id: r.id,
        passwordHash: r.password_hash,
        role: r.role,
        storeId: r.store_id,
        disabled: r.disabled_at !== null,
      }
    : null;
}
