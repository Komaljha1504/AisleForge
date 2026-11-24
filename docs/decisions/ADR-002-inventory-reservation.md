# ADR-002 — Inventory reservation, ledger and idempotency

**Status:** Accepted and implemented (Phase 1) · Evidence: `audit/test-results/phase1/`

## Model

- `inventory_balances(store_id, sku, on_hand, reserved, version)` with `CHECK (on_hand >= 0)` and
  `CHECK (reserved >= 0 AND reserved <= on_hand)`. These CHECKs are the last line of defence; application logic is
  designed so they never fire.
- `inventory_ledger` is **append-only** (trigger rejects UPDATE/DELETE). Each row carries `delta_on_hand` **and**
  `delta_reserved`; a per-movement CHECK fixes the sign/shape of each movement type. Every balance starts with one
  `opening` movement, so `SUM(deltas)` reproduces both counters (invariant I3).
  `UNIQUE (source_type, source_id, movement, store_id, sku)` makes replays of the same source no-ops.

| Movement         | Δ on_hand | Δ reserved | Source                                           |
| ---------------- | --------- | ---------- | ------------------------------------------------ |
| opening          | ≥ 0       | 0          | initial stock                                    |
| restock          | > 0       | 0          | goods receipt id (idempotent)                    |
| reserve          | 0         | +qty       | reservation                                      |
| release / expire | 0         | −qty       | reservation                                      |
| pick             | −picked   | −picked    | reservation                                      |
| short_pick       | −short    | −short     | reservation (triggers recount)                   |
| adjust           | ≠ 0       | 0          | adjustment id; guarded `on_hand + Δ >= reserved` |

## Reservation algorithm (`placeOrder`)

One READ COMMITTED transaction:

1. **Claim the idempotency key.** `INSERT … ON CONFLICT DO NOTHING` into `idempotency_keys(principal_id, key)`. A
   concurrent duplicate blocks on the unique index until the first commits, then replays the stored response.
   A different request hash → `422 IDEMPOTENCY_KEY_REUSED`.
2. `SAVEPOINT`.
3. **Lock balances in canonical order:** `SELECT … ORDER BY store_id, sku COLLATE "C" FOR NO KEY UPDATE`. PostgreSQL
   sorts before locking, so locks are taken in sorted order. Every multi-row balance write uses this helper
   (`lockBalancesSorted`). Application sorting uses the same byte order.
4. **Guarded conditional update** for all lines:
   `UPDATE … SET reserved = reserved + v.qty … WHERE on_hand - reserved >= v.qty`. The UPDATE decides availability.
   The locked snapshot is used only to explain failures. If fewer rows update than lines exist →
   `ROLLBACK TO SAVEPOINT` → record a **409** with per-SKU shortages (all-or-nothing).
5. Insert order, lines, reservations, ledger rows and outbox events (batched `unnest` inserts to keep lock hold time short).
6. Replace the idempotency placeholder with the final status/body. COMMIT.

No Kafka/Redis/optimizer call happens inside the transaction. SERIALIZABLE is not used on this path: the audit
measured that without retries it rejects valid orders, and with retries it adds 40001 storms. The guarded update is
correct at READ COMMITTED because a blocked UPDATE re-evaluates its WHERE clause against the committed row.

**Recorded business outcomes replay.** A 409 stored against a key is returned again for that key even after
restocking; the client must use a new key for a new attempt (same semantics as common payment APIs).

## Global lock order

`idempotency_keys` → `reservations` (by id) → `inventory_balances` (by store, sku) → `orders`.
`placeOrder`, `cancelOrder`, `confirmPick` and the expiry job all follow it, so they cannot deadlock each other.
Transient SQLSTATEs (`40P01`, `40001`, `55P03`) are retried with full-jitter backoff, at most `PG_TX_MAX_ATTEMPTS` times.
Business errors are never retried.

## Reservation state machine

`active → picked | released | expired`. Every transition is a compare-and-set
(`UPDATE … WHERE id = $1 AND status = 'active' RETURNING …`). Only the transaction that wins the CAS touches the
counters. Expiry additionally requires `expires_at <= now()`.

## Short picks

`confirmPick(pickedQty < qty)`: the whole reservation leaves `reserved`. Picked units leave `on_hand` as `pick`.
Missing units leave `on_hand` as `short_pick` (the system believed they were on the shelf; they were not). The order
line records `picked_qty`/`short_qty`. A recount (Phase 4) can restore stock through an `adjust` movement.

## Measured (Phase 1, embedded PostgreSQL 18.7, laptop)

| Test                                                     | Result                                                                                      |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| T1 last unit, 200 / 200 / 500 concurrent                 | exactly 1 / 10 / 10 orders, 0 oversell, I1–I4 PASS                                          |
| T2 100 concurrent duplicates                             | 1 order, 99 replays, 1 outbox event                                                         |
| T4 1000 orders × 5 lines, 20 hot SKUs, concurrency 100   | **0 deadlocks**, 1000/1000 committed, 119 orders/s, **p99 5.3 s** (lock convoy — see below) |
| T4 negative control (arbitrary order)                    | 55 deadlocks: the test can detect the failure                                               |
| T7 expiry vs pick, 300 races                             | exactly one winner each (226 expire / 74 pick), 0 anomalies                                 |
| Property test, 100 programs, 1020 ops, concurrent groups | invariants held after every program                                                         |

**Evidence correction (2026-11-22).** The JSON for the "119 orders/s, p99 5.3 s" run no longer exists. Later
full-suite runs overwrote `audit/test-results/phase1/T4-sorted-lock-order.json` before a fix. That fix is
`AISLEFORGE_EVIDENCE_ROOT`: re-verification runs now write to their own folder. Runs with surviving evidence:

| Run                                 | Orders/s | p50 ms | p95 ms | p99 ms | Deadlocks | Invariants | File                                                   |
| ----------------------------------- | -------- | ------ | ------ | ------ | --------- | ---------- | ------------------------------------------------------ |
| 2026-11-21 16:22 UTC (180-test run) | 80.1     | 697    | 4173   | 6258   | 0         | I1–I4 PASS | `phase1/T4-sorted-lock-order.json`                     |
| 2026-11-21 18:55 UTC (re-verify)    | 70.8     | 469    | 5535   | 8626   | 0         | I1–I4 PASS | `reverify-2026-11-22/phase1/T4-sorted-lock-order.json` |

The re-verify run ran under heavy memory paging (0.8 GB RAM available). Correctness was identical in every run. Tail
latency varies a lot (p99 5.3 to 8.6 s), which is consistent with a lock-queue convoy that is sensitive to scheduling.
Phase 6 must measure it with lock-wait instrumentation, not read it off a single run.

**Open finding (carried to Phase 6):** with 100 concurrent writers on 20 hot rows, the queue on the row locks yields
multi-second tail latency. Deadlocks are not the cause. With production `lock_timeout = 2 s` this would surface as
503s, not corruption. Options to evaluate with measurements: per-SKU admission control, smaller order-pool size,
shorter transactions.
