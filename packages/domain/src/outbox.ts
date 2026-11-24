import type { PgClient } from '@aisleforge/database';
import type { OutboxEvent } from '@aisleforge/events';

/**
 * Appends events to the outbox inside the caller's transaction (one round trip for the whole batch).
 * Must be called with the same client as the business writes, so state change and event commit atomically.
 */
export async function enqueueEvents(client: PgClient, events: OutboxEvent[]): Promise<void> {
  if (events.length === 0) return;
  await client.query(
    `INSERT INTO outbox (event_id, topic, partition_key, event_type, schema_version, aggregate_type, aggregate_id,
                         aggregate_version, correlation_id, payload, occurred_at)
     SELECT * FROM unnest($1::uuid[], $2::text[], $3::text[], $4::text[], $5::smallint[], $6::text[], $7::text[],
                          $8::bigint[], $9::text[], $10::jsonb[], $11::timestamptz[])`,
    [
      events.map((e) => e.envelope.eventId),
      events.map((e) => e.topic),
      events.map((e) => e.partitionKey),
      events.map((e) => e.envelope.type),
      events.map((e) => e.envelope.schemaVersion),
      events.map((e) => e.envelope.aggregateType),
      events.map((e) => e.envelope.aggregateId),
      events.map((e) => e.envelope.aggregateVersion),
      events.map((e) => e.envelope.correlationId),
      events.map((e) => JSON.stringify(e.envelope.payload)),
      events.map((e) => e.envelope.occurredAt),
    ],
  );
}

/** Diagnostics for /internal/status (API) and the worker status endpoint. */
export async function outboxBacklog(
  db: import('@aisleforge/database').PgPool,
): Promise<{ unpublished: number; oldestAgeSeconds: number | null; maxAttempts: number }> {
  const { rows } = await db.query<{
    unpublished: number;
    oldest: number | null;
    max_attempts: number | null;
  }>(
    `SELECT count(*)::int AS unpublished,
            extract(epoch FROM clock_timestamp() - min(created_at))::float8 AS oldest,
            max(publish_attempts)::int AS max_attempts
       FROM outbox WHERE published_at IS NULL`,
  );
  const r = rows[0]!;
  return { unpublished: r.unpublished, oldestAgeSeconds: r.oldest, maxAttempts: r.max_attempts ?? 0 };
}
