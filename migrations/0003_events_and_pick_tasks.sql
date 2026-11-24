-- Phase 2: Kafka consumers (dedupe, aggregate-version tracking), dead letters, pick tasks, store layouts.
-- See ADR-003 (consumers) and ADR-006 (routing).

-- Consumer deduplication. A row is inserted IN THE SAME TRANSACTION as the consumer's effects; the Kafka offset is
-- committed only after that transaction commits. A redelivered event finds its row and is skipped (invariant I6).
-- Dead-lettered events are deliberately NOT recorded here, so that a replay can still process them.
CREATE TABLE processed_events (
  consumer_name    text NOT NULL,
  event_id         uuid NOT NULL,
  event_type       text NOT NULL,
  topic            text NOT NULL,
  kafka_partition  integer NOT NULL,
  kafka_offset     bigint NOT NULL,
  outcome          text NOT NULL CHECK (outcome IN ('applied', 'stale', 'ignored')),
  processed_at     timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (consumer_name, event_id)
);
CREATE INDEX processed_events_time_idx ON processed_events (processed_at);

-- Last aggregate version applied per consumer: an event whose aggregateVersion is <= this is stale (e.g. a replay
-- of an old event) and is recorded with outcome 'stale' without effects. Gaps are allowed (not every version bump
-- emits an event to every consumer).
CREATE TABLE consumer_aggregate_versions (
  consumer_name   text NOT NULL,
  aggregate_type  text NOT NULL,
  aggregate_id    text NOT NULL,
  version         bigint NOT NULL CHECK (version >= 0),
  updated_at      timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (consumer_name, aggregate_type, aggregate_id)
);

CREATE TYPE dead_letter_status AS ENUM ('dead', 'replay_requested', 'replayed', 'discarded');

-- Poison messages: bounded retries, then a row here AND a copy on <topic>.dlt. One row per source message
-- (consumer, topic, partition, offset), so a redelivered poison message does not create a second row.
CREATE TABLE dead_letters (
  id                   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  consumer_name        text NOT NULL,
  topic                text NOT NULL,
  kafka_partition      integer NOT NULL,
  kafka_offset         bigint NOT NULL,
  kafka_key            text,
  raw_value            text,
  headers              jsonb NOT NULL DEFAULT '{}'::jsonb,
  event_id             uuid,
  event_type           text,
  correlation_id       text,
  error_kind           text NOT NULL CHECK (error_kind IN ('invalid_message', 'unknown_event_type', 'handler_failed')),
  error_message        text NOT NULL,
  attempts             integer NOT NULL CHECK (attempts >= 1),
  status               dead_letter_status NOT NULL DEFAULT 'dead',
  dlt_published_at     timestamptz,
  created_at           timestamptz NOT NULL DEFAULT clock_timestamp(),
  replay_requested_at  timestamptz,
  replay_requested_by  uuid REFERENCES users(id),
  replayed_at          timestamptz,
  replay_count         integer NOT NULL DEFAULT 0,
  resolution_note      text,
  CONSTRAINT dead_letters_source_unique UNIQUE (consumer_name, topic, kafka_partition, kafka_offset),
  CONSTRAINT dead_letters_replay_shape CHECK (
    status <> 'replay_requested' OR (replay_requested_at IS NOT NULL)
  )
);
CREATE INDEX dead_letters_status_idx ON dead_letters (status, id);

-- Worker diagnostics snapshot (publisher leadership, consumer state, lag), written by each worker every few
-- seconds and read by the API's admin-only /internal/status. Not used for any decision.
CREATE TABLE worker_status (
  worker_id   text PRIMARY KEY,
  status      jsonb NOT NULL,
  started_at  timestamptz NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT clock_timestamp()
);

-- Warehouse layout per store (routing graph input) and the bin location of each SKU in that store.
CREATE TABLE store_layouts (
  store_id    integer PRIMARY KEY REFERENCES stores(id),
  layout      jsonb NOT NULL,
  version     integer NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sku_locations (
  store_id  integer NOT NULL REFERENCES store_layouts(store_id),
  sku       text NOT NULL REFERENCES products(sku),
  aisle     integer NOT NULL CHECK (aisle >= 0),
  pos       integer NOT NULL CHECK (pos >= 0),
  PRIMARY KEY (store_id, sku)
);

CREATE TYPE pick_task_status AS ENUM ('open', 'claimed', 'completed', 'cancelled');

-- One pick task per order, created by the order-workflow consumer from order.placed.
-- route_status: feasible (planner route) | fallback (S-shape after optimizer failure) | infeasible (cold-chain
-- policy cannot be met: no stops, supervisor attention) | unplanned (no layout/locations: lines unordered).
-- Routing problems never block task creation.
CREATE TABLE pick_tasks (
  id                uuid PRIMARY KEY,
  order_id          uuid NOT NULL UNIQUE REFERENCES orders(id),
  store_id          integer NOT NULL REFERENCES stores(id),
  status            pick_task_status NOT NULL DEFAULT 'open',
  version           bigint NOT NULL DEFAULT 1,
  assigned_to       uuid REFERENCES users(id),
  lease_expires_at  timestamptz,
  route_status      text NOT NULL CHECK (route_status IN ('feasible', 'fallback', 'infeasible', 'unplanned')),
  route             jsonb NOT NULL,
  correlation_id    text,
  source_event_id   uuid NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at        timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at      timestamptz,
  CONSTRAINT pick_tasks_claim_shape CHECK (
    status <> 'claimed' OR (assigned_to IS NOT NULL AND lease_expires_at IS NOT NULL)
  )
);
CREATE INDEX pick_tasks_store_status_idx ON pick_tasks (store_id, status, created_at, id);
CREATE INDEX pick_tasks_assignee_idx ON pick_tasks (assigned_to) WHERE status = 'claimed';
