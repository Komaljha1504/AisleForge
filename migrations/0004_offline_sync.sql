-- Phase 4: offline-first picking. Device registry, idempotent operation log, supervisor review of rejections.
-- See ADR-004 (offline sync) and docs/architecture/OFFLINE_SYNC.md.

-- A device is one browser profile/installation (id generated client-side, stored in IndexedDB).
-- last_seq is the highest per-device sequence number applied or rejected; a NEW op must have seq > last_seq.
CREATE TABLE devices (
  device_id      uuid PRIMARY KEY,
  first_user_id  uuid NOT NULL REFERENCES users(id),
  last_user_id   uuid NOT NULL REFERENCES users(id),
  last_seq       bigint NOT NULL DEFAULT 0 CHECK (last_seq >= 0),
  last_sync_at   timestamptz NOT NULL DEFAULT clock_timestamp(),
  user_agent     text
);

CREATE TYPE sync_op_status AS ENUM ('applied', 'rejected');

-- Every operation a device sent, exactly once (I7: the primary key makes a second application impossible).
-- Rejected operations are kept with a machine-readable reason and an open review for the store's supervisors.
CREATE TABLE sync_ops (
  device_id          uuid NOT NULL REFERENCES devices(device_id),
  op_id              uuid NOT NULL,
  seq                bigint NOT NULL CHECK (seq > 0),
  user_id            uuid NOT NULL REFERENCES users(id),
  store_id           integer REFERENCES stores(id),
  op_type            text NOT NULL CHECK (op_type IN ('pick.confirm', 'task.complete')),
  task_id            uuid,
  payload            jsonb NOT NULL,
  status             sync_op_status NOT NULL,
  reason             text,
  result             jsonb,
  client_created_at  timestamptz,
  received_at        timestamptz NOT NULL DEFAULT clock_timestamp(),
  review_status      text CHECK (review_status IN ('open', 'acknowledged', 'recount_requested')),
  reviewed_by        uuid REFERENCES users(id),
  reviewed_at        timestamptz,
  review_note        text,
  PRIMARY KEY (device_id, op_id),
  CONSTRAINT sync_ops_seq_unique UNIQUE (device_id, seq),
  CONSTRAINT sync_ops_reason_shape CHECK ((status = 'rejected') = (reason IS NOT NULL)),
  CONSTRAINT sync_ops_review_shape CHECK ((status = 'rejected') = (review_status IS NOT NULL))
);
CREATE INDEX sync_ops_review_idx ON sync_ops (store_id, review_status, received_at) WHERE status = 'rejected';
CREATE INDEX sync_ops_task_idx ON sync_ops (task_id);
