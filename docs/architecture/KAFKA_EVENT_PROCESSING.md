# Kafka event processing (Phase 2)

How AisleForge moves facts from PostgreSQL to Kafka and turns them into effects safely. Decisions are in
[ADR-003](../decisions/ADR-003-outbox-and-events.md). Measured results are in
[IMPLEMENTATION_STATUS.md](../IMPLEMENTATION_STATUS.md) and `audit/test-results/phase2/`.

## Data flow

```
API transaction ──► orders / reservations / ledger ──┐
                    outbox row (same transaction)  ──┘  commit
                              │
worker: OutboxPublisher (single leader: pg_try_advisory_lock)
        claim WHERE published_at IS NULL ORDER BY id
        send to Kafka (acks=all, idempotent producer) ──► broker ack
        then mark published_at                (crash between ack and mark ⇒ resend; consumers dedupe)
                              │
Kafka topic aisleforge.order.events (key = order id ⇒ per-order ordering)
                              │
worker: EventConsumer "order-workflow" (consumer group)
        1. decode + validate envelope and payload   ── poison ──► dead_letters row + <topic>.dlt
        2. BEGIN
             INSERT processed_events … ON CONFLICT DO NOTHING   (duplicate ⇒ stop, commit offset)
             aggregate version check                           (stale ⇒ record, no effect)
             effects (create/cancel/complete pick task)
             record aggregate version
           COMMIT
        3. commit Kafka offset (offset + 1)                    (crash before this ⇒ redelivery ⇒ step 2 skips)
```

## Topics

| Topic                             | Key          | Producer         | Consumers                                               |
| --------------------------------- | ------------ | ---------------- | ------------------------------------------------------- |
| `aisleforge.order.events`         | order id     | outbox publisher | `order-workflow` (order.placed / cancelled / picked)    |
| `aisleforge.inventory.events`     | `store:sku`  | outbox publisher | none yet (Phase 7: cache invalidation)                  |
| `aisleforge.order.events.dlt`     | original key | consumers        | operators (inspection); the DB row is the replay source |
| `aisleforge.inventory.events.dlt` | original key | consumers        | as above                                                |

The worker creates the topics at startup (`ensureTopics`, 3 partitions locally). Broker auto-creation is disabled, so
a misspelt topic fails loudly. `KAFKA_TOPIC_PREFIX` namespaces topics and consumer groups. It's empty in
production; tests use it to isolate runs on the shared local broker.

## Consumer guarantees

| Situation                                                                      | Behaviour                                                                                    |
| ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| Duplicate delivery (publisher resend, rebalance, crash before offset commit)   | `processed_events` primary key: skipped, no effect, offset committed                         |
| Older aggregate version than already applied                                   | recorded as `stale`, no effect                                                               |
| Event type the consumer does not subscribe to                                  | skipped (offset committed), not recorded                                                     |
| Unknown event type / invalid JSON / invalid envelope or payload                | dead-lettered immediately (attempts = 1)                                                     |
| Handler fails with a retriable error                                           | retried in place with full-jitter backoff, up to `CONSUMER_MAX_ATTEMPTS`; then dead-lettered |
| Handler fails permanently (`NonRetriableError`, e.g. the order does not exist) | dead-lettered after one attempt                                                              |
| Dead-lettering itself fails (DB or DLT unavailable)                            | offset NOT committed; message redelivered after a pause. Never dropped silently.             |
| Partition revoked before the offset commit                                     | commit fails (counted), message redelivered to the new owner and deduplicated                |

Ordering is per partition: `partitionsConsumedConcurrently` = number of partitions. A message being retried blocks
only its own partition, and only until it is dead-lettered.

## Dead letters and replay

- `dead_letters` holds one row per source message (consumer, topic, partition, offset), with the raw value, the
  headers, the error kind, the reason (error code, SQLSTATE and cause) and the attempt count. A copy goes to
  `<topic>.dlt` with `dlt-*` headers.
