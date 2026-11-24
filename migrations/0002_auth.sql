-- Phase 3: authentication sessions and security audit trail. See docs/decisions/ADR-005-authentication.md

ALTER TABLE users ADD COLUMN disabled_at timestamptz;
ALTER TABLE users ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();

-- Opaque refresh tokens, stored only as SHA-256 hashes. One family = one login session.
-- Every refresh rotates the token (used_at set, child row inserted). Presenting a token whose used_at is already set
-- is a replay: the whole family is revoked. Children inherit the family's absolute expiry (no infinite sliding).
CREATE TABLE refresh_tokens (
  id             uuid PRIMARY KEY,
  family_id      uuid NOT NULL,
  user_id        uuid NOT NULL REFERENCES users(id),
  token_hash     text NOT NULL UNIQUE,
  parent_id      uuid REFERENCES refresh_tokens(id),
  issued_at      timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL,
  used_at        timestamptz,
  revoked_at     timestamptz,
  revoke_reason  text,
  user_agent     text,
  ip             text
);
CREATE INDEX refresh_tokens_family_idx ON refresh_tokens (family_id);
CREATE INDEX refresh_tokens_user_active_idx ON refresh_tokens (user_id) WHERE revoked_at IS NULL;

-- Security-relevant events (login success/failure, refresh reuse, role changes). Append-only.
CREATE TABLE auth_audit_log (
  id          bigserial PRIMARY KEY,
  at          timestamptz NOT NULL DEFAULT now(),
  event       text NOT NULL,
  success     boolean NOT NULL,
  user_id     uuid,
  actor_id    uuid,
  email       text,
  ip          text,
  detail      jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX auth_audit_log_user_idx ON auth_audit_log (user_id, at DESC);
CREATE TRIGGER auth_audit_log_append_only BEFORE UPDATE OR DELETE ON auth_audit_log
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
