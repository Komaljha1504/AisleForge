# RetailFlow — Failure-Injection Runbook (Scenario E)

Status: **PLAN. Not executed.** No application exists yet. Run these once the Docker Compose stack
from audit §13 exists. Each experiment has a hypothesis, an injection, an invariant check and
a pass/fail rule. "It recovered" is not a result. Each test passes only if its invariants hold.

## Global invariants (checked after every experiment)

Run `audit/load-tests/invariants.sql` (to be written alongside the schema). Every query must return 0 rows.

| ID | Invariant | SQL sketch |
|----|-----------|------------|
| I1 | No negative / over-reserved stock | `SELECT * FROM inventory_balances WHERE reserved < 0 OR reserved > on_hand` |
| I2 | Reserved counter equals sum of active reservations | `SELECT b.* FROM inventory_balances b LEFT JOIN (SELECT store_id, sku, sum(qty) q FROM reservations WHERE status='active' GROUP BY 1,2) r USING (store_id, sku) WHERE b.reserved <> coalesce(r.q,0)` |
| I3 | Ledger reproduces on_hand | `... WHERE b.on_hand <> sum(ledger.delta)` |
| I4 | No duplicate order per idempotency key | enforced by UNIQUE; check `count(*) > 1 GROUP BY idempotency_key` |
| I5 | Every outbox row eventually published | `SELECT count(*) FROM outbox WHERE published_at IS NULL AND created_at < now() - interval '2 minutes'` (after recovery) |
| I6 | Every published event processed exactly once per consumer (effect-wise) | `processed_events` count per consumer = outbox count for subscribed types |
| I7 | No device op applied twice | UNIQUE `(device_id, op_id)` in `sync_ops` |

## Experiments

Run each under profile B load (`k6 run -e PROFILE=B ...`) and record start/stop timestamps.

| # | Injection (Docker Compose) | Hypothesis | Pass rule |
|---|---|---|---|
| E1 | `docker compose stop worker` for 5 min, then start | Orders still accepted. Outbox backlog grows linearly. After restart the backlog drains to 0 and consumer lag returns to 0 | I1–I7 hold. Order API error rate unchanged during outage. Drain time recorded |
| E2 | `docker compose stop kafka` for 5 min | Orders still accepted (Kafka not on write path). Publisher logs retries with backoff and no crash loop | Same as E1. Publisher does not mark rows published while Kafka is down |
| E3 | `docker compose kill -s SIGKILL worker` mid-batch, repeat 10× | Redelivery happens. `processed_events` dedupes | I6 holds. Duplicate deliveries > 0 is expected and logged |
| E4 | `docker compose stop redis` for 5 min | Reads fall through to Postgres. p95 rises but error rate stays < 1%. Login rate limit falls back to in-process | No request blocks longer than the Redis command timeout. Error rate < 1% |
| E5 | Postgres slowdown: `ALTER SYSTEM SET` nothing. Instead use `tc netem delay 50ms` on the db container, or run `pg_sleep` lock-holders | Pool wait dominates latency. Requests time out at the configured `statement_timeout`/pool timeout, not hang | No request exceeds the configured ceiling. Service recovers within 1 min of removal |
| E6 | `docker compose kill api` (one of two replicas) under load | In-flight requests on that instance fail. Clients retry with the same Idempotency-Key and get the original result | I4 holds. No duplicate orders |
| E7 | Network partition between api and db (`docker network disconnect`) for 30 s | Readiness fails, liveness does NOT (no restart storm) | Pods/containers not restarted. Recovery automatic |
| E8 | Poison message: publish a malformed event to `order.events` | Consumer retries N times, publishes to DLT, continues | Partition not stuck. DLT count = 1 |
| E9 | Offline: Chrome DevTools offline for 2 h simulated (inject 500 queued ops), close tab mid-sync, reopen | Unacked ops resent. Server dedupes | I7 holds. Every op ends `applied`, `duplicate` or `rejected` with reason. None silently lost |
| E10 | Reconnect storm: `reconnect_storm` k6 scenario at profile D | Sync endpoint saturates DB pool before CPU | Record p95 sync latency and pool wait. No 5xx from pool timeouts. 429 with Retry-After acceptable |
| E11 | Kill route-optimizer for 5 min | Worker falls back to S-shape/NN route. Tasks are not blocked | Pick tasks keep being created. Route `algorithm` field shows fallback |

## What to record per experiment

Start/stop timestamps, k6 summary JSON, `docker stats` sampled every 5 s (`docker stats --no-stream` in a loop),
outbox backlog (`SELECT count(*) WHERE published_at IS NULL`) every 5 s, consumer lag from the worker's
`/internal/status`, `pg_stat_activity` wait-event counts, and the invariant query output.