- Admin API (behind `authenticate` + `internal:status`, admin only, audited in `auth_audit_log`):

  | Method and path                                       | Effect                                                                         |
  | ----------------------------------------------------- | ------------------------------------------------------------------------------ |
  | `GET /internal/dead-letters?status=&limit=&beforeId=` | list (newest first, keyset paging)                                             |
  | `GET /internal/dead-letters/:id`                      | inspect, including the raw value (≤ 64 KiB) and headers                        |
  | `POST /internal/dead-letters/:id/replay`              | 202: `dead` or `replayed` → `replay_requested`; 409 while pending or discarded |
  | `POST /internal/dead-letters/:id/discard`             | `{ "note": "…" }` (required) → `discarded`                                     |

- The outbox-leader worker executes the requested replays. It re-publishes the original key, value and headers
  to the original topic with a `replay-of` header, and marks the row `replayed` only after the broker
  acknowledges. Replay is idempotent: an event that was in fact applied is skipped as a duplicate. A still-invalid
  message is dead-lettered again as a new row linked by `replay-of`.

## Diagnostics

- Worker HTTP (`WORKER_STATUS_PORT`, default 8081, internal only):
  - `/health/live`: process only.
  - `/health/ready`: PostgreSQL reachable, and not draining.
  - `/status`: the full snapshot described in the next bullet.
- Each worker writes the same snapshot to `worker_status` every `STATUS_SNAPSHOT_INTERVAL_MS`. It covers:
  - producer state;
  - consumer assignment and counters (applied, duplicate, stale, dead_lettered, retries);
  - per-partition lag (high watermark minus committed offset);
  - outbox leadership and backlog;
  - dead-letter counts by status;
  - the pool.

  The API's admin `/internal/status` returns all worker snapshots, with a `stale` flag when one is older than 30 s.

- Structured logs (pino JSON) carry `consumer`, `topic`, `partition`, `offset`, `eventId` and `correlationId`.

## Correlation id

The request's correlation id is stored on:

1. the order row;
2. the ledger and outbox rows;
3. the Kafka envelope and the `correlation-id` header;
4. the consumer's log context;
5. `pick_tasks.correlation_id`.

The K2 test asserts this chain for 30 orders.

## Configuration (worker)

| Variable                                                                   | Default      | Meaning                                                        |
| -------------------------------------------------------------------------- | ------------ | -------------------------------------------------------------- |
| `KAFKA_BROKERS`                                                            | (required)   | comma-separated; use `127.0.0.1:9092` on Windows hosts         |
| `KAFKA_TOPIC_PREFIX`                                                       | empty        | namespace for topics and group ids                             |
| `KAFKA_TOPIC_PARTITIONS` / `KAFKA_REPLICATION_FACTOR`                      | 3 / 1        | for topics the worker creates                                  |
| `KAFKA_DELIVERY_TIMEOUT_MS`                                                | 15000        | upper bound on waiting for a broker ack (`message.timeout.ms`) |
| `KAFKA_SESSION_TIMEOUT_MS`                                                 | 10000        | consumer-group liveness                                        |
| `OUTBOX_BATCH_SIZE` / `OUTBOX_IDLE_DELAY_MS`                               | 200 / 200    | publisher batch and idle poll                                  |
| `CONSUMER_MAX_ATTEMPTS`, `CONSUMER_RETRY_BASE_MS`, `CONSUMER_RETRY_MAX_MS` | 5, 200, 5000 | bounded retries before dead-lettering                          |
| `WORKER_ROLES`                                                             | all          | `publisher,order-workflow,sweeper,replayer`                    |
| `ROUTE_TIME_BUDGET_MS`                                                     | 250          | route planning budget per order                                |
| `SHUTDOWN_TIMEOUT_MS`                                                      | 25000        | hard deadline for graceful shutdown                            |

## Running locally

```powershell
docker compose up -d kafka                 # broker (KRaft, single node)
pnpm migrate                               # DATABASE_URL must point at PostgreSQL
$env:KAFKA_BROKERS = '127.0.0.1:9092'; pnpm start:worker
pnpm test:kafka                            # integration suite against the real broker (fails if it is down)
```
