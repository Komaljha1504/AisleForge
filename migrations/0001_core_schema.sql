-- AisleForge core schema: stores, catalog, identity, inventory, ledger, orders, reservations,
-- API idempotency and the transactional outbox.
-- Design notes: docs/decisions/ADR-002-inventory-reservation.md, ADR-003-outbox-and-events.md

CREATE TABLE stores (
  id          integer PRIMARY KEY CHECK (id > 0),
  code        text NOT NULL UNIQUE,
  name        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TYPE temperature_zone AS ENUM ('ambient', 'chilled', 'frozen');

CREATE TABLE products (
  sku               text PRIMARY KEY CHECK (sku ~ '^[A-Z0-9][A-Z0-9-]{0,63}$'),
  name              text NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  temperature_zone  temperature_zone NOT NULL DEFAULT 'ambient',
  unit_price_cents  integer NOT NULL CHECK (unit_price_cents >= 0),
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TYPE user_role AS ENUM ('customer', 'picker', 'supervisor', 'admin');

CREATE TABLE users (
  id             uuid PRIMARY KEY,
  email          text NOT NULL UNIQUE CHECK (email = lower(email)),
  display_name   text NOT NULL,
  role           user_role NOT NULL,
  store_id       integer REFERENCES stores(id),
  password_hash  text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  -- Store-scoped staff must belong to a store; customers never do; admins are global.
  CONSTRAINT users_store_scope CHECK (
    (role IN ('picker', 'supervisor') AND store_id IS NOT NULL) OR
    (role = 'customer' AND store_id IS NULL) OR
    (role = 'admin')
  )
);

-- ---------------------------------------------------------------------------------------------------
-- Inventory. available = on_hand - reserved. The CHECKs are the last line of defence against oversell.
-- ---------------------------------------------------------------------------------------------------
CREATE TABLE inventory_balances (
  store_id    integer NOT NULL REFERENCES stores(id),
  sku         text    NOT NULL REFERENCES products(sku),
  on_hand     integer NOT NULL,
  reserved    integer NOT NULL DEFAULT 0,
  version     bigint  NOT NULL DEFAULT 0,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (store_id, sku),
  CONSTRAINT on_hand_non_negative CHECK (on_hand >= 0),
  CONSTRAINT reserved_within_on_hand CHECK (reserved >= 0 AND reserved <= on_hand)
);

CREATE TYPE ledger_movement AS ENUM
  ('opening', 'restock', 'reserve', 'release', 'expire', 'pick', 'short_pick', 'adjust');

-- Append-only. SUM(delta_on_hand) = on_hand and SUM(delta_reserved) = reserved per (store, sku) — invariant I3.
CREATE TABLE inventory_ledger (
  id              bigserial PRIMARY KEY,
  store_id        integer NOT NULL,
  sku             text    NOT NULL,
  movement        ledger_movement NOT NULL,
  delta_on_hand   integer NOT NULL,
  delta_reserved  integer NOT NULL,
  source_type     text NOT NULL,
  source_id       text NOT NULL,
  reason          text,
  actor_id        uuid,
  correlation_id  text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (store_id, sku) REFERENCES inventory_balances(store_id, sku),
  -- One movement of a given kind per source: replays of the same source cannot double-apply.
  CONSTRAINT ledger_source_unique UNIQUE (source_type, source_id, movement, store_id, sku),
  CONSTRAINT ledger_movement_shape CHECK (CASE movement
    WHEN 'opening'    THEN delta_on_hand >= 0 AND delta_reserved = 0
    WHEN 'restock'    THEN delta_on_hand > 0  AND delta_reserved = 0
    WHEN 'reserve'    THEN delta_on_hand = 0  AND delta_reserved > 0
    WHEN 'release'    THEN delta_on_hand = 0  AND delta_reserved < 0
    WHEN 'expire'     THEN delta_on_hand = 0  AND delta_reserved < 0
    WHEN 'pick'       THEN delta_on_hand < 0  AND delta_reserved = delta_on_hand
    WHEN 'short_pick' THEN delta_on_hand < 0  AND delta_reserved = delta_on_hand
    WHEN 'adjust'     THEN delta_on_hand <> 0 AND delta_reserved = 0
  END)
);
CREATE INDEX inventory_ledger_balance_idx ON inventory_ledger (store_id, sku, id);

CREATE FUNCTION forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only (% rejected)', TG_TABLE_NAME, TG_OP USING ERRCODE = 'restrict_violation';
END $$;
CREATE TRIGGER inventory_ledger_append_only BEFORE UPDATE OR DELETE ON inventory_ledger
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();

-- ---------------------------------------------------------------------------------------------------
-- Orders and reservations
-- ---------------------------------------------------------------------------------------------------
CREATE TYPE order_status AS ENUM ('reserved', 'picking', 'picked', 'completed', 'cancelled');

CREATE TABLE orders (
  id              uuid PRIMARY KEY,
  store_id        integer NOT NULL REFERENCES stores(id),
  customer_id     uuid NOT NULL REFERENCES users(id),
  status          order_status NOT NULL,
  version         bigint NOT NULL DEFAULT 1,
  correlation_id  text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX orders_store_created_idx ON orders (store_id, created_at DESC, id);
CREATE INDEX orders_customer_created_idx ON orders (customer_id, created_at DESC, id);

CREATE TABLE order_lines (
  id          uuid PRIMARY KEY,
  order_id    uuid NOT NULL REFERENCES orders(id),
  line_no     smallint NOT NULL CHECK (line_no > 0),
  sku         text NOT NULL REFERENCES products(sku),
  qty         integer NOT NULL CHECK (qty > 0),
  picked_qty  integer NOT NULL DEFAULT 0,
  short_qty   integer NOT NULL DEFAULT 0,
  CONSTRAINT order_lines_unique_line UNIQUE (order_id, line_no),
  CONSTRAINT order_lines_unique_sku UNIQUE (order_id, sku),
  CONSTRAINT order_lines_resolution CHECK (picked_qty >= 0 AND short_qty >= 0 AND picked_qty + short_qty <= qty)
);

CREATE TYPE reservation_status AS ENUM ('active', 'picked', 'released', 'expired');

CREATE TABLE reservations (
  id             uuid PRIMARY KEY,
  order_id       uuid NOT NULL REFERENCES orders(id),
  order_line_id  uuid NOT NULL UNIQUE REFERENCES order_lines(id),
  store_id       integer NOT NULL,
  sku            text NOT NULL,
  qty            integer NOT NULL CHECK (qty > 0),
  status         reservation_status NOT NULL DEFAULT 'active',
  expires_at     timestamptz NOT NULL,
  version        bigint NOT NULL DEFAULT 1,
  closed_reason  text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (store_id, sku) REFERENCES inventory_balances(store_id, sku)
);
CREATE INDEX reservations_active_expiry_idx ON reservations (expires_at) WHERE status = 'active';
CREATE INDEX reservations_active_balance_idx ON reservations (store_id, sku) WHERE status = 'active';
CREATE INDEX reservations_order_idx ON reservations (order_id);

-- ---------------------------------------------------------------------------------------------------
-- API idempotency, scoped to the authenticated principal.
-- Written in the SAME transaction as the order, reservations, ledger and outbox rows.
-- ---------------------------------------------------------------------------------------------------
CREATE TABLE idempotency_keys (
  principal_id     uuid NOT NULL REFERENCES users(id),
  idempotency_key  text NOT NULL CHECK (length(idempotency_key) BETWEEN 8 AND 128),
  operation        text NOT NULL,
  request_hash     text NOT NULL,
  -- 102 = in-progress placeholder; it only exists inside the creating transaction and is replaced before COMMIT.
  status_code      smallint NOT NULL CHECK (status_code BETWEEN 100 AND 599),
  response_body    jsonb NOT NULL,
  resource_id      uuid,
  created_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (principal_id, idempotency_key)
);
CREATE INDEX idempotency_keys_created_idx ON idempotency_keys (created_at);

-- ---------------------------------------------------------------------------------------------------
-- Transactional outbox. Claimed by `published_at IS NULL` — never by an id/timestamp high-watermark,
-- because ids are allocated at INSERT time, not COMMIT time (audit T6).
-- ---------------------------------------------------------------------------------------------------
CREATE TABLE outbox (
  id                 bigserial PRIMARY KEY,
  event_id           uuid NOT NULL UNIQUE,
  topic              text NOT NULL,
  partition_key      text NOT NULL,
  event_type         text NOT NULL,
  schema_version     smallint NOT NULL CHECK (schema_version > 0),
  aggregate_type     text NOT NULL,
  aggregate_id       text NOT NULL,
  aggregate_version  bigint NOT NULL,
  correlation_id     text,
  payload            jsonb NOT NULL,
  occurred_at        timestamptz NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT clock_timestamp(),
  published_at       timestamptz,
  publish_attempts   integer NOT NULL DEFAULT 0,
  last_error         text
);
CREATE INDEX outbox_unpublished_idx ON outbox (id) WHERE published_at IS NULL;
CREATE INDEX outbox_aggregate_idx ON outbox (aggregate_type, aggregate_id, aggregate_version);
