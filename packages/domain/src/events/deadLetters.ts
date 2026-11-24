import { withTransaction, type PgPool } from '@aisleforge/database';
import { AppError } from '@aisleforge/shared';
import { auditAuth } from '../identity/audit';

export type DeadLetterStatus = 'dead' | 'replay_requested' | 'replayed' | 'discarded';

export interface DeadLetterSummary {
  id: number;
  consumerName: string;
  topic: string;
  partition: number;
  offset: number;
  eventId: string | null;
  eventType: string | null;
  correlationId: string | null;
  errorKind: string;
  errorMessage: string;
  attempts: number;
  status: DeadLetterStatus;
  createdAt: string;
  replayCount: number;
  replayedAt: string | null;
}

export interface DeadLetterDetail extends DeadLetterSummary {
  key: string | null;
  /** Original message value, as received (inspection is admin-only; bounded to 64 KiB in the response). */
  rawValue: string | null;
  headers: Record<string, string>;
  dltPublishedAt: string | null;
  resolutionNote: string | null;
}

const COLUMNS = `id, consumer_name, topic, kafka_partition, kafka_offset, event_id, event_type, correlation_id,
  error_kind, error_message, attempts, status::text AS status, created_at, replay_count, replayed_at`;

interface Row {
  id: number;
  consumer_name: string;
  topic: string;
  kafka_partition: number;
  kafka_offset: number;
  event_id: string | null;
  event_type: string | null;
  correlation_id: string | null;
  error_kind: string;
  error_message: string;
  attempts: number;
  status: DeadLetterStatus;
  created_at: Date;
  replay_count: number;
  replayed_at: Date | null;
}

const toSummary = (r: Row): DeadLetterSummary => ({
  id: r.id,
  consumerName: r.consumer_name,
  topic: r.topic,
  partition: r.kafka_partition,
  offset: r.kafka_offset,
  eventId: r.event_id,
  eventType: r.event_type,
  correlationId: r.correlation_id,
  errorKind: r.error_kind,
  errorMessage: r.error_message,
  attempts: r.attempts,
  status: r.status,
  createdAt: r.created_at.toISOString(),
  replayCount: r.replay_count,
  replayedAt: r.replayed_at?.toISOString() ?? null,
});

export async function listDeadLetters(
  pool: PgPool,
  q: { status?: DeadLetterStatus; limit: number; beforeId?: number },
): Promise<{ items: DeadLetterSummary[]; nextBeforeId: number | null }> {
  const { rows } = await pool.query<Row>(
    `SELECT ${COLUMNS} FROM dead_letters
      WHERE ($1::dead_letter_status IS NULL OR status = $1) AND ($2::bigint IS NULL OR id < $2)
      ORDER BY id DESC LIMIT $3`,
    [q.status ?? null, q.beforeId ?? null, q.limit + 1],
  );
  const items = rows.slice(0, q.limit).map(toSummary);
  return { items, nextBeforeId: rows.length > q.limit ? (items.at(-1)?.id ?? null) : null };
}

export async function getDeadLetter(pool: PgPool, id: number): Promise<DeadLetterDetail> {
  const { rows } = await pool.query<
    Row & {
      kafka_key: string | null;
      raw_value: string | null;
      headers: Record<string, string>;
      dlt_published_at: Date | null;
      resolution_note: string | null;
    }
  >(
    `SELECT ${COLUMNS}, kafka_key, left(raw_value, 65536) AS raw_value, headers, dlt_published_at, resolution_note
       FROM dead_letters WHERE id = $1`,
    [id],
  );
  const r = rows[0];
  if (!r) throw new AppError('NOT_FOUND', 'Dead letter not found');
  return {
    ...toSummary(r),
    key: r.kafka_key,
    rawValue: r.raw_value,
    headers: r.headers,
    dltPublishedAt: r.dlt_published_at?.toISOString() ?? null,
    resolutionNote: r.resolution_note,
  };
}

/**
 * Requests a replay (executed by the outbox-leader worker). Allowed from 'dead' or 'replayed' (replaying again is
 * safe: consumers deduplicate by event id and skip stale aggregate versions). Not allowed for 'discarded' or while a
 * replay is already pending.
 */
export async function requestDeadLetterReplay(
  pool: PgPool,
  id: number,
  actor: { userId: string; ip: string | null },
): Promise<DeadLetterSummary> {
  return withTransaction(pool, { label: 'dead_letters.replay' }, async (c) => {
    const { rows } = await c.query<Row>(
      `UPDATE dead_letters SET status = 'replay_requested', replay_requested_at = clock_timestamp(),
              replay_requested_by = $2
        WHERE id = $1 AND status IN ('dead', 'replayed')
        RETURNING ${COLUMNS}`,
      [id, actor.userId],
    );
    const r = rows[0];
    if (!r) {
      const cur = await c.query<{ status: string }>(
        'SELECT status::text AS status FROM dead_letters WHERE id = $1',
        [id],
      );
      if (!cur.rows[0]) throw new AppError('NOT_FOUND', 'Dead letter not found');
      throw new AppError(
        'INVALID_STATE_TRANSITION',
        `Cannot replay a dead letter in status '${cur.rows[0].status}'`,
      );
    }
    await auditAuth(c, {
      event: 'dead_letter_replay_requested',
      success: true,
      actorId: actor.userId,
      ip: actor.ip,
      detail: { deadLetterId: id, eventId: r.event_id, topic: r.topic },
    });
    return toSummary(r);
  });
}

/** Marks a dead letter as deliberately not replayed (with a mandatory note). */
export async function discardDeadLetter(
  pool: PgPool,
  id: number,
  note: string,
  actor: { userId: string; ip: string | null },
): Promise<DeadLetterSummary> {
  return withTransaction(pool, { label: 'dead_letters.discard' }, async (c) => {
    const { rows } = await c.query<Row>(
      `UPDATE dead_letters SET status = 'discarded', resolution_note = $2
        WHERE id = $1 AND status IN ('dead', 'replayed') RETURNING ${COLUMNS}`,
      [id, note],
    );
    const r = rows[0];
    if (!r) {
      const cur = await c.query('SELECT 1 FROM dead_letters WHERE id = $1', [id]);
      if (!cur.rowCount) throw new AppError('NOT_FOUND', 'Dead letter not found');
      throw new AppError('INVALID_STATE_TRANSITION', 'Only dead or replayed letters can be discarded');
    }
    await auditAuth(c, {
      event: 'dead_letter_discarded',
      success: true,
      actorId: actor.userId,
      ip: actor.ip,
      detail: { deadLetterId: id, note },
    });
    return toSummary(r);
  });
}

/** Latest snapshot of every worker (written by workers every few seconds; stale entries flagged). */
export async function workerStatuses(
  pool: PgPool,
): Promise<{ workerId: string; ageSeconds: number; stale: boolean; status: unknown }[]> {
  const { rows } = await pool.query<{ worker_id: string; age: number; status: unknown }>(
    `SELECT worker_id, extract(epoch FROM clock_timestamp() - updated_at)::float8 AS age, status
       FROM worker_status ORDER BY worker_id`,
  );
  return rows.map((r) => ({
    workerId: r.worker_id,
    ageSeconds: Math.round(r.age),
    stale: r.age > 30,
    status: r.status,
  }));
}
