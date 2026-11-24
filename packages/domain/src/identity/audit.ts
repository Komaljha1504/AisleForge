import type { PgClient, PgPool } from '@aisleforge/database';

export interface AuthAuditEntry {
  event:
    | 'login'
    | 'logout'
    | 'refresh'
    | 'refresh_reuse_detected'
    | 'register'
    | 'user_created'
    | 'role_changed'
    | 'login_rate_limited'
    | 'login_throttle_cleared'
    | 'dead_letter_replay_requested'
    | 'dead_letter_discarded';
  success: boolean;
  userId?: string | null;
  actorId?: string | null;
  email?: string | null;
  ip?: string | null;
  detail?: Record<string, unknown>;
}

/** Append-only security audit trail (never contains passwords or tokens). */
export async function auditAuth(db: PgPool | PgClient, e: AuthAuditEntry): Promise<void> {
  await db.query(
    `INSERT INTO auth_audit_log (event, success, user_id, actor_id, email, ip, detail) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      e.event,
      e.success,
      e.userId ?? null,
      e.actorId ?? null,
      e.email ?? null,
      e.ip ?? null,
      JSON.stringify(e.detail ?? {}),
    ],
  );
}
