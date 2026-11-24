-- AisleForge global data invariants. Machine-readable: one row per invariant.
--   invariant | description | status (PASS/FAIL) | violations | sample (jsonb, up to 5 offending rows)
--
-- Run:   psql "$DATABASE_URL" -f audit/load-tests/invariants.sql
--        pnpm invariants            (same SQL, JSON output, non-zero exit on FAIL)
-- I5 threshold: SET aisleforge.outbox_threshold = '2 minutes';   (default 2 minutes)
-- I6 threshold: SET aisleforge.consumer_threshold = '2 minutes'; (events published longer ago than this must have
--               been consumed; run after recovery, when consumer lag has returned to 0)
--
-- I7: no device operation applied twice (PK (device_id, op_id)), and the applied ops' effects are consistent.

WITH params AS (
  SELECT COALESCE(NULLIF(current_setting('aisleforge.outbox_threshold', true), ''), '2 minutes')::interval AS outbox_threshold,
         COALESCE(NULLIF(current_setting('aisleforge.consumer_threshold', true), ''), '2 minutes')::interval AS consumer_threshold
),
i1 AS (
  SELECT store_id, sku, on_hand, reserved FROM inventory_balances
  WHERE on_hand < 0 OR reserved < 0 OR reserved > on_hand
),
i2 AS (
  SELECT b.store_id, b.sku, b.reserved, COALESCE(r.active_qty, 0) AS active_reservation_qty
  FROM inventory_balances b
  LEFT JOIN (SELECT store_id, sku, SUM(qty) AS active_qty FROM reservations WHERE status = 'active' GROUP BY 1, 2) r
    USING (store_id, sku)
  WHERE b.reserved <> COALESCE(r.active_qty, 0)
),
i3 AS (
  SELECT b.store_id, b.sku, b.on_hand, b.reserved,
         COALESCE(l.sum_on_hand, 0) AS ledger_on_hand, COALESCE(l.sum_reserved, 0) AS ledger_reserved,
         COALESCE(l.openings, 0) AS opening_movements
  FROM inventory_balances b
  LEFT JOIN (SELECT store_id, sku, SUM(delta_on_hand) AS sum_on_hand, SUM(delta_reserved) AS sum_reserved,
                    COUNT(*) FILTER (WHERE movement = 'opening') AS openings
             FROM inventory_ledger GROUP BY 1, 2) l USING (store_id, sku)
  WHERE b.on_hand <> COALESCE(l.sum_on_hand, 0) OR b.reserved <> COALESCE(l.sum_reserved, 0)
     OR COALESCE(l.openings, 0) <> 1
),
i4 AS (
  -- The (principal_id, idempotency_key) primary key forbids duplicate keys outright; this checks the effects:
  -- one order per key, and the key's principal owns the order it created.
  SELECT k.principal_id, k.idempotency_key, k.resource_id, o.customer_id, dup.cnt AS records_for_order
  FROM idempotency_keys k
  LEFT JOIN orders o ON o.id = k.resource_id
  LEFT JOIN (SELECT resource_id, COUNT(*) AS cnt FROM idempotency_keys WHERE resource_id IS NOT NULL GROUP BY 1) dup
    ON dup.resource_id = k.resource_id
  WHERE k.operation = 'orders.place' AND k.resource_id IS NOT NULL
    AND (o.id IS NULL OR o.customer_id <> k.principal_id OR dup.cnt > 1)
),
i5 AS (
  SELECT id, event_id, event_type, created_at, publish_attempts, last_error
  FROM outbox, params
  WHERE published_at IS NULL AND created_at < clock_timestamp() - params.outbox_threshold
),
i6 AS (
  -- (a) Every published event of a type the order-workflow consumer subscribes to was consumed: exactly one
  --     processed_events row (the primary key forbids a second), or a dead-letter record. Never silently lost.
  SELECT 'not_consumed' AS problem, o.event_id, o.event_type, o.aggregate_id
  FROM outbox o, params
  WHERE o.published_at IS NOT NULL
    AND o.published_at < clock_timestamp() - params.consumer_threshold
    AND o.event_type IN ('order.placed', 'order.cancelled', 'order.picked')
    AND NOT EXISTS (SELECT 1 FROM processed_events p
                    WHERE p.consumer_name = 'order-workflow' AND p.event_id = o.event_id)
    AND NOT EXISTS (SELECT 1 FROM dead_letters d
                    WHERE d.consumer_name = 'order-workflow' AND d.event_id = o.event_id AND d.status <> 'replayed')
  UNION ALL
  -- (b) Effects match: an order.placed applied by the consumer produced exactly one pick task for that order.
  SELECT 'applied_without_effect', p.event_id, p.event_type, o.aggregate_id
  FROM processed_events p
  JOIN outbox o ON o.event_id = p.event_id
  WHERE p.consumer_name = 'order-workflow' AND p.event_type = 'order.placed' AND p.outcome = 'applied'
    AND NOT EXISTS (SELECT 1 FROM pick_tasks t WHERE t.order_id::text = o.aggregate_id)
  UNION ALL
  -- (c) No cancelled order has a task still open or claimed (cancel applied after, never before, placement).
  SELECT 'cancelled_order_with_active_task', NULL, NULL, t.order_id::text
  FROM pick_tasks t JOIN orders ord ON ord.id = t.order_id
  WHERE ord.status = 'cancelled' AND t.status IN ('open', 'claimed')
    AND EXISTS (SELECT 1 FROM outbox o, params WHERE o.aggregate_id = t.order_id::text
                AND o.event_type = 'order.cancelled' AND o.published_at < clock_timestamp() - params.consumer_threshold)
),
i7 AS (
  -- (a) one physical pick per order line: at most one APPLIED pick.confirm per line, across all devices
  SELECT 'line_picked_twice' AS problem, s.payload->>'orderLineId' AS ref, count(*) AS n
  FROM sync_ops s WHERE s.status = 'applied' AND s.op_type = 'pick.confirm'
  GROUP BY s.payload->>'orderLineId' HAVING count(*) > 1
  UNION ALL
  -- (b) every applied pick.confirm closed its reservation as picked (the ledger movement exists, see I3)
  SELECT 'applied_pick_without_effect', s.op_id::text, 1
  FROM sync_ops s JOIN reservations r ON r.order_line_id = (s.payload->>'orderLineId')::uuid
  WHERE s.status = 'applied' AND s.op_type = 'pick.confirm' AND r.status <> 'picked'
  UNION ALL
  -- (c) a device's high-water mark covers every recorded op (ops are never applied out of order)
  SELECT 'device_seq_behind_ops', d.device_id::text, max(s.seq)
  FROM devices d JOIN sync_ops s ON s.device_id = d.device_id
  GROUP BY d.device_id, d.last_seq HAVING max(s.seq) > d.last_seq
)
SELECT 'I1' AS invariant, 'No negative on_hand; reserved within [0, on_hand]' AS description,
       CASE WHEN COUNT(*) = 0 THEN 'PASS' ELSE 'FAIL' END AS status, COUNT(*) AS violations,
       COALESCE((SELECT jsonb_agg(to_jsonb(x)) FROM (SELECT * FROM i1 LIMIT 5) x), '[]'::jsonb) AS sample
