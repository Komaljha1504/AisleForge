import type { PgPool } from '@aisleforge/database';
import { sleep, type Logger } from '@aisleforge/shared';
import type { KafkaEventProducer } from '../kafka/client';

interface ReplayRow {
  id: number;
  topic: string;
  kafka_key: string | null;
  raw_value: string | null;
  headers: Record<string, string>;
  replay_count: number;
}

/**
 * Executes replays requested by an administrator (API: POST /internal/dead-letters/:id/replay sets
 * status = 'replay_requested'). The original key, value and headers are re-published to the ORIGINAL topic with a
 * `replay-of` header; the row is marked 'replayed' only after the broker acknowledged it.
 *
 * Safety: consumers deduplicate by event id (an event that was in fact processed is skipped) and drop stale
 * aggregate versions, so replay is idempotent. A crash between ack and mark re-publishes once more — harmless for
 * the same reason. Runs only on the outbox-leader worker to avoid needless double publication.
 */
export class DeadLetterReplayer {
  replayed = 0;
  lastError: string | null = null;

  constructor(
    private readonly pool: PgPool,
    private readonly producer: KafkaEventProducer,
    private readonly logger: Logger,
  ) {}

  async replayOnce(limit = 20): Promise<number> {
    const { rows } = await this.pool.query<ReplayRow>(
      `SELECT id, topic, kafka_key, raw_value, headers, replay_count FROM dead_letters
        WHERE status = 'replay_requested' ORDER BY id LIMIT $1`,
      [limit],
    );
    let n = 0;
    for (const r of rows) {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(r.headers ?? {})) if (!k.startsWith('dlt-')) headers[k] = String(v);
      headers['replay-of'] = String(r.id);
      try {
        await this.producer.sendRaw([
          { topic: r.topic, messages: [{ key: r.kafka_key, value: r.raw_value, headers }] },
        ]);
      } catch (err) {
        this.lastError = err instanceof Error ? err.message : String(err);
        this.logger.warn({ err, deadLetterId: r.id }, 'replay publish failed; will retry');
        break;
      }
      const upd = await this.pool.query(
        `UPDATE dead_letters SET status = 'replayed', replayed_at = clock_timestamp(), replay_count = replay_count + 1
          WHERE id = $1 AND status = 'replay_requested'`,
        [r.id],
      );
      if (upd.rowCount) {
        n++;
        this.replayed++;
        this.logger.info({ deadLetterId: r.id, topic: r.topic }, 'dead letter replayed');
      }
    }
    return n;
  }

  async run(signal: AbortSignal, isLeader: () => boolean, intervalMs = 2000): Promise<void> {
    while (!signal.aborted) {
      if (isLeader())
        await this.replayOnce().catch((err: unknown) => this.logger.error({ err }, 'replay cycle'));
      await sleep(intervalMs);
    }
  }
}
