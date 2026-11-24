# ADR-003 — Transactional outbox, event envelope and consumers

**Status (2026-11-22):** the Docker Desktop and Kafka blocker is cleared. The following are implemented and tested
against a real Kafka 4.1.1 broker (KRaft): the Kafka producer adapter, the order-workflow consumer, dead letters and
replay, and the worker process. See `tests/kafka/` and `audit/test-results/phase2/`.

**Phase 2 completion conditions (engineering review, 2026-11-21).** Phase 2 stays BLOCKED until Docker Desktop
(WSL2) and a real Kafka broker (KRaft) are running. When they are, Phase 2 must deliver and verify against that real
broker:

- the Kafka producer adapter behind `EventProducer`;
- outbox publishing end to end;
- consumers with `processed_events` deduplication and offset-after-commit;
- the DLT topic + dead-letter table + replay;
- the order → pick-task workflow;
- broker failure tests (runbook E1–E3, E8).

**No simulated broker success**: no fake producer that "acks" without a broker counts toward Phase 2. The existing T6
tests use a producer interface only to test the publisher's claim/mark logic; they are not Kafka integration evidence.
Phases that depend on Phase 2 (4, 6, 7, 9) do not start before it is complete.

## Envelope (`packages/events`)

`eventId (UUIDv7) · type · schemaVersion · aggregateType · aggregateId · aggregateVersion · occurredAt ·
correlationId · payload`. Payloads are validated with Zod **at creation** (a malformed event cannot be enqueued) and
again at consumption.

| Type                                          | Topic                         | Kafka key                                  | Aggregate version source     |
| --------------------------------------------- | ----------------------------- | ------------------------------------------ | ---------------------------- |
| order.placed / order.cancelled / order.picked | `aisleforge.order.events`     | order id                                   | `orders.version`             |
| reservation.closed                            | `aisleforge.order.events`     | **order id** (same partition as its order) | `reservations.version`       |
| inventory.balance_changed                     | `aisleforge.inventory.events` | `store:sku`                                | `inventory_balances.version` |

## Write path

Events are inserted into `outbox` by the **same transaction** as the business change, after the aggregate row lock
is held. That makes outbox ids monotonic per aggregate, and consumers additionally drop stale `aggregateVersion`s.

## Publisher (`apps/worker/src/outbox/publisher.ts`)

- Claims `WHERE published_at IS NULL ORDER BY id` (partial index `outbox_unpublished_idx`). **No watermark.**
- **Single leader** via `pg_try_advisory_lock` on a dedicated session. If that session dies, leadership is dropped and re-acquired.
- Send first, then mark `published_at` only after the broker acknowledged the batch. Failures increment
  `publish_attempts` and record `last_error`; rows stay for retry with capped exponential backoff.
- No database transaction is open during the network call.
- Delivery is **at-least-once**: a crash between ack and mark republishes. Exactly-once _effects_ come from consumer
  deduplication, not from Kafka producer idempotence or transactions.

T6 (`tests/concurrency/t6-outbox.test.ts`): the late-committing lower-id event is published; the naive watermark poller
(negative control) loses it; broker failures never mark rows; exactly one leader at a time.

## Consumers (implemented in Phase 2; see docs/architecture/KAFKA_EVENT_PROCESSING.md)

`processed_events(consumer_name, event_id)` PK inserted **in the same PostgreSQL transaction** as the consumer's
effects. Offsets are committed only after that transaction commits. Poison messages get bounded retries with backoff,
then go to `<topic>.dlt` plus a `dead_letters` row with the original metadata and failure reason. Replay is explicit
and idempotent.

Decisions made during implementation (2026-11-22):

1. **Client library: `@confluentinc/kafka-javascript` 1.11 (librdkafka), not KafkaJS.**
   - KafkaJS is unmaintained, and Kafka 4.x removed the old protocol versions it relies on.
   - The Confluent client ships prebuilt Windows and Linux binaries and provides a KafkaJS-style promise API.
2. **Producer:** `acks=all` and `enable.idempotence=true`; `message.timeout.ms` bounds how long a send can wait.
   - `send` rejects the whole batch on any failure, so nothing is marked published without an acknowledgement.
   - A fatal producer error discards the producer; the next send recreates it.
3. **The dedupe row is inserted first, inside the effect transaction (`ON CONFLICT DO NOTHING`).**
   - A concurrent duplicate (zombie consumer during a rebalance) blocks on that key, then sees the conflict.
   - Inserting it last would let both copies run their effects before one rolls back.
4. **Aggregate-version check per consumer** (`consumer_aggregate_versions`).
   - An event at or below the last applied version is recorded `stale` with no effect.
   - Gaps are allowed, because not every version bump emits an event this consumer subscribes to.
5. **Dead-lettered events are not written to `processed_events`**, so a replay can still apply them.
   - I6 treats a `dead` or `discarded` dead-letter row as accounted for.
   - A `replayed` row must have a `processed_events` row (or a newer dead letter).
6. **Retriable and permanent failures are distinguished.**
   - `NonRetriableError` (e.g. the referenced order does not exist) is dead-lettered after one attempt.
   - Anything else gets `CONSUMER_MAX_ATTEMPTS` attempts. Each attempt also includes `withTransaction`'s own retries
     for deadlocks, serialization failures and lock timeouts.
   - Dead-letter reasons include the error code, SQLSTATE and cause, so an operator can decide whether to replay.
7. **Replay is executed by the worker, not the API.** The API only moves the row to `replay_requested` (conditional
   update, audited), so the API never needs a Kafka client.
8. **Worker status goes through PostgreSQL** (`worker_status` snapshots) rather than API→worker HTTP calls. This works
   with any number of replicas and survives the API not knowing worker addresses.
9. **`KAFKA_TOPIC_PREFIX`** namespaces topics and consumer groups. It's empty in production and per-file in tests,
   so test runs on the shared broker never consume each other's events.
10. **Routing in the consumer:** the route is planned in `prepare` (outside the write transaction, ≤ 250 ms).
    - A missing layout → `unplanned`.
    - An optimizer failure → S-shape `fallback`.
    - An unmeetable cold-chain policy → `infeasible` with no stops.
    - Routing never blocks task creation.