FROM i1
UNION ALL
SELECT 'I2', 'reserved = SUM(active reservation qty) per store/sku',
       CASE WHEN COUNT(*) = 0 THEN 'PASS' ELSE 'FAIL' END, COUNT(*),
       COALESCE((SELECT jsonb_agg(to_jsonb(x)) FROM (SELECT * FROM i2 LIMIT 5) x), '[]'::jsonb)
FROM i2
UNION ALL
SELECT 'I3', 'Ledger reproduces on_hand and reserved; exactly one opening movement per balance',
       CASE WHEN COUNT(*) = 0 THEN 'PASS' ELSE 'FAIL' END, COUNT(*),
       COALESCE((SELECT jsonb_agg(to_jsonb(x)) FROM (SELECT * FROM i3 LIMIT 5) x), '[]'::jsonb)
FROM i3
UNION ALL
SELECT 'I4', 'One order per (principal, idempotency key), owned by that principal',
       CASE WHEN COUNT(*) = 0 THEN 'PASS' ELSE 'FAIL' END, COUNT(*),
       COALESCE((SELECT jsonb_agg(to_jsonb(x)) FROM (SELECT * FROM i4 LIMIT 5) x), '[]'::jsonb)
FROM i4
UNION ALL
SELECT 'I5', 'No outbox event left unpublished beyond the recovery threshold',
       CASE WHEN COUNT(*) = 0 THEN 'PASS' ELSE 'FAIL' END, COUNT(*),
       COALESCE((SELECT jsonb_agg(to_jsonb(x)) FROM (SELECT * FROM i5 LIMIT 5) x), '[]'::jsonb)
FROM i5
UNION ALL
SELECT 'I6', 'Every published order event consumed exactly once (effect-wise) by order-workflow, or dead-lettered',
       CASE WHEN COUNT(*) = 0 THEN 'PASS' ELSE 'FAIL' END, COUNT(*),
       COALESCE((SELECT jsonb_agg(to_jsonb(x)) FROM (SELECT * FROM i6 LIMIT 5) x), '[]'::jsonb)
FROM i6
UNION ALL
SELECT 'I7', 'No device operation applied twice; applied picks closed their reservation; device seq covers its ops',
       CASE WHEN COUNT(*) = 0 THEN 'PASS' ELSE 'FAIL' END, COUNT(*),
       COALESCE((SELECT jsonb_agg(to_jsonb(x)) FROM (SELECT * FROM i7 LIMIT 5) x), '[]'::jsonb)
FROM i7;
